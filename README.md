# DTMF sandbox

A keypad on the right, a Python file on the left. Dial a digit, and the code
you are looking at is what decodes it — in the browser, with no install and no
toolchain.

```powershell
powershell -ExecutionPolicy Bypass -File serve.ps1
```

or double-click `start.cmd`. It opens `http://localhost:8000`. The page **must**
be served over http: browsers block Web Workers and WebAssembly on `file://`
URLs, and the app says so rather than hanging if you try.

It opens with an empty `process_block`: the detector is the exercise. Press
**Run ▸** and dial and nothing is decoded yet — the keys still sound, the lamps
stay dark, and what you write is what lights them.

A worked detector ships alongside, and the app uses it only when asked. Double-
click `start-solution.cmd`, or open `http://localhost:8000/?solution=1`, and it
is in the editor instead of the empty starter — to dial against, or to check
your own against once you have one.

---

## What it does

```
  keypad ── frame ─┬─ speaker
                   ├─ FFT ─ spectrum panel
                   └─ blocks ─┐
  microphone ── blocks ───────┴─ process_block(x, fs, buf_size) ─┬─ c ─ gate ─ readout
                                                                 └─ stems ─ spectrum panel
```

### Where the samples come from

The switch at the top of the panel picks one of two lines, and the whole of
the rest of the app is the same either way.

**Keypad** generates them. The samples your function sees are exactly the
samples that went to the speaker, so what you hear and what you are decoding
cannot drift apart — and the noise and twist sliders are there because the app
put them there.

**Mic** stops generating and listens. Blocks come from whatever the microphone
hears: your phone dialling on the desk, a recording, the app itself through the
speaker. Nothing is recorded — the blocks go to your function and are dropped.

A detector that works on the generated line and falls over on the microphone is
the normal result, and the interesting one. The room brings a noise floor that
is not white, a level that changes with distance, a tone pair coloured by two
speakers and a microphone, and reflections that smear the edges of a digit.

A few things worth knowing about that path:

* Echo cancellation, noise suppression and automatic gain are all switched
  **off** in the request for the device. Each of them is designed to do the
  wrong thing here: the gain control rides over the level you are measuring,
  noise suppression hears a steady tone as noise and takes it out, and echo
  cancellation subtracts the app's own keypad from what the microphone heard.
* The capture context is opened at 8 kHz, so the browser resamples the device
  for you. If it refuses, the app resamples — behind three poles of lowpass at
  3 kHz, because reading every sixth sample out of 48 kHz would fold a 5 kHz
  whistle in the room down onto a column tone.
* **Gain** is a trim on the way in, 0 to +30 dB. A laptop microphone across
  a room lands a long way below the level the keypad sends at, and thresholds
  written against the generated line will look badly chosen until the level is
  comparable. The meter above the pad reads what Python is handed — after the
  gain — in dBFS, and turns red when it clips.
* The keys keep working and keep reaching the speaker: that is how you get a
  digit into the room to be heard. With the speaker on and the microphone
  listening, the app is a loop — headphones, or **Mute**, if it howls.
* The browser only gives a page the microphone in a secure context. `localhost`
  counts, so `start.cmd` is fine; a bare IP address on the network is not, and
  the app disables the switch and says so.

### The keypad

Each key is one row tone plus one column tone. The four row frequencies are
printed down the left of the pad and the four column frequencies across the
top, the way a service legend is printed on a phone: pressing **5** and reading
**770 + 1336** off the margins is the whole of what a key is.

| | 1209 | 1336 | 1477 |
| --- | --- | --- | --- |
| **697** | 1 | 2 | 3 |
| **770** | 4 | 5 | 6 |
| **852** | 7 | 8 | 9 |
| **941** | * | 0 | # |

Play with the mouse, or with the PC keyboard: the digits on the number row and
on the numeric keypad, `*`, and `#`. Keys are matched by physical position
first, so the layout holds on any national keyboard.

