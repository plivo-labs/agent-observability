/* use-live-call.ts — live in-call experience for a real (Truman) call.
 *
 * Given a Truman run id, it:
 *   • opens the transcript WS (/api/calls/:id/stream) → streaming turns + takeover state
 *   • opens the audio WS (/api/calls/:id/audio) → dual-leg PCM playback (persona/callee)
 *     via the pcm-player AudioWorklet, exposing per-leg speaking + mute
 *   • take-mic: getUserMedia → mic-capture AudioWorklet → /api/calls/:id/takeover/audio WS
 *     plus start/stop/end-call control POSTs
 *
 * Everything tears down when the run id clears or the component unmounts.
 * Adapted from Truman apps/web (live-audio.tsx, takeover-panel.tsx). */
import { useCallback, useEffect, useRef, useState } from 'react'
import {
  audioWsUrl, endCall as endCallApi, streamWsUrl, takeoverAudioWsUrl,
  takeoverStart, takeoverStop,
} from '../simulate/sim-data'

export type LiveRole = 'agent' | 'user' | 'director'
export interface LiveTurn { role: LiveRole; text: string; ts?: number }
export type Leg = 'persona' | 'callee'

const SOURCE_RATE = 8000
const TAG_PERSONA = 0x01
const TAG_CALLEE = 0x02
const MAX_QUEUE_MS = 500
const PREBUFFER_MS = 80
const SPEAK_THRESH = 0.02

// Truman roles → AO transcript roles: assistant=persona(caller)→'user';
// user=callee(agent under test)→'agent'; director→'director'.
function mapRole(r: string): LiveRole {
  const l = (r || '').toLowerCase()
  if (l === 'assistant' || l === 'persona' || l === 'caller') return 'user'
  if (l === 'director') return 'director'
  return 'agent'
}

export interface LiveCall {
  connected: boolean
  turns: LiveTurn[]
  legs: Record<Leg, { speaking: boolean; muted: boolean }>
  toggleMute: (leg: Leg) => void
  takeoverActive: boolean
  micActive: boolean
  audioBlocked: boolean
  resumeAudio: () => void
  startMic: () => Promise<void>
  stopMic: () => Promise<void>
  endCallNow: () => Promise<void>
  ending: boolean
  error: string | null
}

