/* ═══════════════════════════════════════════════════════════
   fft.js — the whole spectrum, for looking at

   The detector does not need this and should not use it: eight
   Goertzels cost a fraction of a 256-point FFT whose other 121
   outputs would be thrown away. It is here so that the eight
   numbers your function returns can be seen against everything
   else that was in the block.

   Radix-2, in place, with the twiddles and the bit-reversal
   table kept per block size — the size never changes while the
   app is running, so they are built once.
   ═══════════════════════════════════════════════════════════ */

const FFT = (() => {

  const cache = new Map();

  function tables(n) {
    const hit = cache.get(n);
    if (hit) return hit;

    const levels = Math.log2(n);
    if (!Number.isInteger(levels)) {
      throw new Error(`FFT wants a power of two, not ${n}`);
    }

    const cos = new Float64Array(n / 2);
    const sin = new Float64Array(n / 2);
    for (let i = 0; i < n / 2; i++) {
      cos[i] = Math.cos(2 * Math.PI * i / n);
      sin[i] = Math.sin(2 * Math.PI * i / n);
    }

    const rev = new Uint32Array(n);
    for (let i = 0; i < n; i++) {
      let x = i, r = 0;
      for (let b = 0; b < levels; b++) { r = (r << 1) | (x & 1); x >>>= 1; }
      rev[i] = r;
    }

    /* Hann, because a tone that does not land exactly on a bin — and at
       31.25 Hz apart, 697 does not — smears across the whole plot with a
       rectangular window and buries the noise floor under its own skirts.
       `gain` is the mean of the window, which puts the amplitude back. */
    const win = new Float64Array(n);
    let sum = 0;
    for (let i = 0; i < n; i++) {
      win[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / n);
      sum += win[i];
    }

    const t = { n, levels, cos, sin, rev, win, gain: sum / n };
    cache.set(n, t);
    return t;
  }

  /**
   * Magnitude spectrum in dBFS: a full-scale sinusoid reads 0 dB, whatever
   * the block size.
   *
   * @param {Float32Array|Float64Array} block  a power-of-two number of samples
   * @param {number} floorDb   what to report where there is nothing at all
   * @returns {Float32Array}   n / 2 + 1 bins, DC first
   */
  function magnitudesDb(block, floorDb = -140) {
    const n = block.length;
    const t = tables(n);

    const re = new Float64Array(n);
    const im = new Float64Array(n);
    for (let i = 0; i < n; i++) re[t.rev[i]] = block[i] * t.win[i];

    for (let size = 2; size <= n; size <<= 1) {
      const half = size >> 1;
      const step = n / size;
      for (let i = 0; i < n; i += size) {
        for (let j = i, k = 0; j < i + half; j++, k += step) {
          const l = j + half;
          const tre = re[l] * t.cos[k] + im[l] * t.sin[k];
          const tim = -re[l] * t.sin[k] + im[l] * t.cos[k];
          re[l] = re[j] - tre; im[l] = im[j] - tim;
          re[j] += tre;        im[j] += tim;
        }
      }
    }

    const bins = n / 2 + 1;
    const out = new Float32Array(bins);
    for (let k = 0; k < bins; k++) {
      // every bin but DC and Nyquist has a twin in the negative half
      const twoSided = (k === 0 || k === n / 2) ? 1 : 2;
      const m = Math.hypot(re[k], im[k]) * twoSided / (n * t.gain);
      out[k] = m > 0 ? Math.max(floorDb, 20 * Math.log10(m)) : floorDb;
    }
    return out;
  }

  /** Hz of bin k, for a block of n samples at fs. */
  const binHz = (k, n, fs) => k * fs / n;

  return { magnitudesDb, binHz };
})();
