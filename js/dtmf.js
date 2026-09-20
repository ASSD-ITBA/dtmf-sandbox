/* ═══════════════════════════════════════════════════════════
   dtmf.js — the standard, as data

   Every key is one row tone plus one column tone. That is the
   whole of DTMF, and it is the only thing in this app that is
   not up to the person using it, so it lives on its own and
   everything else reads it from here: the keypad draws itself
   from this table, the tone generator takes its two frequencies
   from it, and Python is handed the same numbers, spelled out
   as the definitions at the top of the editor.

   ITU-T Q.23. The fourth column (1633 Hz, A–D) is in the table
   because it is in the standard; it is not on the keypad
   because it was never on a telephone.
   ═══════════════════════════════════════════════════════════ */

const DTMF = (() => {

  const ROW_HZ = [697, 770, 852, 941];          // rows, top to bottom
  const COL_HZ = [1209, 1336, 1477, 1633];      // columns, left to right

  const KEYS = [
    ['1', '2', '3', 'A'],
    ['4', '5', '6', 'B'],
    ['7', '8', '9', 'C'],
    ['*', '0', '#', 'D'],
  ];

  const PAD_COLS = 3;             // what a telephone actually has

  /* Letters under the digits, as they are printed on a phone. Purely
     decorative — nothing in the signal knows about them. */
  const LETTERS = {
    '2': 'ABC', '3': 'DEF', '4': 'GHI', '5': 'JKL',
    '6': 'MNO', '7': 'PQRS', '8': 'TUV', '9': 'WXYZ', '0': 'OPER',
  };

  /** char -> {low, high, row, col} */
  const PAIRS = (() => {
    const m = new Map();
    KEYS.forEach((row, r) => row.forEach((ch, c) => {
      m.set(ch, { low: ROW_HZ[r], high: COL_HZ[c], row: r, col: c });
    }));
    return m;
  })();

  const pair = ch => PAIRS.get(ch) || null;
  const has = ch => PAIRS.has(ch);

  /** Only the keys the pad shows can be dialled. */
  const onPad = ch => {
    const p = pair(ch);
    return !!p && p.col < PAD_COLS;
  };

  /* Physical keys first so the layout holds on any national keyboard, with the
     printed character as the fallback. The numeric keypad is included because
     on a phone that is exactly what this is. */
  const BY_CODE = new Map([
    ['Digit1', '1'], ['Digit2', '2'], ['Digit3', '3'],
    ['Digit4', '4'], ['Digit5', '5'], ['Digit6', '6'],
    ['Digit7', '7'], ['Digit8', '8'], ['Digit9', '9'], ['Digit0', '0'],
    ['Numpad1', '1'], ['Numpad2', '2'], ['Numpad3', '3'],
    ['Numpad4', '4'], ['Numpad5', '5'], ['Numpad6', '6'],
    ['Numpad7', '7'], ['Numpad8', '8'], ['Numpad9', '9'], ['Numpad0', '0'],
    ['NumpadMultiply', '*'], ['NumpadDivide', '#'],
  ]);

  /** The character a key event means, or null. */
  function fromEvent(e) {
    let ch = BY_CODE.get(e.code);
    if (!ch) {
      const k = e.key || '';
      if (k === '*' || k === '#' || /^[0-9]$/.test(k)) ch = k;
    }
    return ch && onPad(ch) ? ch : null;
  }

  /**
   * The app's parameters, as Python source. This is what the definitions at
   * the top of the editor *are*: the same text is bound into the namespace
   * before the code runs and again after it, so what the detector sees is
   * always what the keypad is actually sending.
   */
  function pythonParams(fs, block) {
    const rows = KEYS
      .map(r => `        (${r.map(c => `'${c}'`).join(', ')})`)
      .join(',\n');
    return [
      `FS = ${fs}`,
      `BLOCK = ${block}`,
      `ROW_HZ = (${ROW_HZ.join(', ')})`,
      `COL_HZ = (${COL_HZ.join(', ')})`,
      `KEYS = (\n${rows},\n)`,
    ].join('\n');
  }

  return {
    ROW_HZ, COL_HZ, KEYS, LETTERS, PAD_COLS,
    pair, has, onPad, fromEvent, pythonParams,
  };
})();
