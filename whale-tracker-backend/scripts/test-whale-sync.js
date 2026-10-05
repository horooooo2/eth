'use strict';
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const files = [
  'test_event_atomicity.js', 'test_state_commits.js', 'test_state_stream.js',
  'test_whale_sync_integration.js', 'test_realtime_commit_failure.js', 'test_whale_retention.js',
  'test_whale_open_classification.js', 'test_resonance_server.js',
  'test_whale_page_location.js', 'test_whale_batch_pagination.js', 'test_backend_guards.js',
];
for (const file of files) {
  const result = spawnSync(process.execPath, [path.join(root, 'tests', file)], { cwd: root, stdio: 'inherit' });
  if (result.error) { console.error(result.error.message); process.exit(1); }
  if (result.status !== 0) process.exit(result.status || 1);
}
