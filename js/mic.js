/* ═══════════════════════════════════════════════════════════
   mic.js — the way in

   audio.js is one way out of the app; this is the way into it.
   When the line is the microphone, these are the samples the
   detector is handed: nothing is generated, nothing is known
   in advance, and a digit arrives buried in whatever else the
   room is doing. That is the point of having it.

   Blocks come off the audio thread (capture-worklet.js), are
   brought to the engine's rate if the browser would not open
   the context there, trimmed by the input gain, measured for
   the meter, and handed over.
   ═══════════════════════════════════════════════════════════ */

const MicIO = (() => {

  /* Fetched by URL, so it carries its own cache-buster — and one that must
     never drift from the page's, or a browser holding yesterday's copy runs
     it against today's app. This takes it from this file's own script tag,
     so bumping ?v= in index.html moves everything the page pulls in. */
  const V = document.currentScript ? new URL(document.currentScript.src).search : '';
  const WORKLET_URL = `js/capture-worklet.js${V}`;
  const CHUNK = 1024;          // ScriptProcessor block, fallback path only

  let ctx = null, stream = null, src = null, sink = null;
  let node = null, worklet = null;
  let filters = [];
  let resample = null;
  let hooks = {};
  let gain = 1;
  let level = 0, peak = 0, clippedAt = -1e9;
  let gen = 0;                 // invalidates an open still in flight
  const modules = new WeakSet();

  /** getUserMedia exists only in a secure context: https, or localhost. */
  const supported = () => !!(navigator.mediaDevices &&
                             navigator.mediaDevices.getUserMedia);

  /* ─────────── opening ─────────── */

  /**
   * @param {number} fs            rate the engine wants blocks at
   * @param {object} opts          { onBlock(Float32Array), onLost() }
   * @returns {Promise<{rate, requested, resampled, worklet, label, aborted?}>}
   */
  async function start(fs, opts) {
    stop();

    const mine = ++gen;
    const stale = () => mine !== gen;
    const aborted = () => ({ rate: 0, requested: fs, resampled: false,
                             worklet: false, label: '', aborted: true });

    if (!supported()) {
      throw new Error('this browser will not give a page the microphone here. ' +
                      'It needs https, or localhost');
    }
    hooks = opts || {};

    /* Everything a conferencing stack does to a voice is the wrong thing to
       do to a tone pair: the gain control rides over the very level the
       detector is measuring, noise suppression hears a steady tone as noise
       and takes it out, and echo cancellation subtracts the app's own keypad
       from what the microphone heard. Ask for none of it. */
    const want = {
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
      channelCount: 1,
    };
    stream = await navigator.mediaDevices.getUserMedia({ audio: want });
    if (stale()) { closeStream(stream); return aborted(); }

    // a device that is unplugged, or taken by another app, ends its track
    stream.getAudioTracks().forEach(t => {
      t.addEventListener('ended', () => {
        if (mine === gen && hooks.onLost) hooks.onLost();
      });
    });

    try { ctx = new AudioContext({ sampleRate: fs }); }
    catch { ctx = new AudioContext(); }
    if (ctx.state === 'suspended') await ctx.resume();
    if (stale()) return aborted();

    resample = Math.abs(ctx.sampleRate - fs) < 0.5
      ? null : AudioIO.makeResampler(ctx.sampleRate / fs);

    level = 0; peak = 0; clippedAt = -1e9;

    src = ctx.createMediaStreamSource(stream);
    let tail = src;

    /* Dropping 48 kHz to 8 by reading samples out of it folds everything
       above 4 kHz back into the band the detector is looking at — a 5 kHz
       whistle in the room would arrive as a 3 kHz one, which is a plausible
       column tone. The browser's own resampler is filtered; the one above is
       not, so when it is in the path, this is in front of it. Three poles of
       lowpass at the top of the telephone band, well clear of 1633 Hz. */
    if (resample) {
      for (let i = 0; i < 3; i++) {
        const f = ctx.createBiquadFilter();
        f.type = 'lowpass';
        f.frequency.value = 3000;
        f.Q.value = Math.SQRT1_2;
        tail.connect(f);
        filters.push(f);
        tail = f;
      }
    }

    /* Both capture paths have to reach the destination to be pulled at all,
       and neither writes anything to it: the gain is zero so that stays true
       however a browser decides to treat a silent node. */
    sink = ctx.createGain();
    sink.gain.value = 0;
    sink.connect(ctx.destination);

    const size = blockSize();
    const onWorklet = await startWorklet(tail, size, stale);
    if (stale()) return aborted();
    if (!onWorklet) startScriptProcessor(tail);

    return {
      rate: ctx.sampleRate,
      requested: fs,
      resampled: !!resample,
      worklet: onWorklet,
      label: trackLabel(),
    };
  }

  /** A block of about 32 ms, rounded to whole render quanta. */
  function blockSize() {
    const quanta = Math.max(1, Math.round(ctx.sampleRate * 0.032 / 128));
    return quanta * 128;
  }

  async function startWorklet(from, size, stale) {
    if (!ctx.audioWorklet || typeof AudioWorkletNode !== 'function') return false;
    try {
      if (!modules.has(ctx)) {
        await ctx.audioWorklet.addModule(WORKLET_URL);
        if (stale()) return false;
        modules.add(ctx);
      }
      const n = new AudioWorkletNode(ctx, 'capture', {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [1],
        processorOptions: { size },
      });
      n.port.onmessage = e => { if (e.data.block) take(e.data.block); };
      from.connect(n);
      n.connect(sink);
      worklet = n;
      return true;
    } catch {
      worklet = null;          // no worklet support, or the module would not load
      return false;
    }
  }

  function startScriptProcessor(from) {
    node = ctx.createScriptProcessor(CHUNK, 1, 1);
    node.onaudioprocess = e => {
      // the input buffer is reused between calls, so this has to be a copy
      take(Float32Array.from(e.inputBuffer.getChannelData(0)));
    };
    from.connect(node);
    node.connect(sink);
  }

  /* ─────────── each block ─────────── */

  function take(block) {
    const out = resample ? resample(block) : block;
    if (!out.length) return;
    if (gain !== 1) for (let i = 0; i < out.length; i++) out[i] *= gain;
    measure(out);
    if (hooks.onBlock) hooks.onBlock(out);
  }

  /**
   * The meter reads what the detector is about to be handed — after the gain,
   * not before it — because that is the number the thresholds in the code are
   * being compared against.
   */
  function measure(b) {
    let sum = 0, hi = 0;
    for (let i = 0; i < b.length; i++) {
      const v = b[i];
      sum += v * v;
      const a = v < 0 ? -v : v;
      if (a > hi) hi = a;
    }
    const rms = Math.sqrt(sum / b.length);
    // fast up, slow down: a meter that falls as fast as it rises is unreadable
    level = rms > level ? rms : level * 0.8 + rms * 0.2;
    peak = hi > peak ? hi : peak * 0.88;
    if (hi >= 0.999) clippedAt = performance.now();
  }

  /* ─────────── closing ─────────── */

  function closeStream(s) {
    if (s) s.getTracks().forEach(t => { try { t.stop(); } catch { /* gone */ } });
  }

  function stop() {
    gen++;                     // disown anything still opening
    if (worklet) {
      worklet.port.onmessage = null;
      try { worklet.port.postMessage({ stop: true }); } catch { /* closing */ }
      worklet.disconnect();
      worklet = null;
    }
    if (node) { node.onaudioprocess = null; node.disconnect(); node = null; }
    filters.forEach(f => f.disconnect());
    filters = [];
    if (src) { src.disconnect(); src = null; }
    if (sink) { sink.disconnect(); sink = null; }
    closeStream(stream);
    stream = null;
    if (ctx) { try { ctx.close(); } catch { /* already closed */ } }
    ctx = null;
    resample = null;
    hooks = {};
    level = 0; peak = 0;
  }

  /* ─────────── odds and ends ─────────── */

  function trackLabel() {
    const t = stream && stream.getAudioTracks()[0];
    return (t && t.label) || '';
  }

  /** Input trim, in dB. A laptop microphone across a room is a long way down
      from the level the keypad sends at. */
  function setGain(db) {
    gain = Math.pow(10, (Number.isFinite(+db) ? +db : 0) / 20);
  }

  const isOn = () => !!(node || worklet);

  const stats = () => ({
    on: isOn(),
    rate: ctx ? ctx.sampleRate : 0,
    resampled: !!resample,
    worklet: !!worklet,
    level,                                       // rms, smoothed, after gain
    peak,                                        // peak, falling slowly
    clipping: performance.now() - clippedAt < 800,
  });

  return { start, stop, isOn, stats, setGain, supported };
})();
