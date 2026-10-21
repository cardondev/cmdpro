// Lazily-created singleton engine client (bash emulator in a worker).
import { createEngine } from '../engine/client.js';

let inst = null;
export function engine() {
  if (!inst) inst = createEngine();
  return inst;
}
