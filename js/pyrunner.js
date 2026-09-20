/* ═══════════════════════════════════════════════════════════
   pyrunner.js — main-thread front end for the Pyodide worker

   Adds a watchdog: a detector can trivially contain a loop that
   never ends, and there is no way to interrupt a running
   Pyodide. The only cure is to kill the worker and boot a
   fresh one.
   ═══════════════════════════════════════════════════════════ */

const PyRunner = (() => {

  const WORKER_URL = 'js/pyworker.js?v=3';

  let worker = null;
  let ready = false;
  let booting = false;
  let seq = 0;
  const pending = new Map();      // id -> { resolve, reject, timer }
  let lastCompile = null;         // replayed after a restart
  let busy = false;

  const hooks = { onStatus: () => {}, onOutput: () => {}, onRestart: null };

  /* ─────────── worker lifecycle ─────────── */

  function boot() {
    booting = true;
    ready = false;
    try {
      // must be a module worker — Pyodide 314 rejects classic workers.
      // Throws synchronously on a file:// page, where the origin is null.
      worker = new Worker(WORKER_URL, { type: 'module' });
    } catch (e) {
      booting = false;
      worker = null;
      hooks.onStatus('error', 'no worker');
      hooks.onOutput('err', `Could not start the Python worker: ${e.message || e}`);
      return;
    }
    worker.onmessage = onMessage;
    worker.onerror = e => {
      hooks.onStatus('error', e.message || 'worker failed to start');
      hooks.onOutput('err', `worker error: ${e.message || e}`);
    };
    worker.postMessage({ type: 'init' });
    hooks.onStatus('booting', 'starting Python…');
  }

  function onMessage(ev) {
    const m = ev.data;

    switch (m.type) {
      case 'status':
        hooks.onStatus('booting', m.text);
        return;

      case 'ready':
        ready = true;
        booting = false;
        hooks.onStatus('ready', `Python ${m.version}`);
        hooks.onOutput('sys', `Python ${m.version} ready (numpy available as np)`);
        if (lastCompile) compile(lastCompile.src, lastCompile.params).catch(() => {});
        if (hooks.onRestart) hooks.onRestart();
        return;

      case 'stdout': hooks.onOutput('out', m.text); return;
      case 'stderr': hooks.onOutput('err', m.text); return;

      case 'compiled':
      case 'result': {
        const p = pending.get(m.id);
        if (!p) return;
        clearTimeout(p.timer);
        pending.delete(m.id);
        busy = pending.size > 0;
        p.resolve(m);
        return;
      }

      case 'error': {
        if (m.phase === 'init') {
          booting = false;
          hooks.onStatus('error', 'Pyodide failed to load');
          hooks.onOutput('err', `Could not load Pyodide: ${m.message}\n` +
            'Check the network connection — Pyodide is fetched from the jsDelivr CDN.');
          return;
        }
        const p = pending.get(m.id);
        if (!p) { hooks.onOutput('err', m.message); return; }
        clearTimeout(p.timer);
        pending.delete(m.id);
        busy = pending.size > 0;
        p.reject(new Error(m.message));
        return;
      }
    }
  }

  /** Kill a wedged worker and bring a fresh one up. */
  function restart(reason) {
    if (worker) worker.terminate();
    for (const [, p] of pending) {
      clearTimeout(p.timer);
      p.reject(new Error(reason || 'interpreter restarted'));
    }
    pending.clear();
    busy = false;
    boot();
  }

  function request(msg, timeoutMs, transfer) {
    if (!ready) return Promise.reject(new Error('Python is not ready yet'));
    const id = ++seq;
    msg.id = id;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        restart('timeout');
        hooks.onStatus('error', 'timed out — interpreter restarted');
        reject(new Error(
          `Timed out after ${(timeoutMs / 1000).toFixed(1)} s. ` +
          'The interpreter was restarted — check for a loop that never ends, ' +
          'or use a smaller block.'));
      }, timeoutMs);
      pending.set(id, { resolve, reject, timer });
      busy = true;
      worker.postMessage(msg, transfer || []);
    });
  }

  /* ─────────── public API ─────────── */

  function start(opts = {}) {
    Object.assign(hooks, opts);
    if (!worker) boot();
  }

  /**
   * `params` is the app's parameter block as Python source — FS, BLOCK and the
   * DTMF table — bound around the code so the detector and the keypad cannot
   * disagree about any of them.
   *
   * @returns {Promise<string[]>} the parameter names the code assigned to and
   *          the app took back, so the caller can say so
   */
  function compile(src, params, timeoutMs = 15000) {
    lastCompile = { src, params };
    return request({ type: 'compile', src, params }, timeoutMs)
      .then(m => m.taken || []);
  }

  /**
   * `data` is a whole number of blocks, handed over in one crossing: the JS↔
   * Python boundary costs more than the detector does, so a frame carries as
   * many blocks as it has rather than one call each.
   *
   * The buffer is transferred, so pass a copy if you still need it.
   *
   * @returns {Promise<{chars: string[], ms: number}>} one character per block,
   *          '' where the detector returned None
   */
  function run(job, timeoutMs = 10000) {
    return request({
      type: 'run', fs: job.fs, bufSize: job.bufSize, data: job.data,
    }, timeoutMs, [job.data.buffer])
      .then(m => ({ chars: m.chars, ms: m.ms }));
  }

  return {
    start, compile, run, restart,
    isReady: () => ready,
    isBusy: () => busy,
    isBooting: () => booting,
  };
})();
