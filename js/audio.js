/* ═══════════════════════════════════════════════════════════
   audio.js — the speaker end of the line

   The engine hands over finished frames and this keeps the
   queue in front of the sound card non-empty. Capture is the
   other end and lives in mic.js, which borrows the resampler
   below — the same one, run the other way round.

   Trimmed from the Audio FX sandbox, which shares the worklet.
   ═══════════════════════════════════════════════════════════ */

const AudioIO = (() => {

  /* Fetched by URL, so it carries its own cache-buster — and one that must
     never drift from the page's, or a browser holding yesterday's copy runs
     it against today's app. This takes it from this file's own script tag,
     so bumping ?v= in index.html moves everything the page pulls in. */
  const V = document.currentScript ? new URL(document.currentScript.src).search : '';
  const WORKLET_URL = `js/monitor-worklet.js${V}`;
  const CHUNK = 1024;          // ScriptProcessor block, fallback path only

  let ctx = null, node = null, worklet = null;
  let queue = [], queued = 0;
  let primed = false, underruns = 0;
  let resample = null;
  let fadeIn = 0, last = 0;
  let pushed = 0, consumed = 0;    // worklet path: queued = pushed - consumed
  let prime = 0;                   // what the worklet is buffering ahead
  let gen = 0;                     // invalidates an open still in flight
  const modules = new WeakSet();   // contexts that already have the module

  const FADE = 96;             // samples of ramp used to hide an underrun

  /*
     How much audio is kept queued ahead of the speaker, and the ceiling on how
     far ahead it may run. Measured in *time*, not blocks — and this app runs at
     8 kHz, where a floor of a couple of ScriptProcessor blocks would be a
     quarter of a second of buffer, which is a quarter of a second between
     pressing a key and hearing it. 50 ms is enough for the worklet, which is
     serviced 128 samples at a time on a thread nothing else can block; the
     fallback needs its own blocks under it, and is laggy by construction.
  */
  const rate = () => (ctx ? ctx.sampleRate : 48000);
  const primeSamples = () => Math.round(Math.max(256, rate() * 0.05));
  const primeFallback = () => Math.max(2 * CHUNK, primeSamples());
  const maxSamples = () => Math.round(Math.max(4 * CHUNK, rate() * 0.4));

  /* ─────────── linear resampler ───────────

     Only used when the browser refuses to open a context at the engine's rate:
     8 kHz is a telephone rate, not a sound-card one, and playing the frames at
     the card's rate instead would move every tone by the ratio between them.

     `ratio` is input samples per output sample, so it is fs/rate going out to
     the speaker and rate/fs coming in from the microphone. Interpolating is
     enough on the way out — there is nothing above 4 kHz in what the keypad
     generates — but on the way in there is, and mic.js filters before it. */

  function makeResampler(ratio) {
    let tail = new Float32Array(0);
    let pos = 0;
    return function process(chunk) {
      const src = new Float32Array(tail.length + chunk.length);
      src.set(tail, 0);
      src.set(chunk, tail.length);

      const nOut = Math.max(0, Math.floor((src.length - 1 - pos) / ratio) + 1);
      const out = new Float32Array(nOut);
      let p = pos;
      for (let j = 0; j < nOut; j++) {
        const i = Math.floor(p), fr = p - i;
        out[j] = src[i] * (1 - fr) + src[i + 1] * fr;
        p += ratio;
      }
      const keep = Math.min(Math.floor(p), src.length);
      tail = src.slice(keep);
      pos = p - keep;
      return out;
    };
  }

  /* ─────────── opening ─────────── */

  /**
   * @param {number} fs rate of the frames that will be pushed
   * @returns {Promise<{rate, requested, resampled, worklet, aborted?}>}
   */
  async function start(fs) {
    stop();

    // Opening the output is asynchronous — resuming the context, fetching the
    // worklet module — and a stop can land in the middle of it. Anything that
    // comes back after the generation has moved on belongs to an output that
    // no longer exists, and must not attach itself to the graph.
    const mine = ++gen;
    const stale = () => mine !== gen;
    const aborted = () => ({ rate: 0, requested: fs, resampled: false,
                             worklet: false, aborted: true });

    try { ctx = new AudioContext({ sampleRate: fs }); }
    catch { ctx = new AudioContext(); }
    if (ctx.state === 'suspended') await ctx.resume();
    if (stale()) return aborted();

    resample = Math.abs(ctx.sampleRate - fs) < 0.5
      ? null : makeResampler(fs / ctx.sampleRate);

    queue = []; queued = 0; primed = false; underruns = 0;
    pushed = 0; consumed = 0; fadeIn = 0; last = 0;
    prime = primeSamples();

    const onWorklet = await startWorklet(stale);
    if (stale()) return aborted();
    if (!onWorklet) startScriptProcessor();

    return { rate: ctx.sampleRate, requested: fs,
             resampled: !!resample, worklet: onWorklet };
  }

  /** @returns {Promise<boolean>} true if playback is on the audio thread */
  async function startWorklet(stale) {
    if (!ctx.audioWorklet || typeof AudioWorkletNode !== 'function') return false;
    try {
      if (!modules.has(ctx)) {
        await ctx.audioWorklet.addModule(WORKLET_URL);
        if (stale()) return false;
        modules.add(ctx);
      }
      const n = new AudioWorkletNode(ctx, 'monitor', {
        numberOfInputs: 0,
        numberOfOutputs: 1,
        outputChannelCount: [2],
        processorOptions: { prime: primeSamples(), cap: maxSamples() },
      });
      n.port.onmessage = e => {
        consumed = e.data.consumed;
        underruns = e.data.underruns;
        prime = e.data.prime || prime;        // the worklet may have deepened it
      };
      n.connect(ctx.destination);
      worklet = n;
      return true;
    } catch {
      worklet = null;         // file://, or no worklet support — fall back
      return false;
    }
  }

  function startScriptProcessor() {
    node = ctx.createScriptProcessor(CHUNK, 1, 2);
    node.onaudioprocess = e => {
      const outL = e.outputBuffer.getChannelData(0);
      const outR = e.outputBuffer.numberOfChannels > 1
        ? e.outputBuffer.getChannelData(1) : outL;
      const n = outL.length;

      if (!primed) {
        if (queued < primeFallback()) { outL.fill(0); outR.fill(0); return; }
        primed = true;
        fadeIn = FADE;
      }

      let filled = 0;
      while (filled < n && queue.length) {
        const head = queue[0];
        const take = Math.min(head.d.length - head.off, n - filled);
        outL.set(head.d.subarray(head.off, head.off + take), filled);
        outR.set(head.d.subarray(head.off, head.off + take), filled);
        head.off += take;
        filled += take;
        queued -= take;
        if (head.off >= head.d.length) queue.shift();
      }

      if (fadeIn > 0) {
        const k = Math.min(fadeIn, filled);
        for (let i = 0; i < k; i++) {
          const w = (FADE - fadeIn + i + 1) / FADE;
          outL[i] *= w;
          outR[i] *= w;
        }
        fadeIn -= k;
      }

      if (filled < n) {
        // ran dry: ramp the last value down instead of cutting, which clicks
        const from = filled > 0 ? outL[filled - 1] : last;
        const ramp = Math.min(FADE, n - filled);
        for (let i = 0; i < ramp; i++) {
          const w = 1 - (i + 1) / ramp;
          outL[filled + i] = from * w;
          outR[filled + i] = from * w;
        }
        outL.fill(0, filled + ramp);
        outR.fill(0, filled + ramp);
        underruns++;
        primed = false;
      }
      last = outL[n - 1];
    };
    node.connect(ctx.destination);
  }

  /**
   * Queue one frame for the speakers. Takes ownership of it — the buffer is
   * handed to the audio thread rather than copied.
   */
  function push(data) {
    if (!node && !worklet) return;
    const fixed = data instanceof Float32Array ? data : Float32Array.from(data);
    const block = resample ? resample(fixed) : fixed;
    if (!block.length) return;
    pushed += block.length;

    if (worklet) {
      worklet.port.postMessage({ block }, [block.buffer]);
      return;
    }

    queue.push({ d: block, off: 0 });
    queued += block.length;
    const cap = maxSamples();
    while (queue.length > 1 && queued > cap) {
      const head = queue.shift();
      queued -= head.d.length - head.off;
    }
  }

  function stop() {
    gen++;                    // disown anything still opening
    if (worklet) {
      worklet.port.onmessage = null;
      try { worklet.port.postMessage({ stop: true }); } catch { /* closing */ }
      worklet.disconnect();
      worklet = null;
    }
    if (node) { node.onaudioprocess = null; node.disconnect(); node = null; }
    if (ctx) { try { ctx.close(); } catch { /* already closed */ } }
    ctx = null;
    resample = null;
    queue = []; queued = 0; primed = false;
    fadeIn = 0; last = 0; pushed = 0; consumed = 0;
  }

  const isOn = () => !!(node || worklet);

  // `queued` and `target` are in samples at `rate`, so the engine can work out
  // how far ahead of the speaker it is running
  const stats = () => ({
    queued: worklet ? Math.max(0, pushed - consumed) : queued,
    underruns,
    rate: ctx ? ctx.sampleRate : 0,
    target: worklet ? prime : primeFallback(),
    worklet: !!worklet,
  });

  return { start, push, stop, isOn, stats, makeResampler };
})();
