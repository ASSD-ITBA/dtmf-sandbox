"""solution.py — a detector that works, run against the bench in detector.py.

detector.py ships with an empty process_block, because writing it is the
exercise. This is the same detector the app hands you when it is opened with
?solution=1, as a file you can run:

    python solution.py

The bench is not copied here. detector.py's line builder, blocker and gate are
the app's behaviour, and two copies of them would be one too many — this module
imports them and puts its own process_block in their place.
"""

import math

import numpy as np

import detector
from detector import BLOCK, COL_HZ, FS, KEYS, ROW_HZ


def goertzel(samples, f, fs):
    """|X(f)|^2 over one block, by the two-pole recursion.

    One frequency, not a whole transform: eight of these cost far less than an
    FFT whose outputs would all but eight be thrown away. Evaluated at f itself
    and not at the nearest DFT bin, which can cost 4 dB of the very magnitude
    being measured.
    """
    w = 2.0 * math.pi * f / fs
    coeff = 2.0 * math.cos(w)
    s1 = s2 = 0.0
    for v in samples:
        s0 = v + coeff * s1 - s2
        s2 = s1
        s1 = s0
    return s1 * s1 + s2 * s2 - coeff * s1 * s2


def tone_power(samples, f, fs):
    """Mean power of the component at f: A^2/2 for a sine of amplitude A, so it
       compares directly with the mean power of the block itself."""
    n = len(samples)
    return 2.0 * goertzel(samples, f, fs) / (n * n)


def runner_up(vals, win):
    """The largest of the rest — what the winner has to beat."""
    return max(v for i, v in enumerate(vals) if i != win)


QUIET = 1e-5      # mean power below which the line counts as silent
RATIO = 8.0       # how far the winning tone must beat its runner-up
PURITY = 0.5      # share of the block the two tones must account for
TWIST = 10.0      # widest power ratio between the two tones — about 10 dB,
                  # past which this gives up. Push the twist slider further
                  # than that and watch it do so.


def process_block(x, fs, buf_size):
    """One block of the line in, one character out — or None."""
    power = float(np.mean(x * x))
    if power < QUIET:
        return None                      # nothing on the line

    # a Python loop over a numpy array pays for a boxed float a step
    samples = x.tolist()
    rows = [tone_power(samples, f, fs) for f in ROW_HZ]
    cols = [tone_power(samples, f, fs) for f in COL_HZ]

    r = max(range(4), key=lambda i: rows[i])
    c = max(range(4), key=lambda i: cols[i])

    # one tone per group, each well clear of the other three
    if runner_up(rows, r) * RATIO > rows[r]:
        return None
    if runner_up(cols, c) * RATIO > cols[c]:
        return None

    # the pair has to be most of what is in the block, or it is noise that
    # happens to lean one way
    if rows[r] + cols[c] < PURITY * power:
        return None

    # and neither tone may swamp the other: that is twist, and a real line has
    # a few dB of it, never twenty
    if not (1.0 / TWIST < cols[c] / rows[r] < TWIST):
        return None

    return KEYS[r][c]


# The bench calls process_block by name in detector's own namespace, so this is
# where the detector has to be put for detector.dial to find it.
detector.process_block = process_block


if __name__ == '__main__':
    for noise, twist in ((0.0, 0.0), (0.05, 0.0), (0.0, 6.0)):
        for want in ('0800*1234#', '5551234'):
            heard = detector.dial(want, noise=noise, twist_db=twist)
            mark = 'ok  ' if heard == want else 'MISS'
            print(f'{mark} noise {noise:<5} twist {twist:+.0f} dB  '
                  f'dialled {want:<12} heard {heard!r}')
    print(f'\n{FS} Hz, blocks of {BLOCK}: {BLOCK / FS * 1000:.1f} ms, '
          f'bins {FS / BLOCK:.1f} Hz apart. The 697 and 770 tones are only '
          f'{ROW_HZ[1] - ROW_HZ[0]} Hz apart.')
