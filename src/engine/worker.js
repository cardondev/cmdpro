// Module worker hosting the CMDPRO shell engine.
import { EngineCore } from './judge.js';

const core = new EngineCore();

self.onmessage = async (e) => {
  const { id, op, args } = e.data || {};
  try {
    const result = await core.dispatch(op, args || {});
    self.postMessage({ id, ok: true, result });
  } catch (err) {
    self.postMessage({ id, ok: false, error: String((err && err.message) || err) });
  }
};
