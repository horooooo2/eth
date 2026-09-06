/**
 * 本机可访问 OKX 时：刷新并推送到境内服务器缓存。
 * 用法：
 *   node scripts/push-okx-cache.js http://43.143.207.156
 *   node scripts/push-okx-cache.js http://43.143.207.156 --token=xxx
 *   set OKX_PUSH_URL=http://43.143.207.156 && node scripts/push-okx-cache.js
 */
const path = require('path');
const axios = require('axios');

const ROOT = path.join(__dirname, '..');
process.chdir(ROOT);

async function main() {
  const args = process.argv.slice(2);
  const urlArg = args.find((a) => !a.startsWith('-'));
  const tokenArg = args.find((a) => a.startsWith('--token='));
  const base = String(urlArg || process.env.OKX_PUSH_URL || '')
    .trim()
    .replace(/\/$/, '');
  if (!base) {
    console.error('请指定服务器地址，例如: node scripts/push-okx-cache.js http://43.143.207.156');
    process.exit(1);
  }
  const token = String(
    (tokenArg && tokenArg.slice('--token='.length)) || process.env.OKX_SEED_TOKEN || '',
  ).trim();

  const { refreshOkxDashboard, getOkxStatus } = require('../lib/okxCopyTrading');
  console.log('[push] refreshing OKX locally…', getOkxStatus());
  const data = await refreshOkxDashboard();
  if (!data?.traders?.length) {
    throw new Error('本机刷新未拿到交易员');
  }
  console.log(
    `[push] local ok traders=${data.traders.length} opens=${data.opens?.length || 0} positions=${data.positions?.length || 0}`,
  );

  const seedUrl = `${base}/api/okx/seed`;
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers['x-okx-seed-token'] = token;

  const { data: resp } = await axios.post(seedUrl, data, {
    headers,
    timeout: 120_000,
    maxBodyLength: 20 * 1024 * 1024,
  });
  console.log('[push] seeded', JSON.stringify(resp));
}

main().catch((err) => {
  console.error('[push] failed:', err.response?.data || err.message);
  process.exit(1);
});
