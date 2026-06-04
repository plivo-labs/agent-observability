/**
 * AudioWorkletProcessor: continuous PCM playback at the worklet's sample rate.
 * Receives Float32Array chunks via the MessagePort, holds a small jitter
 * buffer, then drains them sample-by-sample into the audio output. Linear
 * interpolation handles the source-rate vs context-rate mismatch.
 *
 * Each instance plays a single channel; the page creates two (persona,
 * callee) and routes them through their own GainNodes for per-leg mute.
 * Ported from Truman apps/web/public/pcm-player-worklet.js.
 */

class PcmPlayer extends AudioWorkletProcessor {
  constructor(options) {
    super()
    this.queue = [] // Array<Float32Array>, pending source samples at sourceRate.
    this.sourceRate = options.processorOptions?.sourceRate ?? 8000
    this.prebufferMs = options.processorOptions?.prebufferMs ?? 80
    this.prebufferSamples = Math.max(2, Math.round((this.sourceRate * this.prebufferMs) / 1000))
    this.srcPos = 0
    this.step = this.sourceRate / sampleRate
    this.playing = false
    this.reportTick = 0

    this.port.onmessage = (e) => {
      const msg = e.data
      if (!msg) return
      if (msg.type === 'samples' && msg.samples) {
        this.queue.push(msg.samples)
      } else if (msg.type === 'clear') {
        this._reset(true)
      }
    }
  }

  _reset(clearQueue) {
    if (clearQueue) this.queue = []
    this.srcPos = 0
    this.playing = false
  }

  _bufferedSamples() {
    let pending = 0
    for (let i = 0; i < this.queue.length; i++) pending += this.queue[i].length
    pending -= Math.floor(this.srcPos)
    return pending > 0 ? pending : 0
  }

  _sampleAt(offset) {
    let idx = offset
    for (let i = 0; i < this.queue.length; i++) {
      const chunk = this.queue[i]
      if (idx < chunk.length) return chunk[idx]
      idx -= chunk.length
    }
    return null
  }

  _readInterpolated() {
    const idx = Math.floor(this.srcPos)
    const frac = this.srcPos - idx
    const a = this._sampleAt(idx)
    if (a === null) return null
    const b = this._sampleAt(idx + 1)
    if (b === null) return a
    return a + (b - a) * frac
  }

  _advance() {
    this.srcPos += this.step
    while (this.queue.length > 0 && this.srcPos >= this.queue[0].length) {
      this.srcPos -= this.queue[0].length
      this.queue.shift()
    }
  }

  _reportBuffered() {
    const ms = (this._bufferedSamples() / this.sourceRate) * 1000
    this.reportTick = (this.reportTick + 1) % 10
    if (this.reportTick === 0) {
      this.port.postMessage({ type: 'buffered_ms', ms })
    }
  }

  process(_inputs, outputs) {
    const out = outputs[0][0]
    if (!out) return true

    for (let i = 0; i < out.length; i++) {
      if (!this.playing) {
        if (this._bufferedSamples() < this.prebufferSamples) {
          out[i] = 0
          continue
        }
        this.playing = true
      }

      if (this._bufferedSamples() < 2) {
        this._reset(true)
        out[i] = 0
        continue
      }

      const sample = this._readInterpolated()
      if (sample === null) {
        this._reset(true)
        out[i] = 0
        continue
      }
      out[i] = sample
      this._advance()
    }

    this._reportBuffered()
    return true
  }
}

registerProcessor('pcm-player', PcmPlayer)