export function useLiveCall(runId: string | null | undefined, enabled: boolean): LiveCall {
  const [connected, setConnected] = useState(false)
  const [turns, setTurns] = useState<LiveTurn[]>([])
  // In-progress (interim) turn for the agent-under-test: Truman streams partial
  // STT frames (final=false) while it speaks, then commits via a final frame.
  const [partial, setPartial] = useState<LiveTurn | null>(null)
  const [legs, setLegs] = useState<Record<Leg, { speaking: boolean; muted: boolean }>>({
    persona: { speaking: false, muted: false },
    callee: { speaking: false, muted: false },
  })
  const [takeoverActive, setTakeoverActive] = useState(false)
  const [micActive, setMicActive] = useState(false)
  const [audioBlocked, setAudioBlocked] = useState(false)
  const [ending, setEnding] = useState(false) // immediate UI feedback while the PSTN hangup propagates
  const [error, setError] = useState<string | null>(null)

  const streamWsRef = useRef<WebSocket | null>(null)
  const audioWsRef = useRef<WebSocket | null>(null)
  const ctxRef = useRef<AudioContext | null>(null)
  const nodesRef = useRef<Record<Leg, AudioWorkletNode> | null>(null)
  const gainsRef = useRef<Record<Leg, GainNode> | null>(null)
  const bufferedRef = useRef<Record<Leg, number>>({ persona: 0, callee: 0 })
  const peakRef = useRef<Record<Leg, number>>({ persona: 0, callee: 0 })
  // mic
  const micCtxRef = useRef<AudioContext | null>(null)
  const micStreamRef = useRef<MediaStream | null>(null)
  const micWsRef = useRef<WebSocket | null>(null)

  // Drive per-leg "speaking" from rolling audio peaks (decays toward silence).
  useEffect(() => {
    if (!enabled || !runId) return
    const iv = setInterval(() => {
      setLegs((prev) => {
        const next = { ...prev }
        ;(['persona', 'callee'] as Leg[]).forEach((leg) => {
          const speaking = peakRef.current[leg] > SPEAK_THRESH
          if (speaking !== prev[leg].speaking) next[leg] = { ...prev[leg], speaking }
          peakRef.current[leg] *= 0.6 // decay
        })
        return next
      })
    }, 120)
    return () => clearInterval(iv)
  }, [enabled, runId])

  const setMute = useCallback((leg: Leg, muted: boolean) => {
    const g = gainsRef.current?.[leg]
    if (g) g.gain.value = muted ? 0 : leg === 'persona' && takeoverActive ? 0 : 1
  }, [takeoverActive])

  const toggleMute = useCallback((leg: Leg) => {
    setLegs((prev) => {
      const muted = !prev[leg].muted
      setMute(leg, muted)
      return { ...prev, [leg]: { ...prev[leg], muted } }
    })
  }, [setMute])

  // While the director holds the mic, suppress the persona leg locally too.
  useEffect(() => {
    const g = gainsRef.current?.persona
    if (g) g.gain.value = takeoverActive || legs.persona.muted ? 0 : 1
  }, [takeoverActive, legs.persona.muted])

  const resumeAudio = useCallback(() => {
    ctxRef.current?.resume().then(() => setAudioBlocked(ctxRef.current?.state !== 'running')).catch(() => {})
  }, [])

  // Open stream + audio when a live runId is provided.
  useEffect(() => {
    if (!enabled || !runId) return
    let cancelled = false
    setTurns([]); setPartial(null); setConnected(false); setTakeoverActive(false); setError(null)

    // 1) transcript / status / takeover events
    const sws = new WebSocket(streamWsUrl(runId))
    streamWsRef.current = sws
    sws.onopen = () => { if (!cancelled) setConnected(true) }
    sws.onclose = () => { if (!cancelled) setConnected(false) }
    sws.onmessage = (ev) => {
      if (typeof ev.data !== 'string') return
      let m: any
      try { m = JSON.parse(ev.data) } catch { return }
      if (m.type === 'turn' && m.role && m.text) {
        const t: LiveTurn = { role: mapRole(m.role), text: String(m.text), ts: m.ts }
        if (m.final === false) {
          // Interim agent-under-test speech → live partial bubble, replaced each frame.
          setPartial(t)
        } else {
          // Finalized turn → commit it and clear any partial of the same role.
          setTurns((prev) => [...prev, t])
          setPartial((p) => (p && p.role === t.role ? null : p))
        }
      } else if (m.type === 'takeover') {
        setTakeoverActive(m.state === 'active')
      }
    }

    // 2) listen-in audio → pcm-player worklet (one node per leg)
    void (async () => {
      try {
        const Ctx = window.AudioContext || (window as any).webkitAudioContext
        const ctx: AudioContext = new Ctx()
        await ctx.audioWorklet.addModule('/pcm-player-worklet.js')
        if (cancelled) { ctx.close().catch(() => {}); return }
        const build = () => {
          const node = new AudioWorkletNode(ctx, 'pcm-player', {
            numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [1],
            processorOptions: { sourceRate: SOURCE_RATE, prebufferMs: PREBUFFER_MS },
          })
          const gain = ctx.createGain()
          node.connect(gain).connect(ctx.destination)
          return { node, gain }
        }
        const persona = build(); const callee = build()
        ctxRef.current = ctx
        nodesRef.current = { persona: persona.node, callee: callee.node }
        gainsRef.current = { persona: persona.gain, callee: callee.gain }
        const onBuffered = (leg: Leg) => (e: MessageEvent) => {
          const d = e.data as { type?: string; ms?: number }
          if (d?.type === 'buffered_ms' && typeof d.ms === 'number') bufferedRef.current[leg] = d.ms
        }
        persona.node.port.onmessage = onBuffered('persona')
        callee.node.port.onmessage = onBuffered('callee')
        try { await ctx.resume() } catch { /* gesture needed */ }
        setAudioBlocked(ctx.state !== 'running')

        const aws = new WebSocket(audioWsUrl(runId))
        aws.binaryType = 'arraybuffer'
        audioWsRef.current = aws
        aws.onmessage = (ev) => {
          const buf = ev.data as ArrayBuffer
          if (!buf || buf.byteLength < 3) return
          const tag = new Uint8Array(buf, 0, 1)[0]
          const leg: Leg | null = tag === TAG_PERSONA ? 'persona' : tag === TAG_CALLEE ? 'callee' : null
          if (!leg) return
          const node = nodesRef.current?.[leg]
          if (!node) return
          if (bufferedRef.current[leg] > MAX_QUEUE_MS) return // stay near live edge
          const pcm = new Int16Array(buf.slice(1))
          const samples = new Float32Array(pcm.length)
          let peak = 0
          for (let i = 0; i < pcm.length; i++) { const v = pcm[i] / 32768; samples[i] = v; const a = Math.abs(v); if (a > peak) peak = a }
          if (peak > peakRef.current[leg]) peakRef.current[leg] = peak
          node.port.postMessage({ type: 'samples', samples }, [samples.buffer])
        }
      } catch (e) {
        if (!cancelled) setError(`audio: ${(e as Error).message}`)
      }
    })()

    return () => {
      cancelled = true
      try { sws.close() } catch { /* ignore */ }
      try { audioWsRef.current?.close() } catch { /* ignore */ }
      audioWsRef.current = null; streamWsRef.current = null
      ctxRef.current?.close().catch(() => {})
      ctxRef.current = null; nodesRef.current = null; gainsRef.current = null
      bufferedRef.current = { persona: 0, callee: 0 }
    }
  }, [enabled, runId])

  const startMic = useCallback(async () => {
    if (!runId || micActive) return
    try {
      await takeoverStart(runId)
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } })
      micStreamRef.current = stream
      const Ctx = window.AudioContext || (window as any).webkitAudioContext
      const ctx: AudioContext = new Ctx()
      await ctx.audioWorklet.addModule('/mic-capture-worklet.js')
      micCtxRef.current = ctx
      const src = ctx.createMediaStreamSource(stream)
      const node = new AudioWorkletNode(ctx, 'mic-capture')
      src.connect(node)
      const mws = new WebSocket(takeoverAudioWsUrl(runId))
      mws.binaryType = 'arraybuffer'
      micWsRef.current = mws
      node.port.onmessage = (e: MessageEvent) => {
        const buf = e.data as ArrayBuffer
        if (mws.readyState === WebSocket.OPEN) { try { mws.send(buf) } catch { /* ignore */ } }
      }
      setMicActive(true); setTakeoverActive(true)
    } catch (e) {
      setError(`mic: ${(e as Error).message}`)
      try { await takeoverStop(runId) } catch { /* ignore */ }
    }
  }, [runId, micActive])

  const stopMic = useCallback(async () => {
    const id = runId
    try { micWsRef.current?.close() } catch { /* ignore */ }
    micWsRef.current = null
    micStreamRef.current?.getTracks().forEach((t) => t.stop())
    micStreamRef.current = null
    micCtxRef.current?.close().catch(() => {})
    micCtxRef.current = null
    setMicActive(false); setTakeoverActive(false)
    if (id) { try { await takeoverStop(id) } catch { /* ignore */ } }
  }, [runId])

  const endCallNow = useCallback(async () => {
    if (!runId) return
    setEnding(true) // show "Ending…" right away — the actual hangup takes a beat
    try { await endCallApi(runId) } catch (e) { setEnding(false); setError(`end: ${(e as Error).message}`) }
  }, [runId])

  // Stop the mic if the live view tears down.
  useEffect(() => {
    return () => {
      try { micWsRef.current?.close() } catch { /* ignore */ }
      micStreamRef.current?.getTracks().forEach((t) => t.stop())
      micCtxRef.current?.close().catch(() => {})
    }
  }, [])

  return {
    connected,
    // Append the live partial (if any) as a trailing bubble so the agent's reply
    // is visible while it streams; it's replaced by the committed turn on final.
    turns: partial ? [...turns, partial] : turns,
    legs, toggleMute, takeoverActive, micActive,
    audioBlocked, resumeAudio, startMic, stopMic, endCallNow, ending, error,
  }
}
