/* ═══════════════════════════════════════════════════════════
   capture-worklet.js — the microphone end of the live path

   The mirror of monitor-worklet.js. That one drains a queue on
   the audio rendering thread so playback never waits for the
   main thread; this one fills one, for the same reason: the
   samples arrive 128 at a time on a thread that a Python round
   trip or a long paint cannot stall, and the main thread only
   has to pick them up.

   It gathers whole blocks before posting, so the engine gets
   one message per block it is going to analyse rather than one
   per render quantum.
   ═══════════════════════════════════════════════════════════ */

class CaptureProcessor extends AudioWorkletProcessor {

  constructor(options) {
    const o = (options && options.processorOptions) || {};
    super();

    this.size = Math.max(128, Math.round(o.size || 256));
    this.buf = new Float32Array(this.size);
    this.n = 0;
    this.stopped = false;

    this.port.onmessage = e => {
      if (e.data && e.data.stop) this.stopped = true;
    };
  }

  process(inputs) {
    if (this.stopped) return false;

    const ch = inputs[0] && inputs[0][0];

    /* A device that hands over no channel — muted, still opening, gone — has
       to keep the clock running anyway: a detector only learns that a digit
       ended by being handed the silence after it, so send the silence. */
    const n = ch ? ch.length : 128;

    for (let i = 0; i < n; i++) {
      this.buf[this.n++] = ch ? ch[i] : 0;
      if (this.n === this.size) {
        this.port.postMessage({ block: this.buf }, [this.buf.buffer]);
        this.buf = new Float32Array(this.size);
        this.n = 0;
      }
    }
    return true;
  }
}

registerProcessor('capture', CaptureProcessor);