A telephone sends one digit at a time, so the pad is monophonic: a new key
takes the line and the one it displaced is released, even if your finger is
still on it. Rolling off 4 onto 5 sends 4 then 5, never a chord no detector was
written for. Every press sends at least 110 ms of tone however fast you tap —
Q.23 asks for 40, real dialers send about 100, and anything much shorter than
three blocks cannot be measured twice, which is what the gate below needs.

The standard has a fourth column at 1633 Hz — A, B, C, D. It is in `COL_HZ` and
in `KEYS`, because it is in the standard; it is not on the keypad, because it
was never on a telephone.

Three sliders under the pad. The first two are the things a real line varies,
and apply to the generated line; the third is the microphone trim, and is live
only when the microphone is the line. Whichever does not apply is dimmed.

| Slider | What it does |
| --- | --- |
| Noise | white noise across the whole line, quiet stretches included |
| Twist | high tone minus low tone, in dB |
| Gain | trim on the microphone on the way in, 0 to +30 dB |

Both are there to be turned up. A detector that only works on a clean, level
tone pair is not a detector yet, and the fastest way to find out which of your
thresholds is load-bearing is to lean on it. The worked detector gives up past
about 10 dB of twist, and says so in a comment — the slider goes to 12 on
purpose.

The lamp on a key lights when the **detector** says it hears that key, which is
not always the key being pressed. When those two disagree, you can see it.

### The spectrum

**Spectrum ▾** at the top of the panel opens two plots, stacked and sharing an
x axis, so a peak in the top one sits directly above the stem that is supposed
to be measuring it.

```
  FFT        the block, transformed by the app. 256 points, Hann window,
             dBFS — a full-scale sine reads 0 dB.
  Goertzel   the eight values your process_block returned for that same
             block, in dB below the strongest of the eight.
```

While the detector is running, the block on the top plot is **the block your
function was handed**, so the two plots always agree about what they are
describing. With nothing running, the top plot follows the line — the keypad
with whatever noise you have dialled in, or the room — and the bottom one says
what to return to fill it.

Every scale is fixed, on purpose:

| | |
| --- | --- |
| x | 500 – 1800 Hz, both plots — the standard, plus margin |
| y, FFT | 0 to −80 dBFS |
| y, stems | 0 to −40 dB, relative to the strongest of the eight |

An axis that rescales itself to fit answers *yes* to the only question worth
asking here — do the two tones stand clear of the other six — even on pure
noise. The stems are read as powers, which is what |X|² out of a Goertzel is,
so the decibels are 10·log₁₀ and the runner-up ratio your code tests is a
distance you can read off the plot.

The FFT is there to be looked at, not used: eight Goertzels cost a fraction of
a transform whose other 121 outputs get thrown away, which is the reason the
exercise is the way it is. Seeing both at once is the point.

With the plots open the panel shows the source switch, the plots and the keys,
and nothing else — the column has to fit on the screen without scrolling while
you dial and watch.

### Writing a detector

One field, one Python module, exec'd as it stands when you press Run. The app
calls one name in it, once per block:

```python
def process_block(x, fs, buf_size):
    ...
    return c
```

`x` is a numpy array of `buf_size` samples, `fs` is the rate in hertz. Return
**one character**, or `None` while there is nothing to hear.

You can hand the eight Goertzel values back with the answer, and the spectrum
panel draws them:

```python
return c, rows + cols        # four rows then four columns, as powers
return c, rows, cols         # or as the two lists you already have
```

Both shapes are accepted, here and in `detector.py`. Returning only the
character keeps working exactly as before — the stem plot then says what to
add. Returning anything
else stops the run and says so — an answer per block is the contract. Delete
`process_block` and Run tells you it is missing: it is the only name the app
looks for.

Everything else in the file is yours. Module-level names survive between
blocks, so a detector that wants history can keep it there; the module is
rebuilt only when you press Run, never per block.

**Five names are the app's**, and are written out at the top of the editor so
you can read them:

