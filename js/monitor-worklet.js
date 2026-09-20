/* ═══════════════════════════════════════════════════════════
   monitor-worklet.js — the speaker end of the live path

   This runs on the audio rendering thread. That is the whole
   point: a ScriptProcessorNode is serviced on the *main*
   thread, so the very work that produces the audio — the graph
   pass, the Python round trip, the canvases — competes with
   playing it, and every stall longer than one buffer is a gap
   no amount of queueing in front of it can cover.

   Here the main thread only has to keep a queue non-empty.
   Draining it happens 128 samples at a time on a thread
   nothing else can block.
   ═══════════════════════════════════════════════════════════ */

const FADE = 96;               // samples of ramp used to hide a gap

class MonitorProcessor extends AudioWorkletProcessor {

  constructor(options) {
    const o = (options && options.processorOptions) || {};
    super();

    // how much audio to gather before starting, and the ceiling on how far
    // ahead of the speaker the producer may run
    this.prime = Math.max(128, Math.round(o.prime || sampleRate * 0.05));
    this.cap = Math.max(this.prime * 2, Math.round(o.cap || sampleRate * 0.4));
    this.reportEvery = Math.max(128, Math.round(sampleRate / 100));   // ~10 ms

    // A gap means the producer was held up longer than the queue could cover.
    // Rather than guess one depth for every machine, start shallow — low
    // latency, which is what makes an instrument playable — and buy 20 ms more
    // each time that turns out not to be enough.
    this.grow = Math.round(sampleRate * 0.02);
    this.maxPrime = Math.round(sampleRate * 0.2);

    /*
       Entries are { l, r, off }: a left block, an optional right one, and how
       far into them we have played. A mono frame arrives with r === null and is
       written to both channels — duplicating it on the main thread would cost a
       copy and a second transfer per frame for no gain.

       The offset is carried on the entry rather than re-slicing the head, so
       two channels can never end up at different positions in the same block.
    */
    this.queue = [];
    this.queued = 0;
    this.consumed = 0;         // monotonic: the main thread paces itself off it
    this.underruns = 0;
    this.primed = false;
    this.fadeIn = 0;
    this.last = 0;
    this.since = 0;
    this.running = true;

    this.port.onmessage = e => {
      const m = e.data;
      if (m.block) {
        this.queue.push({ l: m.block, r: m.right || null, off: 0 });
        this.queued += m.block.length;
        while (this.queue.length > 1 && this.queued > this.cap) {
          const head = this.queue.shift();
          this.queued -= head.l.length - head.off;
        }
      } else if (m.reset) {
        this.queue = [];
        this.queued = 0;
        this.primed = false;
      } else if (m.stop) {
        this.running = false;
      }
    };
  }

  process(inputs, outputs) {
    const outL = outputs[0][0];
    // asking for two channels does not guarantee two, so mono hardware still works
    const outR = outputs[0][1] || outL;
    const n = outL.length;

    // wait until a little has accumulated, or every quantum underruns
    if (!this.primed) {
      if (this.queued < this.prime) {
        outL.fill(0);
        outR.fill(0);
        this.report(n);
        return this.running;
      }
      this.primed = true;
      this.fadeIn = FADE;
    }

    let filled = 0;
    while (filled < n && this.queue.length) {
      const head = this.queue[0];
      const take = Math.min(head.l.length - head.off, n - filled);
      outL.set(head.l.subarray(head.off, head.off + take), filled);
      outR.set((head.r || head.l).subarray(head.off, head.off + take), filled);
      head.off += take;
      filled += take;
      this.queued -= take;
      if (head.off >= head.l.length) this.queue.shift();
    }
    this.consumed += filled;

    // ease back in after a gap rather than restarting mid-waveform
    if (this.fadeIn > 0) {
      const k = Math.min(this.fadeIn, filled);
      for (let i = 0; i < k; i++) {
        const w = (FADE - this.fadeIn + i + 1) / FADE;
        outL[i] *= w;
        outR[i] *= w;
      }
      this.fadeIn -= k;
    }

    if (filled < n) {
      // ran dry: ramp down instead of cutting, which is what would click
      const fromL = filled > 0 ? outL[filled - 1] : this.last;
      const fromR = filled > 0 ? outR[filled - 1] : this.last;
      const ramp = Math.min(FADE, n - filled);
      for (let i = 0; i < ramp; i++) {
        const w = 1 - (i + 1) / ramp;
        outL[filled + i] = fromL * w;
        outR[filled + i] = fromR * w;
      }
      outL.fill(0, filled + ramp);
      outR.fill(0, filled + ramp);
      this.underruns++;
      this.primed = false;
      this.prime = Math.min(this.prime + this.grow, this.maxPrime);
    }

    this.last = outL[n - 1];
    this.report(n);
    return this.running;
  }

  report(n) {
    this.since += n;
    if (this.since < this.reportEvery) return;
    this.since = 0;
    this.port.postMessage({
      consumed: this.consumed, underruns: this.underruns, prime: this.prime,
    });
  }
}

registerProcessor('monitor', MonitorProcessor);
