const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');

function runtimeFiles(root) {
  function walk(dir) {
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
      const file = path.join(dir, entry.name);
      return entry.isDirectory() ? walk(file) : /\.(?:js|cjs)$/.test(file) ? [file] : [];
    });
  }
  return [path.join(root, 'server.js'), ...walk(path.join(root, 'lib')), ...walk(path.join(root, 'routes'))];
}

for (const directory of ['whale-tracker-backend', 'whale-tracker-deploy']) {
  test(`${directory}: runtime local requires resolve after retired-code cleanup`, () => {
    const root = path.resolve(__dirname, '../..', directory);
    const files = runtimeFiles(root);
    if (directory === 'whale-tracker-backend') files.push(path.join(root, 'edgeone-handler.js'));
    const missing = [];
    for (const file of files) {
      const source = fs.readFileSync(file, 'utf8');
      const requireFromFile = createRequire(file);
      for (const match of source.matchAll(/require\s*\(\s*['"](\.\.?\/[^'"]+)['"]\s*\)/g)) {
        try { requireFromFile.resolve(match[1]); }
        catch { missing.push(`${path.relative(root, file)} -> ${match[1]}`); }
      }
    }
    assert.deepEqual(missing, []);
    // fork() uses filenames rather than require(), so check these entries too.
    for (const worker of ['statisticsComputeChild.js', 'observationComputeChild.js']) {
      assert.ok(fs.existsSync(path.join(root, 'lib', worker)), `${worker} must remain packaged`);
    }
  });
}
