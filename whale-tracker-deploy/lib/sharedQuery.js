// Share concurrent reads and retain a bounded number of short-lived results.
function createSharedQuery({ ttlMs = 3000, maxEntries = 32 } = {}) {
  const cache = new Map(), pending = new Map();
  return async function read(key, build) {
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < ttlMs) return hit.value;
    if (pending.has(key)) return pending.get(key);
    const task = Promise.resolve().then(build).then(value => {
      cache.delete(key);
      cache.set(key, { value, at: Date.now() });
      while (cache.size > maxEntries) cache.delete(cache.keys().next().value);
      return value;
    }).finally(() => pending.delete(key));
    pending.set(key, task);
    return task;
  };
}
module.exports = { createSharedQuery };
