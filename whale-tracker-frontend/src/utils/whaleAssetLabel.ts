import { isKnownTradfiUnderlying } from './contractDetails';
// Presentation only: API requests and position keys retain their full DEX namespace.
const names: Record<string, string> = {
  SNDK: '闪迪', WDC: '西部数据', TSLA: '特斯拉', NVDA: '英伟达', INTC: '英特尔',
  META: 'Meta', AAPL: '苹果', MSFT: '微软', ORCL: '甲骨文', GOOGL: '谷歌', GOOG: '谷歌',
  AMD: '超威半导体', MU: '美光', AMZN: '亚马逊', NFLX: '奈飞', AVGO: '博通',
  DELL: '戴尔', IBM: 'IBM', QCOM: '高通', ARM: '安谋', ASML: '阿斯麦',
  BABA: '阿里巴巴', COIN: 'Coinbase', MSTR: 'Strategy', PLTR: 'Palantir',
  COST: '开市客', TSM: '台积电', GOLD: '黄金', SILVER: '白银', COPPER: '铜',
  PLATINUM: '铂金', PALLADIUM: '钯金', CL: 'WTI原油', BRENTOIL: '布伦特原油', NATGAS: '天然气',
  SP500: '标普500指数', XYZ100: '纳指100指数', JP225: '日经225指数',
  EUR: '欧元', JPY: '日元', GBP: '英镑',
};

export function whaleAssetLabel(coin: string, fallback?: string) {
  const raw = String(coin || '');
  if (!raw.includes(':')) return fallback || raw;
  const ticker = raw.slice(raw.indexOf(':') + 1).toUpperCase();
  const name = names[ticker];
  return name ? `${ticker}（${name}）` : ticker;
}

export function whaleAssetOptionLabel(coin: string) {
  const label = whaleAssetLabel(coin);
  return coin.includes(':') ? `${label} · ${coin.split(':')[0]}` : label;
}

// Explicit aliases only; do not infer asset type from the DEX namespace.
export const whaleUnderlyingAliases: Record<string, string> = {
  GOLD: 'XAU', SILVER: 'XAG', PLATINUM: 'XPT', PALLADIUM: 'XPD',
  CL: 'WTI', BRENTOIL: 'BRENT',
};
export function isWhaleTradfi(coin: string) {
  const ticker = coin.split(':').pop()?.toUpperCase() || '';
  return isKnownTradfiUnderlying(whaleUnderlyingAliases[ticker] || ticker)
    || ['SP500', 'XYZ100', 'JP225', 'KR200', 'EUR', 'JPY', 'GBP', '2Y', '10Y', '30Y'].includes(ticker);
}
