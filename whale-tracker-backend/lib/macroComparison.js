'use strict';
const { fork } = require('node:child_process');
const path = require('node:path');
const { createStore } = require('./macroComparisonStore');
const { RULE_VERSION, DOMINANCE, MIN_WHALES } = require('./macroComparisonRules');
let store, timer, collectionTimer, collecting = null, active = null, generation = 0;
let summary = { BTC:{eligible:0,matches:0,excluded:0,rate:null},ETH:{eligible:0,matches:0,excluded:0,rate:null} };
let runtime = { collecting:false,running:false,lastCollectedAt:null,lastComputeMs:null,error:'' };
let recentWindows = [], dirtyWindows = new Set();
function markTradesChanged(trades) {
  // Called after a successful fact commit. Only mark an in-memory job; no reads or writes on the ingestion path.
  for (const trade of trades) {
    if (!['BTC','ETH'].includes(String(trade.asset || trade.assetLabel || '').toUpperCase())) continue;
    for (const releaseAt of recentWindows) if (trade.time>=releaseAt-3600000 && trade.time<releaseAt) dirtyWindows.add(releaseAt);
  }
}
function getStore() {
  if (!store) store = createStore(process.env.MACRO_COMPARISON_PATH || path.join(path.dirname(require('./db').resolveDbPath()), 'macro-comparison.db'));
  return store;
}
function observe(events) {
  try { getStore().archive(events); return true; }
  catch (error) { runtime.error = `历史保存失败：${error.message}`; return false; }
}
function collect() {
  if (collecting) return collecting;
  runtime.collecting = true;
  collecting = (async () => {
    const data = await require('./calendar').getCalendar(false);
    if (!observe(data.events)) throw new Error(runtime.error);
    const pending = getStore().pendingActuals();
    if (pending.length) observe(await require('./calendarFeed').enrichMissingActuals(pending));
    summary = getStore().summary(); runtime.lastCollectedAt = Date.now(); runtime.error = '';
    recentWindows = getStore().repairable();
    for (const releaseAt of dirtyWindows) if (!recentWindows.includes(releaseAt)) dirtyWindows.delete(releaseAt);
  })().catch(error => { runtime.error = error.message; }).finally(() => { collecting = null; runtime.collecting = false; });
  return collecting;
}
async function runNext() {
  if (active || require('./marketMaintenance').isPaused()) return;
  for (const releaseAt of dirtyWindows) if (getStore().requestRevision(releaseAt)) dirtyWindows.delete(releaseAt);
  const at = Date.now(), job = getStore().nextJob(at); if (!job) return;
  const currentGeneration = generation, marketGeneration = require('./marketMaintenance').generation();
  const roster = job.roster || require('./config').getActiveWhales().filter(row => /^0x[0-9a-f]{40}$/i.test(row.address || '')).map(row => ({id:row.id,address:row.address.toLowerCase()}));
  getStore().running(job,at); runtime.running = true;
  let timeout, child;
  try {
    child = fork(require.resolve('./macroComparisonCompute'), [], {
      execArgv:['--max-old-space-size=128'],stdio:['ignore','ignore','ignore','ipc'],env:process.env,
    }); active = child;
    const result = await new Promise((resolve,reject) => {
      timeout = setTimeout(() => { child.kill(); reject(new Error('宏观对照计算超过30秒，已停止并等待重试')); },30000); timeout.unref?.();
      child.once('error',reject);
      child.once('message',message => message?.ok ? resolve(message.result) : reject(new Error(message?.error || '计算失败')));
      child.once('exit',code => { if (code !== 0) reject(new Error(`计算进程退出（${code}）`)); else reject(new Error('计算进程未返回结果')); });
      child.send({ database:require('./db').resolveDbPath(),releaseAt:job.releaseAt,mode:job.mode,roster,now:at,frozenEvidenceHash:job.frozenEvidenceHash });
    });
    if (generation !== currentGeneration) return;
    if (require('./marketMaintenance').isPaused() || marketGeneration !== require('./marketMaintenance').generation()) throw new Error('采集数据已重置，等待重新统计');
    getStore().commit(job,result); summary = getStore().summary(); runtime.lastComputeMs = Date.now()-at;
  } catch (error) {
    if (generation === currentGeneration) { getStore().fail(job,error.message); runtime.error = error.message; }
  } finally {
    clearTimeout(timeout); child?.kill(); if (active === child) active = null; runtime.running = false;
  }
}
function start() {
  if (timer) return;
  getStore(); summary = getStore().summary(); generation++;
  recentWindows = getStore().repairable();
  require('./sqliteStore').setMacroComparisonObserver(markTradesChanged);
  void collect();
  timer = setInterval(() => void runNext().catch(error => {runtime.error=error.message;}),2000); timer.unref();
  collectionTimer = setInterval(() => void collect(),60000); collectionTimer.unref();
}
function stop() {
  generation++; clearInterval(timer); clearInterval(collectionTimer); timer = null; collectionTimer = null; active?.kill();
  require('./sqliteStore').setMacroComparisonObserver(null);
}
function snapshot(query = {}) {
  const page = Number(query.page || 1), family = String(query.family || 'ALL');
  if (!Number.isSafeInteger(page) || page < 1 || page > 100000 || !['ALL','CPI','CORE_CPI','PCE','CORE_PCE','NFP'].includes(family)) {
    const error = new Error('无效的历史筛选参数'); error.status = 400; throw error;
  }
  return {...getStore().list({page,family}),summary,runtime:{...runtime},ruleVersion:RULE_VERSION,
    rules:{dominance:DOMINANCE,minWhales:MIN_WHALES,windowMinutes:60,basis:'atomic-open-increase',summaryBasis:'release-batch-and-coin'},
    storage:'sqlite-independent-history',scope:'monitored-hyperliquid-accounts'};
}
module.exports = { start,stop,observe,snapshot,collect,runNext };
