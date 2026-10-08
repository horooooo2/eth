// Retry only transient read failures. Invalid queries and calculation errors
// must remain visible; all callers of the same statistics key share one retry.
import { formatRelativeAgo } from './format';
export type StatisticsFreshness = {
  asOf: number | null; inputVersion: number | null; currentInputVersion: number;
  pendingUpdates: boolean; refreshing: boolean; stale: boolean; error: string | null;
};
export function statisticsFreshnessText(value?: StatisticsFreshness, now = Date.now()): string {
  if (!value?.asOf) return '';
  return formatRelativeAgo(value.asOf, now);
}

export function statisticsErrorText(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/TIMEOUT|timed out|timeout/i.test(message)) return '请求超时';
  if (/GATEWAY_50[234]/.test(message)) return '服务暂时繁忙';
  if (/Network Error|Failed to fetch|ECONNRESET/i.test(message)) return '网络连接中断';
  return '服务读取失败';
}

export async function retryStatistics<T>(request: () => Promise<T>,
  wait: () => Promise<void> = () => new Promise(resolve => setTimeout(resolve, 1000))): Promise<T> {
  try { return await request(); }
  catch (error) {
    if (statisticsErrorText(error) === '服务读取失败') throw error;
    await wait();
    return request();
  }
}
