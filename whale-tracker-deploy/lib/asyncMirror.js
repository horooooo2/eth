const fs = require('node:fs/promises');
// One writer per destination, at most one pending replacement. SQLite remains authoritative.
function createMirrorWriter(pathFor, onError = err => console.warn('[cache mirror]', err.message)) {
  const entries = new Map();
  async function* chunks(data) {
    yield `{"updatedAt":${Date.now()},"data":{`;
    let first = true, count = 0;
    for (const [key, value] of Object.entries(data)) {
      if (value === undefined) continue;
      if (!first) yield ','; first = false;
      yield JSON.stringify(key) + ':';
      if (!Array.isArray(value)) { yield JSON.stringify(value); continue; }
      yield '[';
      for (let i = 0; i < value.length; i++) {
        if (i) yield ',';
        yield JSON.stringify(value[i]) ?? 'null';
        if (++count % 128 === 0) await new Promise(resolve => setImmediate(resolve));
      }
      yield ']';
    }
    yield '}}';
  }
  function entryFor(name) {
    if (!entries.has(name)) entries.set(name, { data: null, generation: 0, remove: false, pending: null });
    return entries.get(name);
  }
  function run(name, entry) {
    if (entry.pending) return entry.pending;
    entry.pending = (async () => {
      const target = pathFor(name), temporary = `${target}.${process.pid}.mirror.tmp`;
      while (entry.data || entry.remove) {
        if (entry.remove) {
          entry.remove = false;
          await fs.unlink(target).catch(err => { if (err.code !== 'ENOENT') throw err; });
          continue;
        }
        const data = entry.data, generation = entry.generation; entry.data = null;
        try {
          // AsyncIterable bounds serialization and write buffers; atomic rename publishes only complete JSON.
          await fs.writeFile(temporary, chunks(data), { encoding: 'utf8' });
          if (generation === entry.generation) await fs.rename(temporary, target);
        } finally { await fs.unlink(temporary).catch(() => {}); }
      }
    })().catch(err => {
      // A failed path/write must not create an immediate retry loop. A later commit retries.
      entry.data = null; entry.remove = false; onError(err);
    }).finally(() => {
      entry.pending = null;
      if (entry.data || entry.remove) run(name, entry);
    });
    return entry.pending;
  }
  return {
    write(name, data) { const e = entryFor(name); e.data = data; return run(name, e); },
    clear(name) { const e = entryFor(name); e.data = null; e.generation++; e.remove = true; return run(name, e); },
    async flush(name) { const e = entryFor(name); while (e.pending) await e.pending; },
  };
}
module.exports = { createMirrorWriter };
