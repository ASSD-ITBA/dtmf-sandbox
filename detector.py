"""detector.py — the app's contract, as a file you can run outside it.

The DTMF sandbox exec's the editor as one Python module and then calls one
name in it, once per block:

    def process_block(x, fs, buf_size):
        ...
        return c

    x         numpy array of buf_size samples of the line, float
    fs        sample rate, Hz
    buf_size  how long x is
    returns   one character, or None while there is nothing to hear

Delete process_block and Run says so: it is the only name the app looks for.

Five names are the app's, not the code's. They are bound before the module
runs and again after it, so writing your own value over one of them changes
nothing except the message in the console:

    FS = 8000                          sample rate, Hz
    BLOCK = 256                        samples per call, 32.0 ms
    ROW_HZ = (697, 770, 852, 941)      the four rows
    COL_HZ = (1209, 1336, 1477, 1633)  the four columns
    KEYS[row][col]                     the character where the two cross

Run this file to try a detector without the browser:

    python detector.py

It dials a string through whatever process_block below does with it, and
gates the answers the way the app does.
"""

import math

import numpy as np

FS = 8000
BLOCK = 256
ROW_HZ = (697, 770, 852, 941)
COL_HZ = (1209, 1336, 1477, 1633)
KEYS = (('1', '2', '3', 'A'),
        ('4', '5', '6', 'B'),
        ('7', '8', '9', 'C'),
        ('*', '0', '#', 'D'))


# ─────────────────────────── your detector ───────────────────────────

def process_block(x, fs, buf_size):
    c = None

    # x is a numpy array of buf_size samples of the line.
    # Return the character you can hear in it, or None for silence.
    #
    # Write your Goertzel above this function and call it from here.

    return c


# ────────────────────────── the test bench ──────────────────────────
#
# Everything below stands in for the app: it builds a line, cuts it into
# blocks, and gates the answers. You should not need to change it.

LEVEL = 0.3           # amplitude of each tone, as the keypad sends it
MIN_TONE_MS = 110     # the shortest burst a key press can send
STABLE = 2            # blocks a value must repeat before the app believes it

PAIR = {ch: (ROW_HZ[r], COL_HZ[c])
        for r, row in enumerate(KEYS) for c, ch in enumerate(row)}


def tone(ch, ms=180, fs=FS, level=LEVEL, twist_db=0.0, noise=0.0):
    """One key held for `ms`, with the ramps the keypad puts on it."""
    ms = max(ms, MIN_TONE_MS)
    n = int(round(ms * fs / 1000))
    low, high = PAIR[ch]
    t = np.arange(n) / fs
    x = (level * np.sin(2 * np.pi * low * t) +
         level * 10 ** (twist_db / 20) * np.sin(2 * np.pi * high * t))
    up, down = max(1, int(0.004 * fs)), max(1, int(0.010 * fs))
    x[:up] *= np.linspace(0, 1, up)
    x[-down:] *= np.linspace(1, 0, down)
    if noise:
        x = x + np.random.uniform(-noise, noise, n)
    return x


def quiet(ms, fs=FS, noise=0.0):
    n = int(round(ms * fs / 1000))
    return np.random.uniform(-noise, noise, n) if noise else np.zeros(n)


def line(text, tone_ms=180, gap_ms=90, noise=0.0, twist_db=0.0):
    """A dialled string, tones and gaps, as the keypad would send it."""
    parts = [quiet(gap_ms, noise=noise)]
    for ch in text:
        parts.append(tone(ch, tone_ms, twist_db=twist_db, noise=noise))
        parts.append(quiet(gap_ms, noise=noise))
    return np.concatenate(parts)


def blocks(x, fs=FS, buf_size=BLOCK):
    """What the app calls, in the order it calls it: every block is buf_size
       long, the last one zero-padded rather than handed over short."""
    for s in range(0, len(x), buf_size):
        b = x[s:s + buf_size]
        if len(b) < buf_size:
            b = np.concatenate((b, np.zeros(buf_size - len(b))))
        v = process_block(b, float(fs), buf_size)
        yield '' if v is None else str(v)


def gate(chars, stable=STABLE):
    """The app's decision: a value has to hold for `stable` blocks before it
       is believed, and a character is printed on the edge where it becomes
       held — never again until the line has let go of it."""
    held, cand, n, out = '', '', 0, []
    for c in chars:
        n = n + 1 if c == cand else 1
        cand = c
        if n >= stable and cand != held:
            held = cand
            if held:
                out.append(held)
    return ''.join(out)


def dial(text, **kw):
    return gate(blocks(line(text, **kw)))


if __name__ == '__main__':
    for noise, twist in ((0.0, 0.0), (0.05, 0.0), (0.0, 6.0)):
        for want in ('0800*1234#', '5551234'):
            heard = dial(want, noise=noise, twist_db=twist)
            mark = 'ok  ' if heard == want else 'MISS'
            print(f'{mark} noise {noise:<5} twist {twist:+.0f} dB  '
                  f'dialled {want:<12} heard {heard!r}')
    print(f'\n{FS} Hz, blocks of {BLOCK}: {BLOCK / FS * 1000:.1f} ms, '
          f'bins {FS / BLOCK:.1f} Hz apart. The 697 and 770 tones are only '
          f'{ROW_HZ[1] - ROW_HZ[0]} Hz apart.')
