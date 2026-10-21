// Main-thread client for the CMDPRO shell engine.
// The engine runs in a module Web Worker so runaway commands can never freeze
// the UI; a hung worker is terminated and transparently respawned.

// Commands already stop themselves after ~2.5 s per run (see judge.js); these are only a safety
// net for a wedged worker (say, catastrophic regex backtracking inside a single RegExp call).
// Judging runs a command up to twice (plus the reference on fresh random data), so it gets more.
const DEFAULT_TIMEOUT = 6000;
const JUDGE_TIMEOUT = 12000;

export function createEngine({ timeoutMs = DEFAULT_TIMEOUT } = {}) {
  let worker = null;
  let inline = null;          // fallback: engine core on the main thread
  let seq = 0;
  const pending = new Map();
  let readyResolve;
  const ready = new Promise(r => { readyResolve = r; });
  let reconActive = false;

  function spawn() {
    try {
      worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
    } catch {
      worker = null;
    }
    if (!worker) return startInline();
    worker.onmessage = (e) => {
      const { id, ok, result, error } = e.data || {};
      const p = pending.get(id);
      if (!p) return;
      pending.delete(id);
      clearTimeout(p.timer);
      ok ? p.resolve(result) : p.reject(new Error(error));
    };
    worker.onerror = (e) => {
      // Module workers unsupported (or failed to load): fall back to inline.
      if (!inline) { e.preventDefault?.(); worker.terminate(); worker = null; startInline(); }
    };
    call('init', {}, 15000).then(() => readyResolve(), () => { /* onerror path handles fallback */ });
  }

  async function startInline() {
    const mod = await import('./judge.js');
    inline = new mod.EngineCore();
    await inline.init();
    for (const [id, p] of pending) {
      pending.delete(id);
      clearTimeout(p.timer);
      Promise.resolve().then(() => inline.dispatch(p.op, p.args)).then(p.resolve, p.reject);
    }
    readyResolve();
  }

  function call(op, args, ms) {
    if (inline) return Promise.resolve().then(() => inline.dispatch(op, args));
    const id = ++seq;
    return new Promise((resolve, reject) => {
      const p = { resolve, reject, op, args, timer: null };
      if (ms) {
        p.timer = setTimeout(() => {
          pending.delete(id);
          // Kill the stuck worker and start a fresh one.
          try { worker && worker.terminate(); } catch {}
          for (const [, other] of pending) { clearTimeout(other.timer); other.reject(new Error('engine restarted')); }
          pending.clear();
          reconActive = false;
          spawn();
          resolve({ timedOut: true });
        }, ms);
      }
      pending.set(id, p);
      worker.postMessage({ id, op, args });
    });
  }

  spawn();

  const killedMsg = (ms) => `cmdpro: command killed after ${(ms / 1000).toFixed(0)}s (infinite loop? waiting for input?)\n`;

  return {
    ready,
    async judge(challengeId, cmd, opts = {}) {
      await ready;
      const t0 = performance.now();
      const limit = Math.max(timeoutMs, JUDGE_TIMEOUT);
      const r = await call('judge', { challengeId, cmd, seed: opts.seed ?? Math.floor(Math.random() * 1e6) }, limit);
      if (r.timedOut) return { correct: false, output: killedMsg(limit), reason: 'timeout', exitCode: 137, ms: performance.now() - t0, timedOut: true };
      return { ...r, ms: performance.now() - t0, timedOut: false };
    },
    async reconStart(challengeId) { await ready; reconActive = true; return call('reconStart', { challengeId }, timeoutMs); },
    async reconExec(cmd) {
      await ready;
      if (!reconActive) return { output: 'cmdpro: recon session expired, type `recon` to start a new one\n', exitCode: 1, cwd: '', reconLost: true };
      const r = await call('reconExec', { cmd }, timeoutMs);
      if (r.timedOut) return { output: killedMsg(timeoutMs) + 'cmdpro: recon sandbox was reset\n', exitCode: 137, cwd: '', reconLost: true, timedOut: true };
      return r;
    },
    async reconStop() { await ready; reconActive = false; return call('reconStop', {}, timeoutMs); },
    async complete(challengeId, line, cursor, { recon = false } = {}) { await ready; const r = await call('complete', { challengeId, line, cursor, recon }, 2000); return r.timedOut ? { start: cursor, end: cursor, matches: [] } : r; },
    async tree(challengeId) { await ready; return call('tree', { challengeId }, timeoutMs); },
    async readFile(challengeId, path) { await ready; return call('readFile', { challengeId, path }, timeoutMs); },
    async isIncomplete(line) { await ready; const r = await call('isIncomplete', { line }, 2000); return r && r.timedOut ? false : r; },
    get recon() { return reconActive; },
  };
}
