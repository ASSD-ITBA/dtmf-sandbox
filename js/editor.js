/* ═══════════════════════════════════════════════════════════
   editor.js — one field, one module

   There is no locked boilerplate and no second pane: what you
   see is the whole Python module, exec'd as it stands when Run
   is pressed. The app looks for one name in what comes out —
   process_block — and says so if it is not there.

   STARTER is the contract and nothing else: writing the
   detector is the exercise. Reset puts it back. A worked
   one lives in js/solution.js, for ?solution=1.
   ═══════════════════════════════════════════════════════════ */

const Editor = (() => {

  const STARTER = [
    '# ── What the app gives you ──────────────────────────────────────────',
    '#',
    '# The five names below belong to the app: it binds them before your',
    '# code runs and again after it, so changing the numbers here changes',
    '# nothing. The keypad sends at FS, and process_block is handed BLOCK',
    '# samples at a time.',
    '',
    'FS = 8000                            # sample rate, Hz',
    'BLOCK = 256                          # samples per call — 32.0 ms',
    '',
    'ROW_HZ = (697, 770, 852, 941)        # the four rows, top to bottom',
    'COL_HZ = (1209, 1336, 1477, 1633)    # the four columns, left to right',
    '',
    "KEYS = (('1', '2', '3', 'A'),        # KEYS[row][col] — where they cross",
    "        ('4', '5', '6', 'B'),",
    "        ('7', '8', '9', 'C'),",
    "        ('*', '0', '#', 'D'))",
    '',
    '',
    '# ── Your detector ─────────────────────────────────────────────────',
    '',
    'import math',
    '',
    'import numpy as np',
    '',
    '',
    'def process_block(x, fs, buf_size):',
    '    """One block of the line in, one character out — or None.',
    '',
    '    Called once per block for as long as the app is running.',
    '    This is the one name the app looks for: delete it and Run',
    '    will tell you so.',
    '',
    '    x is a numpy array of buf_size samples of the line. Return',
    '    the character you can hear in it, or None while there is',
    '    nothing to hear.',
    '',
    '    Return the eight Goertzel values with it —',
    '',
    '        return c, rows + cols',
    '',
    '    (four rows then four columns, as powers) and the Spectrum',
    '    panel draws them under the FFT of the same block.',
    '    """',
    '    c = None',
    '',
    '    # A Goertzel at each of ROW_HZ and COL_HZ costs far less than an',
    '    # FFT whose outputs would all but eight be thrown away. Write one',
    '    # above this function and call it from here.',
    '',
    '    return c',
    '',
  ].join('\n');

  /* The app ships empty, because writing the detector is the exercise. A
     worked one lives in js/solution.js and is loaded but not used: the page
     reaches for it only when it is opened with ?solution=1, which is all
     start-solution.cmd does. */
  const wantsSolution = () => {
    try { return new URLSearchParams(location.search).has('solution'); }
    catch { return false; }        /* very old browser — no solution, then */
  };

  /** What Reset puts back, and what a first visit opens with. */
  const shipped = () => ((wantsSolution() && window.DTMF_SOLUTION) || STARTER);

  const LS_KEY = 'dtmf_sandbox.code';

  let cm = null;            // CodeMirror (null when using the fallback)
  let ta = null;            // textarea fallback
  let el = null;
  let runCb = () => {};

  /* ─────────── persistence ─────────── */

  function load() {
    // ?solution=1 is a deliberate act, so it outranks whatever was left here
    if (wantsSolution() && window.DTMF_SOLUTION) return window.DTMF_SOLUTION;
    try {
      const saved = localStorage.getItem(LS_KEY);
      if (typeof saved === 'string' && saved.trim()) return saved;
    } catch { /* corrupt storage, or none — the starter it is */ }
    return STARTER;
  }

  /* Not everything that lands in the editor is the user's to keep: the cheat
     puts the worked detector in it, and a reload has to give them back what
     they wrote. Every setSource says which kind it is, and nothing is
     written while the answer is on screen. */
  let persist = true;

  function save() {
    if (!persist) return;
    try { localStorage.setItem(LS_KEY, getSource()); }
    catch { /* quota / private mode */ }
  }

  /* ─────────── construction ─────────── */

  function init(opts) {
    el = document.getElementById('code-body');
    runCb = (opts && opts.onRun) || runCb;
    const start = load();

    const extraKeys = {
      Tab: c => c.execCommand('indentMore'),
      'Shift-Tab': c => c.execCommand('indentLess'),
      'Ctrl-Enter': () => runCb(),
      'Cmd-Enter': () => runCb(),
    };

    if (window.CodeMirror) {
      cm = CodeMirror(el, {
        value: start,
        mode: { name: 'python', version: 3, singleLineStringErrors: false },
        theme: 'material-darker',
        lineNumbers: true,
        indentUnit: 4,
        indentWithTabs: false,
        smartIndent: true,
        matchBrackets: true,
        styleActiveLine: true,
        viewportMargin: Infinity,
        extraKeys,
      });
      cm.on('change', save);
    } else {
      // CodeMirror unavailable — a plain text area still runs Python
      ta = document.createElement('textarea');
      ta.className = 'fallback';
      ta.spellcheck = false;
      ta.value = start;
      el.appendChild(ta);
      ta.addEventListener('input', save);
      ta.addEventListener('keydown', e => {
        if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); runCb(); }
        if (e.key === 'Tab') {
          e.preventDefault();
          const s = ta.selectionStart;
          ta.setRangeText('    ', s, ta.selectionEnd, 'end');
          ta.dispatchEvent(new Event('input'));
        }
      });
    }
  }

  /* ─────────── public ─────────── */

  const getSource = () => (cm ? cm.getValue() : (ta ? ta.value : ''));

  /**
   * @param {string} text
   * @param {{persist?: boolean}} [opts]  persist: false for code that is not
   *        the user's — it goes on screen and no further
   */
  function setSource(text, opts) {
    persist = !(opts && opts.persist === false);
    if (cm) cm.setValue(text);
    else if (ta) ta.value = text;
    save();
  }

  /** Put back the detector the app ships with. */
  const reset = () => setSource(shipped());

  /*
     While a pass is running the code on screen is no longer the code that is
     decoding — the interpreter holds the version compiled at Run. Rather than
     let the two drift apart silently, the editor goes read-only until it stops.
  */
  function setReadOnly(on) {
    if (cm) cm.setOption('readOnly', on ? 'nocursor' : false);
    if (ta) ta.readOnly = on;
    const shell = document.getElementById('code-shell');
    if (shell) shell.classList.toggle('readonly', on);
  }

  return { init, getSource, setSource, reset, setReadOnly, STARTER };
})();
