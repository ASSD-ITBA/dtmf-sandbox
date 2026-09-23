/* ═══════════════════════════════════════════════════════════
   pyworker.js — Pyodide lives here, off the UI thread

   This is an ES *module* worker: Pyodide 314 refuses to run in a
   classic worker ("Classic web workers are not supported"), so it
   is pulled in with a dynamic import of pyodide.mjs rather than
   importScripts().

   Protocol (main -> worker):
     {type:'init'}
     {type:'compile', id, src, params}
     {type:'run', id, fs, bufSize, data:Float32Array}
   Worker -> main:
     {type:'ready'|'compiled'|'result'|'error'|'stdout'|'stderr'|'status'}
   ═══════════════════════════════════════════════════════════ */

const PYODIDE_VERSION = '314.0.3';

/* Local copy first so a published page has no third-party dependency, then the
   CDN as a safety net in case vendor/ was not copied along with the app. */
const SOURCES = [
  { name: 'vendor', url: new URL('../vendor/pyodide/', self.location.href).href },
  { name: 'CDN', url: `https://cdn.jsdelivr.net/pyodide/v${PYODIDE_VERSION}/full/` },
];

let pyodide = null;
let harness = null;      // { compile, run }

/* The per-block loop runs *inside* Python: a frame is a handful of blocks, and
   crossing the JS<->Python boundary once per block would cost more than the
   detector does.

   The detector keeps its state in module globals between blocks, and the
   namespace is only rebuilt on an explicit compile: a block boundary is not a
   discontinuity in the signal, and a detector whose history is emptied thirty
   times a second is not the detector that was written.

   `params` — FS, BLOCK, ROW_HZ, COL_HZ, KEYS — is bound before the code runs,
   so anything derived from them at module level is derived from the real ones,
   and again after, so the values the detector reads are the app's whatever the
   code did to them in between. Anything that was overwritten comes back as a
   name to warn about rather than being silently undone. */
const HARNESS_PY = `
import builtins, math, cmath
import numpy as np

_NS = None

def _same(a, b):
    try:
        return bool(a == b)
    except Exception:              # a numpy array compares elementwise
        return False

def _compile(src, params):
    global _NS
    app = {}
    exec(params, {'__builtins__': builtins}, app)

    ns = {
        '__builtins__': builtins,
        'math': math, 'cmath': cmath,
        'np': np, 'numpy': np,
    }
    ns.update(app)
    exec(src, ns)

    taken = sorted(k for k, v in app.items() if k in ns and not _same(ns[k], v))
    ns.update(app)                 # the app's values are the ones that run
    _NS = ns

    if 'process_block' not in ns:
        raise NameError(
            "process_block is not defined — the code has to define "
            "process_block(x, fs, buf_size) for the app to call")
    if not callable(ns['process_block']):
        raise TypeError("process_block is not a function")
    return taken

def _unit():
    if _NS is None:
        raise NameError("nothing has been compiled yet")
    return _NS

def _as_stems(v):
    """The eight Goertzel values, in ROW_HZ then COL_HZ order, for the panel
       to draw. Anything the code can iterate eight floats out of will do."""
    if v is None:
        return None
    try:
        vals = [float(x) for x in v]
    except TypeError:
        raise TypeError(
            "the second thing process_block returned is a %s — it has to be "
            "the eight Goertzel values, ROW_HZ then COL_HZ" % type(v).__name__)
    if len(vals) != 8:
        raise ValueError(
            "process_block returned %d Goertzel values — it has to be eight, "
            "ROW_HZ then COL_HZ" % len(vals))
    return vals

def _split(v):
    """One block, one answer: a character on its own, or a character and the
       values it was decided from."""
    if isinstance(v, (tuple, list)):
        if len(v) == 2:
            return _as_char(v[0]), _as_stems(v[1])
        if len(v) == 3:                      # (c, rows, cols), which is how a
            rows = list(v[1]) + list(v[2])   # detector usually has them
            return _as_char(v[0]), _as_stems(rows)
        raise ValueError(
            "process_block returned %d things — one character, or a character "
            "and the eight Goertzel values" % len(v))
    return _as_char(v), None

def _as_char(v):
    """What a block is allowed to hand back: a character, or nothing."""
    if v is None:
        return ''
    if isinstance(v, str):
        if len(v) <= 1:
            return v
        raise ValueError(
            "process_block returned %r — one character, or None for silence"
            % (v[:12] + ('…' if len(v) > 12 else ''),))
    if isinstance(v, bool):
        raise TypeError("process_block returned a bool — return the character, or None")
    raise TypeError(
        "process_block returned %s — one character, or None for silence"
        % type(v).__name__)

def _run(data, fs, buf_size):
    ns = _unit()
    f = ns['process_block']
    buf_size = max(1, int(buf_size))

    arr = np.asarray(data, dtype=np.float64)
    n = len(arr)
    out = []
    stems, stems_at, i = None, -1, 0
    for s in range(0, n, buf_size):
        x = arr[s:s + buf_size]
        # Every block is buf_size long. A frame is always a whole number of
        # blocks, so this never fires — but a detector that indexes
        # x[buf_size - 1] should never meet a short one.
        if len(x) < buf_size:
            x = np.concatenate((x, np.zeros(buf_size - len(x))))
        c, vals = _split(f(x, fs, buf_size))
        out.append(c)
        # only the last block that gave any gets drawn: the plot shows one
        # block, and which one it was has to be knowable
        if vals is not None:
            stems, stems_at = vals, i
        i += 1
    return out, stems, stems_at
`;

