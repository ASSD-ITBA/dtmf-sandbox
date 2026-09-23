/* ═══════════════════════════════════════════════════════════
   spectrum.js — what the block looked like, and what your
   function made of it

   Two plots, one above the other, sharing an x axis so that a
   peak in the top one is directly above the stem that is
   supposed to be measuring it.

     top     the FFT of the block, in dBFS. The app computes
             this; the detector neither needs nor sees it.
     bottom  the eight Goertzel values your process_block
             returned, in dB below the strongest of the eight.

   Every scale here is fixed. An axis that rescales itself is
   worse than useless for this: the whole question is whether
   the two tones stand clear of the other six, and an axis that
   grows to fit whatever it is given answers "yes" to that
   question on pure noise.

     x    500 – 1800 Hz, which is the standard plus margin
     y    0 to −80 dBFS on the spectrum
          0 to −40 dB, relative to the strongest, on the stems

   The stems are read as powers — |X|², which is what a
   Goertzel gives you — so the dB are 10·log₁₀.
   ═══════════════════════════════════════════════════════════ */

const Spectrum = (() => {

  /* ─────────── the fixed frame ─────────── */

  const F_LO = 500, F_HI = 1800;          // Hz, both plots
  const FFT_LO = -80, FFT_HI = 0;         // dBFS
  const FFT_STEP = 20;
  const REL_LO = -40, REL_HI = 0;         // dB below the strongest stem
  const REL_STEP = 10;

  // identical left and right gutters are what keeps the two plots aligned
  const PAD = { l: 30, r: 10, t: 8 };
  const B_PLAIN = 8;                      // bottom gutter, no labels
  const B_AXIS = 30;                      // bottom gutter, two rows of labels

  const CSS = { fft: 118, stem: 134 };    // canvas heights, CSS pixels

  const COL = {
    grid: '#182135',
    frame: '#22304a',
    guide: 'rgba(79, 195, 247, 0.10)',
    tick: '#55627a',
    trace: '#4fc3f7',
    under: 'rgba(79, 195, 247, 0.16)',
    row: '#7bd88f',
    col: '#ffb454',
    dim: '#3b4a63',
    faint: '#55627a',
  };

  /* ─────────── state ─────────── */

  let els = null;
  let open = false;
  let raf = null, dirty = true;
  let running = false;
  const hooks = {};

  const view = {
    db: null,        // Float32Array of bins, dBFS
    fs: 8000,
    n: 256,
    stems: null,     // 8 numbers, ROW_HZ then COL_HZ
    peak: 0,         // the largest of them, in its own units
    peakHz: 0,
    fromRun: false,  // is the block the one the detector was handed
  };

  /* ─────────── public ─────────── */

  function init(opts) {
    Object.assign(hooks, opts || {});
    els = {
      block: document.getElementById('spectrum-block'),
      panel: document.getElementById('pad-panel'),
      fft: document.getElementById('fft-canvas'),
      stem: document.getElementById('stem-canvas'),
      fftNote: document.getElementById('fft-note'),
      stemNote: document.getElementById('stem-note'),
    };
    if (!els.fft) { els = null; return; }
    window.addEventListener('resize', () => { dirty = true; });
    paint();
  }

  const isOpen = () => open;

  function setOpen(on) {
    if (!els || on === open) return open;
    open = on;
    els.block.hidden = !on;
    // with the plots up, the panel shows the keys and the source switch and
    // nothing else, so the whole column fits without scrolling
    els.panel.classList.toggle('spectrum-open', on);
    dirty = true;
    if (on) loop(); else stopLoop();
    if (hooks.onToggle) hooks.onToggle(on);
    return open;
  }

  const toggle = () => setOpen(!open);

  /**
   * The newest samples off the line, when nothing is being decoded. The
   * spectrum is the app's own; the stems are not touched.
   */
  function live(block, fs) {
    if (!open || !block || !block.length) return;
    take(block, fs, false);
    dirty = true;
  }

  /**
   * A block the detector was handed, and the eight values it gave back for
   * that same block — so the stem under a peak is the one that measured it.
   */
  function paired(block, stems, fs) {
    if (!open) return;
    if (block && block.length) take(block, fs, true);
    setStems(stems);
  }

  function setStems(stems) {
    view.stems = (stems && stems.length === 8) ? Array.from(stems, Number) : null;
    view.peak = 0;
    view.peakHz = 0;
    if (view.stems) {
      const hz = DTMF.ROW_HZ.concat(DTMF.COL_HZ);
      view.stems.forEach((v, i) => {
        if (Number.isFinite(v) && v > view.peak) { view.peak = v; view.peakHz = hz[i]; }
      });
    }
    dirty = true;
  }

  function clear() {
    view.db = null;
    view.stems = null;
    view.peak = 0;
    view.fromRun = false;
    dirty = true;
  }

  /* ─────────── the data ─────────── */

  function take(block, fs, fromRun) {
    const n = block.length;
    // the engine only ever hands over whole blocks, and BLOCK is a power of
    // two; anything else is not worth a slow path
    if (n & (n - 1)) return;
    try { view.db = FFT.magnitudesDb(block); }
    catch { return; }
    view.n = n;
    view.fs = fs || view.fs;
    view.fromRun = fromRun;
  }

  /* ─────────── drawing ─────────── */

  function loop() {
    if (raf !== null) return;
    const step = () => {
      raf = requestAnimationFrame(step);
      if (dirty) { dirty = false; paint(); }
    };
    raf = requestAnimationFrame(step);
  }

  function stopLoop() {
    if (raf !== null) { cancelAnimationFrame(raf); raf = null; }
  }

  /** Size the backing store to the device, and hand back a plot box. */
  function surface(canvas, cssH, bottom) {
    const dpr = window.devicePixelRatio || 1;
    const cssW = canvas.clientWidth || 340;
    const w = Math.round(cssW * dpr), h = Math.round(cssH * dpr);
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
      canvas.style.height = `${cssH}px`;
    }
    const g = canvas.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, cssW, cssH);
    return {
      g,
      x0: PAD.l,
      y0: PAD.t,
      w: Math.max(10, cssW - PAD.l - PAD.r),
      h: Math.max(10, cssH - PAD.t - bottom),
    };
  }

  const xOf = (box, hz) => box.x0 + (hz - F_LO) / (F_HI - F_LO) * box.w;

  function yOf(box, db, lo, hi) {
    const t = (db - lo) / (hi - lo);
    return box.y0 + (1 - Math.min(1, Math.max(0, t))) * box.h;
  }

  function frame(box, lo, hi, step, suffix) {
    const { g } = box;
    g.fillStyle = '#05080f';
    g.fillRect(box.x0, box.y0, box.w, box.h);

    // the eight frequencies, marked on both plots
    g.fillStyle = COL.guide;
    DTMF.ROW_HZ.concat(DTMF.COL_HZ).forEach(hz => {
      if (hz < F_LO || hz > F_HI) return;
      g.fillRect(xOf(box, hz) - 1, box.y0, 2, box.h);
    });

    g.strokeStyle = COL.grid;
    g.lineWidth = 1;
    g.font = '8px ui-monospace, monospace';
    g.fillStyle = COL.tick;
    g.textAlign = 'right';
    g.textBaseline = 'middle';
    for (let db = lo; db <= hi; db += step) {
      const y = Math.round(yOf(box, db, lo, hi)) + 0.5;
      g.beginPath();
      g.moveTo(box.x0, y);
      g.lineTo(box.x0 + box.w, y);
      g.stroke();
      g.fillText(db === 0 ? `0${suffix}` : String(db), box.x0 - 4, y);
    }

    g.strokeStyle = COL.frame;
    g.strokeRect(box.x0 + 0.5, box.y0 + 0.5, box.w - 1, box.h - 1);
  }

  function paint() {
    if (!els) return;
    drawFft(surface(els.fft, CSS.fft, B_PLAIN));
    drawStems(surface(els.stem, CSS.stem, B_AXIS));
    captions();
  }

  function drawFft(box) {
    const { g } = box;
    frame(box, FFT_LO, FFT_HI, FFT_STEP, '');

    if (!view.db) {
      note(box, 'no block yet');
      return;
    }

    const df = view.fs / view.n;
    const kLo = Math.max(0, Math.floor(F_LO / df) - 1);
    const kHi = Math.min(view.db.length - 1, Math.ceil(F_HI / df) + 1);

    g.save();
    g.beginPath();
    g.rect(box.x0, box.y0, box.w, box.h);
    g.clip();

    g.beginPath();
    for (let k = kLo; k <= kHi; k++) {
      const x = xOf(box, k * df);
      const y = yOf(box, view.db[k], FFT_LO, FFT_HI);
      if (k === kLo) g.moveTo(x, y); else g.lineTo(x, y);
    }
    // the same line again, closed along the floor, for the fill
    g.lineTo(xOf(box, kHi * df), box.y0 + box.h);
    g.lineTo(xOf(box, kLo * df), box.y0 + box.h);
    g.closePath();
    g.fillStyle = COL.under;
    g.fill();

    g.beginPath();
    for (let k = kLo; k <= kHi; k++) {
      const x = xOf(box, k * df);
      const y = yOf(box, view.db[k], FFT_LO, FFT_HI);
      if (k === kLo) g.moveTo(x, y); else g.lineTo(x, y);
    }
    g.strokeStyle = COL.trace;
    g.lineWidth = 1.4;
    g.lineJoin = 'round';
    g.stroke();
    g.restore();
  }

  function drawStems(box) {
    const { g } = box;
    frame(box, REL_LO, REL_HI, REL_STEP, '');
    axis(box);

    if (!view.stems) {
      note(box, 'no values returned');
      return;
    }

    const hz = DTMF.ROW_HZ.concat(DTMF.COL_HZ);
    const peak = view.peak > 0 ? view.peak : 1;

    // the winner of each group, which is the pair the code is deciding on
    const best = (from, to) => {
      let at = from;
      for (let i = from; i < to; i++) if (view.stems[i] > view.stems[at]) at = i;
      return at;
    };
    const win = [best(0, 4), best(4, 8)];

    const floorY = box.y0 + box.h;
    for (let i = 0; i < 8; i++) {
      const v = view.stems[i];
      const rel = Number.isFinite(v) && v > 0 ? 10 * Math.log10(v / peak) : REL_LO;
      const x = Math.round(xOf(box, hz[i])) + 0.5;
      const y = yOf(box, rel, REL_LO, REL_HI);
      const on = win.includes(i);
      const c = i < 4 ? COL.row : COL.col;

      g.strokeStyle = on ? c : COL.dim;
      g.lineWidth = on ? 2 : 1.4;
      g.beginPath();
      g.moveTo(x, floorY);
      g.lineTo(x, y);
      g.stroke();

      g.fillStyle = on ? c : COL.dim;
      g.beginPath();
      g.arc(x, y, on ? 3 : 2.2, 0, Math.PI * 2);
      g.fill();
    }
  }

  /** The eight frequencies, staggered over two rows: 697 and 770 are 73 Hz
      apart, which is narrower than the labels. */
  function axis(box) {
    const { g } = box;
    const hz = DTMF.ROW_HZ.concat(DTMF.COL_HZ);
    g.font = '8px ui-monospace, monospace';
    g.textAlign = 'center';
    g.textBaseline = 'top';
    hz.forEach((f, i) => {
      if (f < F_LO || f > F_HI) return;
      g.fillStyle = i < 4 ? COL.row : COL.col;
      g.globalAlpha = 0.75;
      g.fillText(String(f), xOf(box, f), box.y0 + box.h + 4 + (i % 2 ? 11 : 0));
      g.globalAlpha = 1;
    });
    g.fillStyle = COL.faint;
    g.textAlign = 'right';
    g.fillText('Hz', box.x0 + box.w, box.y0 + box.h + 15);
  }

  function note(box, text) {
    const { g } = box;
    g.fillStyle = COL.faint;
    g.font = '10px ui-monospace, monospace';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText(text, box.x0 + box.w / 2, box.y0 + box.h / 2);
  }

  /* ─────────── the two captions ─────────── */

  /** Painted with the plots, so they can never say something the picture
      does not. */
  function captions() {
    els.fftNote.textContent = view.fromRun
      ? `${view.n} pt · the block your function was handed`
      : `${view.n} pt · Hann · dBFS`;

    els.stemNote.textContent =
      !view.stems ? (running ? 'return (c, rows + cols) to draw them' : 'press Run')
      : view.peak > 0 ? `peak ${fmt(view.peak)} at ${view.peakHz} Hz · dB below it`
      : 'all eight at zero — nothing in this block';
  }

  /** The stems only exist while something is being decoded, and the caption
      says something different when nothing is. */
  function setRunning(on) {
    running = !!on;
    if (!running) setStems(null);
    dirty = true;
  }

  function fmt(v) {
    if (!Number.isFinite(v) || v === 0) return '0';
    const a = Math.abs(v);
    return (a >= 1e4 || a < 1e-3) ? v.toExponential(1) : v.toPrecision(3);
  }

  return { init, isOpen, setOpen, toggle, live, paired, setStems, setRunning, clear };
})();