```python
FS = 8000                          # sample rate, Hz
BLOCK = 256                        # samples per call — 32.0 ms
ROW_HZ = (697, 770, 852, 941)      # the four rows
COL_HZ = (1209, 1336, 1477, 1633)  # the four columns
KEYS[row][col]                     # the character where the two cross
```

They are bound before your code runs and again after it, so anything you derive
from them is derived from the real ones, and writing your own value over one
changes nothing except a line in the console telling you it was put back. The
rate and the block size are the app's because the keypad and the detector have
to agree about them: a detector written against 8 kHz should never find itself
handed 44.1.

`numpy` (as `np`), `math` and `cmath` are available. An infinite loop is not an
edge case, so a watchdog kills a wedged interpreter, starts a fresh one, and
says what happened.

**Reset** puts the starter back — the empty one normally, the worked one when
the page was opened with `?solution=1`. The code is kept across reloads.

`detector.py` is the same contract as a file, with a bench that dials a string
and gates the answers, for working outside the browser. Its `process_block` is
empty too:

```powershell
python detector.py      # MISS on every line, until you write it
python solution.py      # the worked detector, through the same bench
```

`solution.py` does not copy the bench. It imports `detector` and puts its own
`process_block` in place of the empty one, so both files are gated the same
way.

---

## From answers to presses

Your function speaks once per block. A key pressed for 200 ms is six identical
blocks, and one digit was dialled. The gate is the difference:

* a value has to come back for **two blocks in a row** before it is believed;
* a character is printed on the edge where it becomes held, and **not again**
  until your function has let go of it — returned `None`, or a different
  character.

That is a button with its contact bounce taken out, which is what a key on a
phone is. What is dialled goes on the readout above the pad, and the line
under it shows the raw answer from the last block beside what the gate is
holding, so a detector that is flickering is visible before it starts printing
twice. Click the readout to clear it.

## Rate and block size

8 kHz is the rate DTMF was designed for: the highest tone is 1633 Hz, so there
is nothing above 4 kHz to lose. 256 samples is 32 ms, which puts the bins
31.3 Hz apart — comfortably finer than the 73 Hz between the 697 and 770 rows,
the narrowest gap in the standard, and the reason a much shorter block cannot
work however it is analysed.

The strip above the code says the same numbers, and the console shows what each
block costs. A block that takes longer than the 32 ms it covers cannot keep up:
the queue in front of Python is capped, and the console says so rather than
letting digits arrive a minute late.

---

## Files

```
index.html            one page, no build step
css/styles.css        one stylesheet — the palette, and the keypad
js/dtmf.js            the standard, as data — the only copy of the table
js/keypad.js          the pad, and the signal it puts on the line
js/fft.js             a radix-2 FFT, for the plot and nothing else
js/spectrum.js        the two plots, and the fixed scales they are drawn on
js/audio.js           the speaker end, and the resampler both ends share
js/mic.js             the microphone end: the device, and what it hands over
js/capture-worklet.js capture, on the audio rendering thread
js/monitor-worklet.js playback, on the audio rendering thread
js/editor.js          the code field, and the empty starter it opens with
js/solution.js        a worked detector — loaded, used only with ?solution=1
js/pyrunner.js        worker front end + watchdog
js/pyworker.js        Pyodide, and the per-block harness
js/app.js             the engine: frames, blocks, and the gate
detector.py           the contract as a file, with a bench — empty
solution.py           the worked detector, through detector.py's bench
vendor/               Pyodide (~16 MB) and CodeMirror, with a CDN fallback
serve.ps1             static server over raw sockets, no admin rights
start.cmd             double-click: the empty app
start-solution.cmd    double-click: the same app, worked detector loaded
```

No bundler, no package manager, no framework. Every module is an IIFE on
`window`, and the scripts load in dependency order at the end of `<body>`.
`_*.html` and `_*.js` are scratch pages for driving the app in a headless
browser; they are ignored by git.

Built for the signals course at ITBA, alongside the Audio FX sandbox, whose
Python worker, editor and look this shares — same palette, same starfield,
same material-darker code field, so the two pages read as one piece of
software.
