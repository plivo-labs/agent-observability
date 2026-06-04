/**
 * AudioWorkletProcessor: drains the AudioContext's native-rate mono mic
 * stream, linearly downsamples to 8 kHz, packs as 16-bit LE PCM in 20 ms
 * chunks (320 bytes = 160 samples), and posts each chunk to the main thread.
 *
 * Main thread ships the ArrayBuffers straight to the takeover WebSocket — the
 * caller bridge re-frames them and pushes into the live call.
 * Ported from Truman apps/web/public/mic-capture-worklet.js.
 */

const TARGET_RATE = 8000
const FRAME_SAMPLES = 160 // 20 ms @ 8 kHz

class MicCapture extends AudioWorkletProcessor {
  constructor() {
    super()
    this.step = sampleRate / TARGET_RATE
    this.srcPos = 0
    this.carry = new Float32Array(0)
    this.pending = []
    this.pendingLen = 0
  }

  process(inputs) {
    const input = inputs[0]
    if (!input || input.length === 0) return true
    const ch = input[0]
    if (!ch || ch.length === 0) return true

    let src
    if (this.carry.length === 0) {
      src = ch
    } else {
      src = new Float32Array(this.carry.length + ch.length)
      src.set(this.carry, 0)
      src.set(ch, this.carry.length)
    }

    const out = []
    let p = this.srcPos
    while (p < src.length - 1) {
      const i = Math.floor(p)
      const frac = p - i
      const a = src[i]
      const b = src[i + 1]
      out.push(a + (b - a) * frac)
      p += this.step
    }
    const consumed = Math.floor(p)
    if (consumed < src.length) {
      this.carry = src.slice(consumed)
      this.srcPos = p - consumed
    } else {
      this.carry = new Float32Array(0)
      this.srcPos = 0
    }

    if (out.length === 0) return true

    let i = 0
    while (i < out.length) {
      const need = FRAME_SAMPLES - this.pendingLen
      const take = Math.min(need, out.length - i)
      this.pending.push(out.slice(i, i + take))
      this.pendingLen += take
      i += take

      if (this.pendingLen >= FRAME_SAMPLES) {
        const samples = new Float32Array(FRAME_SAMPLES)
        let off = 0
        for (const buf of this.pending) {
          samples.set(buf, off)
          off += buf.length
        }
        const pcm = new Int16Array(FRAME_SAMPLES)
        for (let k = 0; k < FRAME_SAMPLES; k++) {
          let s = samples[k]
          if (s > 1) s = 1
          else if (s < -1) s = -1
          pcm[k] = (s * 32767) | 0
        }
        this.port.postMessage(pcm.buffer, [pcm.buffer])
        this.pending = []
        this.pendingLen = 0
      }
    }
    return true
  }
}

registerProcessor('mic-capture', MicCapture)
