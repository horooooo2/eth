'use strict';
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const files = [
  'test_radar_stream.js',
  'test_health_lightweight.js',
  'test_stock_focus.js',
  'test_radar_disabled.js',
  'test_runtime_module_graph.js', 'test_radar_long_trend.js',
  'test_market_brief_analysis.js',
  'test_resonance_retired.js', 'test_observation_scope.js',
  'test_socket_send.js',
  'test_observation_compute.js',
  'test_observation_blocks.js',
  'test_observation_failures.js',
  'test_performance_paths.js',
  'test_fill_fact_memory.js', 'test_fill_fact_semantics.js', 'test_whale_observations.js',
  'test_strategy_shadow.js',
  'test_position_detail_fast.js',
  "test_audit_repairs.js",
  'test_radar_freshness.js', 'test_request_budget.js', 'test_data_quality.js', 'test_ws_health.js', 'test_event_atomicity.js', 'test_state_commits.js', 'test_state_stream.js',
  'test_whale_sync_integration.js', 'test_realtime_commit_failure.js', 'test_whale_retention.js',
  'test_whale_open_classification.js',
  'test_whale_page_location.js', 'test_whale_batch_pagination.js', 'test_backend_guards.js',
];
for (const file of files) {
  const result = spawnSync(process.execPath, [path.join(root, 'tests', file)], { cwd: root, stdio: 'inherit' });
  if (result.error) { console.error(result.error.message); process.exit(1); }
  if (result.status !== 0) process.exit(result.status || 1);
}
