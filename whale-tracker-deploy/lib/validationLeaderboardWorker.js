const { parentPort } = require('worker_threads');
const { selectDeepCandidates } = require('./whaleValidation');
async function main() {
  const response = await fetch('https://stats-data.hyperliquid.xyz/Mainnet/leaderboard', { signal: AbortSignal.timeout(30000) });
  if (!response.ok) throw new Error(`排行榜读取失败 HTTP ${response.status}`);
  const limit = 64 * 1024 * 1024;
  if (Number(response.headers.get('content-length')) > limit) throw new Error('排行榜数据超过读取上限');
  const chunks = []; let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > limit) throw new Error('排行榜数据超过读取上限');
    chunks.push(Buffer.from(chunk));
  }
  const data = JSON.parse(Buffer.concat(chunks, size).toString('utf8'));
  parentPort.postMessage(selectDeepCandidates(data.leaderboardRows));
}
main().catch(err => parentPort.postMessage({error: err.message || '排行榜读取失败'}));
