/* ═══════════════════════════════════════════════════════════
   app.js — the engine

   One loop generates the line, frame by frame, and hands each
   frame two ways: to the speaker, and to Python in whole
   blocks. What comes back is one character per block, which is
   not yet an answer — a key held for 200 ms is forty identical
   blocks, and a digit was dialled once. The gate at the bottom
   of this file turns that stream back into presses.

        keypad ── frame ─┬─ speaker
                         ├─ FFT ─ spectrum panel
                         └─ blocks ─┐
        microphone ── blocks ───────┴─ process_block ─ chars ─ gate ─ screen

   The two sources are exclusive, and the difference between
   them is the exercise: one is a signal the app knows every
   sample of, the other is a room. The keys reach the speaker
   either way — that is how the room gets a digit to hear.

   FS and BLOCK live here rather than in a picker: they are the
   app's, the code is told what they are, and a detector written
   against 8 kHz cannot find itself being handed 44.1.
   ═══════════════════════════════════════════════════════════ */

(() => {

  const $ = id => document.getElementById(id);
  const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);

  /* 8 kHz because that is the rate DTMF was designed for: the highest tone is
     1633 Hz, so there is nothing above 4 kHz to lose. 256 samples is 32 ms,
     which puts the bins 31.3 Hz apart — comfortably finer than the 73 Hz
     between the 697 and 770 rows, the narrowest gap in the standard. */
  const FS = 8000;
  const BLOCK = 256;

  const TARGET_MS = 32;        // audio generated per pass, rounded to blocks
  const STABLE = 2;            // blocks a value must hold before it is believed

  const S = {
    running: false,            // is the detector being fed
    source: 'pad',             // 'pad' generates the line, 'mic' listens to it
    queue: [], queued: 0,      // frames waiting for Python
    dropped: 0,
    warnedDrop: false,
    lastMs: 0, lastN: 0,       // cost of the last pass, and how much it covered
    // the gate
    held: '', cand: '', candN: 0, lastChar: '',
  };

  let pumpTimer = null, idleTimer = null, audioStarting = false;
  let meterTimer = null;
  let warnedStems = false;
  let nextAt = 0;              // wall clock the next frame is due, muted path
  let warnedFeedback = false;

  const shown = c => (c ? `'${c}'` : '—');
  const line = () => ({ noise: +$('noise').value, twist: +$('twist').value });

  /* ═══════════ console ═══════════ */

  function log(kind, text) {
    const out = $('console-out');
    const el = document.createElement('div');
    el.className = `l-${kind}`;
    el.textContent = text;
    out.appendChild(el);
    while (out.childNodes.length > 200) out.removeChild(out.firstChild);
    out.scrollTop = out.scrollHeight;
  }

  /* ═══════════ the pass ═══════════ */

  /** A whole number of blocks, close to TARGET_MS of audio. */
  function frameSize() {
    const k = Math.max(1, Math.round(FS * TARGET_MS / 1000 / BLOCK));
    return k * BLOCK;
  }

  /**
   * Generate one frame and send it on its way. Runs while the detector is
   * running — silence included, because a detector only knows a key was
   * released by being handed the silence after it — and, when it is not,
   * for as long as the keypad is still making a sound.
   */
  function pump() {
    pumpTimer = null;
    const n = frameSize();
    const frameMs = n / FS * 1000;
    const frame = Keypad.frame(n, FS, line());

    // silence generated only to keep the plot alive is not worth opening
    // the speaker for
    if (!$('mute').checked && (S.running || Keypad.sounding())) {
      ensureAudio();
      AudioIO.push(frame.slice());     // push takes ownership; the copy is ours
    }
    // On the microphone the keys still reach the speaker — that is how the
    // room hears them — but what the detector is handed comes back in through
    // mic.js, so the frame stops here.
    if (S.running && !micOn()) enqueue(frame);

    // While the detector is running the plot is drawn from the block Python
    // was handed, so that the stems under it belong to that same block. When
    // nothing is running there is no such block, and this is the line.
    if (Spectrum.isOpen() && !micOn() && !S.running) {
      Spectrum.live(newest(frame), FS);
    }

    /* Keep generating while there is a reason to: the detector is being fed
       from here, a key is still sounding, or the spectrum is open and this is
       the line it is drawing. */
    const needed = (S.running && !micOn()) || Keypad.sounding() ||
                   (Spectrum.isOpen() && !micOn());
    if (!needed) { goIdle(); return; }
    pumpTimer = setTimeout(pump, nextDelay(frameMs));
  }

  /**
   * How long to wait before generating the next frame. With the speaker
   * running this follows the audio queue rather than the clock: the queue is
   * read straight after this frame was pushed, so waiting `queued - target`
   * leaves `target` still unplayed when the next one lands — enough to cover
   * timer jitter, and no more than that between the key going down and the
   * tone coming out.
   */
  function nextDelay(frameMs) {
    const st = AudioIO.stats();
    if (AudioIO.isOn() && st.rate) {
      nextAt = performance.now();      // kept fresh in case the speaker is muted
      const queuedMs = st.queued / st.rate * 1000;
      const targetMs = st.target / st.rate * 1000;
      return clamp(queuedMs - targetMs, 0, frameMs * 2);
    }
    // nothing to pace off: keep to the wall clock without drifting
    nextAt += frameMs;
    return clamp(nextAt - performance.now(), 0, frameMs * 2);
  }

  function ensurePump() {
    if (pumpTimer !== null) return;
    nextAt = performance.now();
    pumpTimer = setTimeout(pump, 0);
  }

  function stopPump() {
    if (pumpTimer !== null) { clearTimeout(pumpTimer); pumpTimer = null; }
  }

  /** Nothing left to generate: let the speaker drain, then close it. */
  function goIdle() {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      idleTimer = null;
      if (!S.running && !Keypad.sounding()) AudioIO.stop();
    }, 600);
  }

  function ensureAudio() {
    if (audioStarting || AudioIO.isOn()) return;
    if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
    audioStarting = true;
    AudioIO.start(FS)
      .then(m => {
        if (m.aborted) return;
        log('sys', `speaker on at ${FS} Hz` +
          (m.resampled ? ` (resampled to the ${Math.round(m.rate)} Hz output — ` +
                         'your function still gets it at 8 kHz)' : '') +
          (m.worklet ? '' : ' — no audio worklet, expect glitches'));
      })
      .catch(e => log('err', `audio output: ${e.message || e}`))
      .then(() => { audioStarting = false; });
  }

  /* ═══════════ where the samples come from ═══════════ */

  const micOn = () => S.source === 'mic';

  /**
   * Open the microphone unless it is already open.
   * @returns {Promise<boolean>} is it on the line now
   */
  async function ensureMic() {
    if (MicIO.isOn()) return true;
    try {
      const m = await MicIO.start(FS, { onBlock: onMicBlock, onLost: micLost });
      if (m.aborted) return MicIO.isOn();
      MicIO.setGain(+$('mic-gain').value);
      log('sys', `microphone on${m.label ? ` · ${m.label}` : ''} · ` +
        `${Math.round(m.rate)} Hz` +
        (m.resampled ? ` · filtered and resampled to ${FS} Hz here` : '') +
        (m.worklet ? '' : ' — no audio worklet, expect gaps'));
      return true;
    } catch (e) {
      log('err', `microphone: ${micWhy(e)}`);
      return false;
    }
  }

  /** getUserMedia says no in several different ways, and they mean different
      things to whoever has to fix it. */
  function micWhy(e) {
    switch (e && e.name) {
      case 'NotAllowedError':
      case 'SecurityError':
        return 'the browser refused. Allow the microphone for this page, ' +
               'then choose Mic again';
      case 'NotFoundError':
      case 'OverconstrainedError':
        return 'no input device the browser is willing to open';
      case 'NotReadableError':
        return 'the device is there, but something else has hold of it';
      default:
        return (e && e.message) || String(e);
    }
  }

  function micLost() {
    log('err', 'the microphone went away — back on the keypad.');
    MicIO.stop();
    applySource('pad');
  }

  function onMicBlock(block) {
    if (!micOn()) return;
    if (S.running) enqueue(block);
    else if (Spectrum.isOpen()) Spectrum.live(newest(block), FS);
  }

  async function setSource(next) {
    if (next === S.source) return;
    if (next === 'mic') {
      $('src-mic').disabled = true;
      const ok = await ensureMic();
      $('src-mic').disabled = false;
      if (!ok) return;                 // nothing changes; the keypad still works
    } else {
      MicIO.stop();
    }
    applySource(next);
  }

  /** Commit to a source. Whatever is queued came from the other one, and half
      a digit heard through it is not a digit. */
  function applySource(next) {
    S.source = next;
    S.queue = []; S.queued = 0;
    S.dropped = 0; S.warnedDrop = false;
    resetGate();
    Spectrum.clear();
    refreshSourceUI();
    updateKey();
    if (micOn()) startMeter();
    else { stopMeter(); if (S.running || Spectrum.isOpen()) ensurePump(); }
  }

  function refreshSourceUI() {
    const mic = micOn();
    $('src-pad').classList.toggle('on', !mic);
    $('src-mic').classList.toggle('on', mic);
    $('src-pad').setAttribute('aria-pressed', String(!mic));
    $('src-mic').setAttribute('aria-pressed', String(mic));
    $('mic-strip').hidden = !mic;

    // the generated line has a noise floor and a twist because the app puts
    // them there; the room has whatever it has, and a trim on the way in
    $('noise').disabled = mic;
    $('twist').disabled = mic;
    $('mic-gain').disabled = !mic;
    $('row-noise').classList.toggle('off', mic);
    $('row-twist').classList.toggle('off', mic);
    $('row-gain').classList.toggle('off', !mic);
  }

  /* ═══════════ the spectrum ═══════════ */

  /* The plot wants a whole block, and a power of two of them: the keypad
     hands over a frame and the microphone hands over whatever its render
     quantum and the resampler worked out to, so the last BLOCK samples off
     the line are kept here. */
  const recent = new Float32Array(BLOCK);

  function newest(b) {
    const n = Math.min(b.length, BLOCK);
    recent.copyWithin(0, n);
    recent.set(b.subarray(b.length - n), BLOCK - n);
    return recent;
  }

  /* ═══════════ the input meter ═══════════ */

  function startMeter() {
    if (meterTimer === null) meterTimer = setInterval(paintMeter, 70);
  }

  function stopMeter() {
    if (meterTimer !== null) { clearInterval(meterTimer); meterTimer = null; }
    paintMeter();
  }

  /** −60 dBFS to full scale across the bar, reading what Python is handed:
      after the input gain, which is the number the thresholds in the code are
      compared against. */
  function paintMeter() {
    const st = MicIO.stats();
    const on = micOn() && st.on;
    const db = on && st.level > 1e-6 ? 20 * Math.log10(st.level) : null;
    const pct = db === null ? 0 : clamp((db + 60) / 60, 0, 1) * 100;

    $('mic-fill').style.width = `${pct.toFixed(1)}%`;
    $('mic-read').textContent = !on ? '—'
      : (db === null || db < -60) ? 'quiet' : `${db.toFixed(0)} dBFS`;
    $('mic-meter').classList.toggle('clip', !!(on && st.clipping));
    $('mic-read').classList.toggle('clip', !!(on && st.clipping));
  }

  /* ═══════════ Python ═══════════ */

  /**
   * Frames wait here for Python rather than being dropped when it is busy: a
   * dropped frame is a digit that never arrived. Late is better than gone —
   * up to a point, which is what the cap is for.
   */
  function enqueue(frame) {
    S.queue.push(frame);
    S.queued += frame.length;

    const cap = Math.round(FS * 0.75);
    while (S.queued > cap && S.queue.length > 1) {
      const d = S.queue.shift();
      S.queued -= d.length;
      S.dropped += d.length;
      if (!S.warnedDrop) {
        S.warnedDrop = true;
        log('sys', 'the detector is behind real time — blocks are being ' +
                   'dropped. There are only 32 ms to spend on each one.');
      }
    }
    send();
  }

  /** Everything queued, in one crossing, as a whole number of blocks. */
  function send() {
    if (!S.running || !PyRunner.isReady() || PyRunner.isBusy()) return;
    const blocks = Math.floor(S.queued / BLOCK);
    if (blocks < 1) return;

    const n = blocks * BLOCK;
    const data = new Float32Array(n);
    // the buffer is transferred to the worker, so the plot needs its own copy
    let keep = null;
    let filled = 0;
    while (filled < n) {
      const head = S.queue[0];
      const need = n - filled;
      if (head.length <= need) {
        data.set(head, filled);
        filled += head.length;
        S.queue.shift();
      } else {
        data.set(head.subarray(0, need), filled);
        S.queue[0] = head.subarray(need);
        filled = n;
      }
    }
    S.queued -= n;
    if (Spectrum.isOpen()) keep = data.slice();

    PyRunner.run({ fs: FS, bufSize: BLOCK, data }).then(({ chars, stems, stemsAt, ms }) => {
      if (!S.running) return;
      S.lastMs = ms;
      S.lastN = n;
      chars.forEach(gate);
      if (keep) {
        // the block the values came from, or the last one of the batch when
        // the detector hands back no values at all
        const at = stemsAt >= 0 && stemsAt < blocks ? stemsAt : blocks - 1;
        Spectrum.paired(keep.subarray(at * BLOCK, (at + 1) * BLOCK), stems, FS);
        if (!stems) missingStems();
      }
      updateDecode();
      updateStats();
      send();                    // whatever arrived while that was in flight
    }, e => {
      log('err', e.message || String(e));
      stop();
    });
  }

  /** Said once per run: an empty stem plot is a contract that has not been
      met, not a bug in the plot. */
  function missingStems() {
    if (warnedStems) return;
    warnedStems = true;
    log('sys', 'the Goertzel plot is empty because process_block is handing ' +
               'back only the character. Return the eight values with it — ' +
               'return c, rows + cols — and they are drawn under the FFT.');
  }

  /* ═══════════ the gate ═══════════

     Your function speaks once per block; a key is pressed once. The gate is
     the difference: a value has to hold for STABLE blocks before it is
     believed, and a character is printed on the edge where it becomes held —
     never again until the line has let go of it. That is a button with its
     contact bounce taken out, which is what a key on a phone is.
  */

  function gate(c) {
    S.lastChar = c;
    if (c === S.cand) S.candN++;
    else { S.cand = c; S.candN = 1; }

    if (S.candN < STABLE || S.cand === S.held) return;
    S.held = S.cand;
    Keypad.setDetected(S.held);
    if (S.held) emit(S.held);
  }

  function resetGate() {
    S.held = ''; S.cand = ''; S.candN = 0; S.lastChar = '';
    Keypad.setDetected('');
    updateDecode();
  }

  function emit(ch) {
    const el = $('received');
    const s = document.createElement('span');
    s.className = 'ch';
    s.textContent = ch;
    el.appendChild(s);
    while (el.childNodes.length > 256) el.removeChild(el.firstChild);
    el.scrollTop = el.scrollHeight;
  }

  /* ═══════════ readouts ═══════════ */

  function updateDecode() {
    $('block-readout').textContent = S.running
      ? `block ${shown(S.lastChar)} · holding ${shown(S.held)} · ${S.candN} in a row`
      : (S.lastN ? 'stopped' : 'not decoding — press Run');
  }

  function updateKey() {
    const ch = Keypad.active();
    const el = $('key-readout');
    if (!ch) {
      el.textContent = micOn()
        ? (S.running ? 'listening to the room' : 'the line is the microphone')
        : (S.running ? 'line quiet' : 'press a key to hear it');
      return;
    }
    const p = DTMF.pair(ch);
    el.textContent = `${ch}  ·  ${p.low} + ${p.high} Hz` +
      (micOn() ? '  ·  speaker only' : '');
  }

  function updateStats() {
    const blockMs = BLOCK / FS * 1000;
    const perBlock = S.lastN ? S.lastMs / (S.lastN / BLOCK) : 0;
    const load = blockMs ? perBlock / blockMs : 0;

    const el = $('stat-run');
    el.textContent = S.lastN
      ? `${perBlock.toFixed(2)} ms per block · ${(load * 100).toFixed(0)}% of real time`
      : (S.running ? 'waiting for the first block…' : 'not run yet');
    el.classList.toggle('hot', load > 0.9);
  }

  function paramsStrip() {
    const ms = BLOCK / FS * 1000;
    $('params-strip').textContent =
      `the app sets these · FS ${FS} Hz · BLOCK ${BLOCK} samples · ` +
      `${ms.toFixed(1)} ms per call · bins ${(FS / BLOCK).toFixed(1)} Hz apart`;
  }

  function sliderReadouts() {
    $('noise-value').textContent = (+$('noise').value).toFixed(3);
    const t = +$('twist').value;
    $('twist-value').textContent = `${t > 0 ? '+' : ''}${t.toFixed(1)} dB`;
    const g = +$('mic-gain').value;
    $('mic-gain-value').textContent = `${g > 0 ? '+' : ''}${g} dB`;
  }

  /* ═══════════ run / stop ═══════════ */

  async function run() {
    if (S.running) return;
    if (!PyRunner.isReady()) { log('err', 'Python is still starting up.'); return; }

    // the source may have been picked before the device was ready, or the
    // device may have been taken away since
    if (micOn() && !MicIO.isOn()) {
      const ok = await ensureMic();
      if (!ok) { log('sys', 'back on the keypad.'); applySource('pad'); }
    }

    let taken;
    try {
      taken = await PyRunner.compile(Editor.getSource(), DTMF.pythonParams(FS, BLOCK));
    } catch (e) {
      log('err', e.message || String(e));
      return;
    }
    if (taken.length) {
      log('sys', `${taken.join(', ')} ${taken.length > 1 ? 'are' : 'is'} the app's — ` +
                 'the value the code gave it was put back before the run.');
    }

    S.running = true;
    S.queue = []; S.queued = 0;
    S.dropped = 0; S.warnedDrop = false;
    S.lastMs = 0; S.lastN = 0;
    resetGate();

    warnedStems = false;
    Spectrum.setRunning(true);
    Editor.setReadOnly(true);
    $('btn-reset-code').disabled = true;
    refreshRunUI();
    updateStats();

    if (!$('mute').checked) ensureAudio();
    if (!micOn() || Keypad.sounding()) ensurePump();

    log('sys', `running · ${micOn() ? 'the microphone' : 'the keypad'} · ` +
               `${BLOCK} samples per call at ${FS} Hz · ` +
               `${STABLE} blocks in a row to accept a key`);
  }

  function stop() {
    if (!S.running) return;
    S.running = false;
    S.queue = []; S.queued = 0;

    const st = AudioIO.stats();
    if (st.underruns) {
      log('sys', `${st.underruns} audio underrun${st.underruns > 1 ? 's' : ''} — ` +
                 'the detector is close to the deadline.');
    }
    if (S.dropped) {
      log('sys', `${Math.round(S.dropped / BLOCK)} blocks never reached Python — ` +
                 'it was behind real time.');
    }

    resetGate();
    Spectrum.setRunning(false);
    Editor.setReadOnly(false);
    $('btn-reset-code').disabled = false;
    refreshRunUI();
    updateKey();
    if (!Keypad.sounding()) { stopPump(); goIdle(); }
  }

  function refreshRunUI() {
    const ready = PyRunner.isReady();
    $('btn-run').hidden = S.running;
    $('btn-stop').hidden = !S.running;
    $('btn-run').disabled = !ready;
    const badge = $('run-state');
    badge.textContent = S.running ? 'decoding' : 'idle';
    badge.classList.toggle('on', S.running);
  }

  /* ═══════════ controls ═══════════ */

  function setupControls() {
    ['noise', 'twist'].forEach(id => $(id).addEventListener('input', sliderReadouts));

    $('btn-spectrum').addEventListener('click', () => Spectrum.toggle());

    $('src-pad').addEventListener('click', () => setSource('pad'));
    $('src-mic').addEventListener('click', () => setSource('mic'));

    $('mic-gain').addEventListener('input', () => {
      sliderReadouts();
      MicIO.setGain(+$('mic-gain').value);
    });

    $('mute').addEventListener('change', e => {
      if (e.target.checked) AudioIO.stop();
      else if (S.running || Keypad.sounding()) { ensureAudio(); ensurePump(); }
    });

    $('btn-run').addEventListener('click', run);
    $('btn-stop').addEventListener('click', stop);
    $('btn-reset-code').addEventListener('click', () => {
      Editor.reset();
      log('sys', 'the detector the app ships with is back in the editor.');
    });
    $('btn-clear-console').addEventListener('click', () => { $('console-out').textContent = ''; });

    // tapping the readout clears what has been dialled
    const screen = $('received');
    screen.title = 'click to clear';
    screen.addEventListener('click', () => { screen.textContent = ''; });
  }

  /** Said once: a microphone and a speaker in one room is a loop. */
  function feedbackHint() {
    if (warnedFeedback || !micOn() || $('mute').checked) return;
    warnedFeedback = true;
    log('sys', 'those keys are going into the room and coming back through ' +
               'the microphone. That is the point — unless it howls.');
  }

  /* ═══════════ boot ═══════════ */

  function blockedBanner(html, consoleText) {
    const b = $('app-banner');
    b.innerHTML = html;
    b.hidden = false;
    const badge = $('py-badge');
    badge.className = 'py-badge err';
    badge.textContent = 'unavailable';
    $('btn-run').disabled = true;
    log('err', consoleText);
  }

  function boot() {
    setupControls();
    Editor.init({ onRun: () => { if (!S.running) run(); } });
    Spectrum.init({
      onToggle: on => {
        const b = $('btn-spectrum');
        b.setAttribute('aria-expanded', String(on));
        b.classList.toggle('on', on);
        b.innerHTML = `Spectrum ${on ? '&#9652;' : '&#9662;'}`;
        Spectrum.setRunning(S.running);
        // nothing generates the line while the pad is idle, and a frozen plot
        // is not a plot
        if (on && !micOn()) ensurePump();
      },
    });
    Keypad.init({
      onPress: () => {
        // a pointer or key event is a gesture, which is what an AudioContext
        // needs: this is the one place the speaker may be opened from
        if (!$('mute').checked) ensureAudio();
        ensurePump();
        feedbackHint();
        updateKey();
      },
      onChange: updateKey,
    });

    if (!MicIO.supported()) {
      const b = $('src-mic');
      b.disabled = true;
      b.title = 'a page is only given the microphone over https, or on localhost';
    }

    paramsStrip();
    sliderReadouts();
    refreshSourceUI();
    paintMeter();
    updateKey();
    updateDecode();
    updateStats();
    refreshRunUI();

    if (!window.CodeMirror) {
      log('err', 'CodeMirror could not be loaded — the editor falls back to a plain text area.');
    }

    $('btn-run').disabled = true;

    // Workers and ES-module imports are both blocked on file:// URLs, so
    // Python could never start. Say so instead of hanging on "booting…".
    if (location.protocol === 'file:') {
      blockedBanner(
        '<strong>This page was opened as a file, so it cannot run.</strong> ' +
        'Browsers block Web Workers and WebAssembly on <code>file://</code> URLs. ' +
        'Double-click <code>start.cmd</code> in this folder (or run ' +
        '<code>powershell -ExecutionPolicy Bypass -File serve.ps1</code>) and use the ' +
        '<code>http://localhost:8000</code> page it opens.',
        'Opened over file:// — serve the folder over http:// instead (start.cmd).');
      return;
    }

    PyRunner.start({
      onStatus: (state, text) => {
        const b = $('py-badge');
        b.className = 'py-badge' +
          (state === 'ready' ? ' ready' : state === 'error' ? ' err' : ' busy');
        b.textContent = state === 'ready' ? 'ready' : state === 'error' ? 'error' : text;
        refreshRunUI();
        if (state !== 'ready') $('btn-run').disabled = true;
      },
      onOutput: (kind, text) => log(kind, text),
    });

    log('sys', 'Press a key to hear it. Press Run ▸ and the code on the left ' +
               'decodes what you dial — or put the line on Mic and let it ' +
               'decode what the room is doing.');
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();

})();