function post(msg, transfer) { self.postMessage(msg, transfer || []); }

/**
 * Bring Pyodide up from the first source that works. A source is only accepted
 * once numpy has loaded too — a half-present vendor/ directory must fall
 * through to the CDN rather than leave the app broken.
 */
async function bootPyodide() {
  const errors = [];
  for (const src of SOURCES) {
    try {
      post({ type: 'status', text: `python · ${src.name}` });
      const { loadPyodide } = await import(`${src.url}pyodide.mjs`);

      const py = await loadPyodide({
        indexURL: src.url,
        stdout: text => post({ type: 'stdout', text }),
        stderr: text => post({ type: 'stderr', text }),
      });

      post({ type: 'status', text: `numpy · ${src.name}` });
      await py.loadPackage('numpy');

      return { py, source: src.name };
    } catch (e) {
      errors.push(`${src.name}: ${(e && e.message) || e}`);
    }
  }
  throw new Error(errors.join('\n'));
}

async function init() {
  try {
    const { py, source } = await bootPyodide();
    pyodide = py;
    if (source !== 'vendor') {
      post({ type: 'stderr', text: 'vendor/pyodide/ unavailable — loaded from the jsDelivr CDN instead.' });
    }

    pyodide.runPython(HARNESS_PY);
    harness = {
      compile: pyodide.globals.get('_compile'),
      run: pyodide.globals.get('_run'),
    };

    const version = pyodide.runPython('import sys; ".".join(map(str, sys.version_info[:3]))');
    post({ type: 'ready', version });
  } catch (e) {
    post({ type: 'error', phase: 'init', message: String((e && e.message) || e) });
  }
}

/* `params` is the app's parameter block as Python source, sent by the main
   thread so the keypad and the detector cannot disagree about the standard,
   the rate or the block size. See dtmf.js — that table is the only copy. */
function compile(id, src, params) {
  try {
    const res = harness.compile(src, params || '');
    const taken = res.toJs ? res.toJs() : res;
    if (res.destroy) res.destroy();
    post({ type: 'compiled', id, taken });
  } catch (e) {
    post({ type: 'error', id, phase: 'compile', message: cleanTrace(e) });
  }
}

function run(msg) {
  const { id, fs, bufSize, data } = msg;
  const t = performance.now();
  let pyIn = null, res = null;
  try {
    pyIn = pyodide.toPy(Array.from(data));
    res = harness.run(pyIn, fs, bufSize);
    const got = res.toJs ? res.toJs() : res;
    post({
      type: 'result', id,
      chars: got[0],
      stems: got[1] || null,          // Python None arrives as undefined
      stemsAt: typeof got[2] === 'number' ? got[2] : -1,
      ms: performance.now() - t,
    });
  } catch (e) {
    post({ type: 'error', id, phase: 'run', message: cleanTrace(e) });
  } finally {
    if (res && res.destroy) res.destroy();
    if (pyIn && pyIn.destroy) pyIn.destroy();
  }
}

/** Strip the harness frames so the user sees their own traceback. */
function cleanTrace(e) {
  const m = String((e && e.message) || e);
  const lines = m.split('\n').filter(l =>
    !l.includes('/lib/python') &&
    !l.includes('pyodide/_') &&
    !l.includes('File "<exec>"'));
  return lines.join('\n').trim() || m;
}

self.onmessage = ev => {
  const msg = ev.data;
  switch (msg.type) {
    case 'init': init(); break;
    case 'compile': compile(msg.id, msg.src, msg.params); break;
    case 'run': run(msg); break;
  }
};
