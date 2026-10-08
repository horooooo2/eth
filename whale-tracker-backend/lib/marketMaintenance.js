const { AsyncLocalStorage } = require('node:async_hooks');
const context = new AsyncLocalStorage();
const revision = Symbol('market-generation');
let paused = false, generation = 0;
function assertWritable(expected) {
  const origin = context.getStore();
  if (paused || (origin !== undefined && origin !== generation) || (expected !== undefined && expected !== generation)) {
    const error = new Error('市场数据正在重置，请稍后重试');
    error.code = 'MARKET_RESET'; error.status = 503;
    throw error;
  }
}
module.exports = {
  revision, assertWritable,
  isPaused: () => paused,
  generation: () => generation,
  begin() { paused = true; generation++; },
  resume() { generation++; paused = false; },
  runCollection(fn) {
    // Nested collectors must keep the generation of their original request.
    return context.run(context.getStore() ?? generation, fn);
  },
};
