/* ═══════════════════════════════════════════════════════════
   keypad.js — the telephone, and the signal it puts on the line

   The pad draws itself from the DTMF table, with the row and
   column frequencies printed along the edges of the shell the
   way a service legend is printed on a phone: pressing 5 and
   reading 770 + 1336 off the margins is the whole of what a
   key *is*.

   A phone is monophonic — one digit at a time — so a new key
   takes the line over and the one it displaced is released,
   even if the finger is still on it. Rolling off 4 onto 5 sends
   4 then 5, never a chord no detector was written for.

   Voices live across frames: each carries its two phases and
   its envelope, which is what lets a key be held indefinitely
   without a discontinuity at every frame boundary.
   ═══════════════════════════════════════════════════════════ */

const Keypad = (() => {

  const TAU = 2 * Math.PI;

  /* Amplitude of each of the two tones. Fixed, and not a control: the level
     a line delivers is not something a detector may lean on. Noise and twist
     are the knobs, because those are the two things that actually vary. */
  const LEVEL = 0.3;

  // a few ms of ramp: enough that the speaker does not pop, short enough that
  // the tone still starts when the key goes down
  const ATTACK = 0.004, RELEASE = 0.010;

  /* The shortest tone a press may send, however fast the tap. Q.23 asks for
     40 ms and real dialers send about 100; this is 110 because the app's own
     blocks are 32 ms and the gate wants two in a row that agree, so anything
     under ~100 ms can be dialled and never decoded — which looks like a bug
     in the detector when it is really a burst too short to measure. */
  const MIN_TONE_MS = 110;

  let el = null;            // the #keypad element
  let voices = [];          // at most one open, plus whatever is still fading
  let downKeys = [];        // physically held, oldest first
  let pointerKey = null;    // the key the mouse/finger is on, if any
  let detected = '';        // what the detector says, for the paint
  const hooks = { onPress: () => {}, onChange: () => {} };

  const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);
  const num = (v, d) => (Number.isFinite(+v) ? +v : d);

  /* ═══════════ the pad ═══════════ */

  function build() {
    if (!el) return;
    el.textContent = '';
    const cols = DTMF.PAD_COLS;
    const grid = document.createElement('div');
    grid.className = 'pad';
    grid.style.setProperty('--cols', String(cols));

    // column frequencies across the top, row frequencies down the left
    grid.appendChild(tag('div', 'pad-corner', 'Hz'));
    for (let c = 0; c < cols; c++) {
      grid.appendChild(tag('div', 'pad-freq col', String(DTMF.COL_HZ[c])));
    }
    DTMF.KEYS.forEach((row, r) => {
      grid.appendChild(tag('div', 'pad-freq row', String(DTMF.ROW_HZ[r])));
      for (let c = 0; c < cols; c++) grid.appendChild(keyButton(row[c]));
    });

    el.appendChild(grid);
    paint();
  }

  function tag(name, cls, text) {
    const d = document.createElement(name);
    d.className = cls;
    if (text !== undefined) d.textContent = text;
    return d;
  }

  function keyButton(ch) {
    const p = DTMF.pair(ch);
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'key';
    b.dataset.key = ch;
    b.title = `${ch} — ${p.low} + ${p.high} Hz`;
    // a button in a form-less page still takes focus on click, and a focused
    // button eats the space bar; nothing here wants keyboard focus
    b.tabIndex = -1;

    b.appendChild(tag('span', 'glyph', ch));
    b.appendChild(tag('span', 'sub', DTMF.LETTERS[ch] || ''));
    b.appendChild(tag('span', 'led'));

    b.addEventListener('pointerdown', e => {
      e.preventDefault();
      // capture, so a finger that slides off the key still ends its press here
      try { b.setPointerCapture(e.pointerId); } catch { /* not captureable */ }
      pointerKey = ch;
      press(ch);
    });
    const up = () => { if (pointerKey === ch) { pointerKey = null; release(ch); } };
    b.addEventListener('pointerup', up);
    b.addEventListener('pointercancel', up);
    return b;
  }

  function paint() {
    if (!el) return;
    const live = open();
    el.querySelectorAll('.key').forEach(b => {
      const ch = b.dataset.key;
      b.classList.toggle('on', !!live && live.ch === ch);
      b.classList.toggle('got', detected === ch);
    });
    hooks.onChange();
  }

  /* ═══════════ presses ═══════════ */

  const open = () => voices.find(v => !v.releasing && !v.pendingRelease) || null;

  /** The character being sent right now, '' when the line is quiet. */
  const active = () => (open() ? open().ch : '');

  function press(ch) {
    if (!DTMF.onPad(ch)) return;
    const i = downKeys.indexOf(ch);
    if (i >= 0) downKeys.splice(i, 1);
    downKeys.push(ch);
    hooks.onPress(ch);
    takeLine(ch);
  }

  function release(ch) {
    const i = downKeys.indexOf(ch);
    if (i >= 0) downKeys.splice(i, 1);
    const v = open();
    if (!v || v.ch !== ch) { paint(); return; }
    // hand the line back to whatever is still held underneath, if anything
    letGo(v);
    if (downKeys.length) takeLine(downKeys[downKeys.length - 1]);
    else paint();
  }

  function allOff() {
    downKeys = [];
    pointerKey = null;
    const v = open();
    if (v) letGo(v);
    paint();
  }

  /** Start `ch`, releasing whatever held the line before it. */
  function takeLine(ch) {
    const v = open();
    if (v) {
      if (v.ch === ch) return;
      letGo(v);
    }
    const p = DTMF.pair(ch);
    voices.push({
      ch, low: p.low, high: p.high,
      phL: 0, phH: 0, env: 0,
      releasing: false, pendingRelease: false,
      started: false,                 // still waiting for its offset in the frame
      held: 0,                        // samples rendered with the gate open
      downAt: performance.now(),
      wantMs: 0,                      // how long the key was actually held
    });
    paint();
  }

  function letGo(v) {
    if (v.pendingRelease || v.releasing) return;
    v.pendingRelease = true;
    v.wantMs = Math.max(MIN_TONE_MS, performance.now() - v.downAt);
  }

  /* ═══════════ the PC keyboard ═══════════ */

  /** True when a keypress should reach the pad rather than the editor. */
  function keyboardIsFree() {
    const a = document.activeElement;
    if (a && (/^(INPUT|SELECT|TEXTAREA)$/.test(a.tagName) || a.isContentEditable)) return false;
    return true;
  }

  function onKey(e) {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const ch = DTMF.fromEvent(e);
    if (!ch) return;

    // Releases are never filtered: the editor may have taken focus while the
    // key was down — the tone still has to stop.
    if (e.type === 'keyup') { release(ch); return; }
    if (!keyboardIsFree()) return;
    e.preventDefault();
    if (!e.repeat) press(ch);
  }

  /* ═══════════ the signal ═══════════ */

  /**
   * One frame of the line: the tone pair of whatever is held, plus noise.
   *
   * @param {number} n      samples
   * @param {number} fs
   * @param {object} line   { noise, twist } — twist in dB, high over low
   * @returns {Float32Array}
   */
  function frame(n, fs, line) {
    const out = new Float32Array(n);
    const noise = clamp(num(line.noise, 0), 0, 1);
    const g = Math.pow(10, clamp(num(line.twist, 0), -24, 24) / 20);
    const aLow = LEVEL;
    const aHigh = LEVEL * g;

    const up = 1 / Math.max(1, Math.round(ATTACK * fs));
    const down = 1 / Math.max(1, Math.round(RELEASE * fs));

    /* This frame stands for the stretch of wall clock that has just gone by,
       so a key pressed part way through it starts part way through the buffer
       instead of jumping to the boundary — two digits dialled 90 ms apart stay
       90 ms apart even when both land in the same frame. */
    const spanMs = (n / fs) * 1000;
    const startWall = performance.now() - spanMs;

    for (const v of voices) {
      const dL = TAU * v.low / fs;
      const dH = TAU * v.high / fs;

      let begin = 0;
      if (!v.started) {
        begin = clamp(Math.round((v.downAt - startWall) * fs / 1000), 0, n);
        if (begin >= n) continue;          // pressed after this frame's window
        v.started = true;
      }
      /* A released key stays open for as long as it was actually held, so a
         tap shorter than one frame is still sent in full. Capped at one extra
         frame: if generation falls behind the clock, digits should arrive late
         rather than stretch. */
      const wantHeld = v.pendingRelease
        ? Math.min(Math.round(v.wantMs * fs / 1000), v.held + n)
        : Infinity;

      for (let i = begin; i < n; i++) {
        if (!v.releasing && v.held >= wantHeld) v.releasing = true;

        if (v.releasing) {
          v.env -= down;
          if (v.env <= 0) { v.env = 0; break; }
        } else {
          v.held++;
          if (v.env < 1) v.env = Math.min(1, v.env + up);
        }
        out[i] += v.env * (aLow * Math.sin(v.phL) + aHigh * Math.sin(v.phH));
        v.phL += dL;
        v.phH += dH;
      }
      v.phL %= TAU;
      v.phH %= TAU;
    }

    const before = voices.length;
    voices = voices.filter(v => !(v.releasing && v.env <= 0));
    if (voices.length !== before) paint();

    if (noise > 0) {
      for (let i = 0; i < n; i++) out[i] += (Math.random() * 2 - 1) * noise;
    }
    return out;
  }

  /** Is anything still sounding — a held key, or a tail still fading out? */
  const sounding = () => voices.length > 0;

  /* ═══════════ public ═══════════ */

  function init(opts) {
    el = document.getElementById('keypad');
    Object.assign(hooks, opts || {});
    build();
    window.addEventListener('keydown', onKey);
    window.addEventListener('keyup', onKey);
    // a key held while the page loses focus would otherwise never come up
    window.addEventListener('blur', allOff);
  }

  /** Light the key the detector says it is hearing, which need not be the one
      being pressed — that difference is the point of the lamp. */
  function setDetected(ch) {
    if (detected === ch) return;
    detected = ch || '';
    paint();
  }

  return { init, setDetected, frame, active, sounding, allOff, LEVEL };
})();
