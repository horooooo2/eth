/**
 * 进程启动时间（用于 data 看板运行时长）
 */
const STARTED_AT = Date.now();

function getStartedAt() {
  return STARTED_AT;
}

function getUptimeMs() {
  return Date.now() - STARTED_AT;
}

module.exports = {
  STARTED_AT,
  getStartedAt,
  getUptimeMs,
};
