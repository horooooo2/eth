export const MAINSTREAM_ORDER = [
  'BTC', 'ETH', 'SOL', 'BNB', 'XRP', 'DOGE', 'ADA', 'AVAX', 'LINK', 'DOT', 'UNI', 'AAVE',
  'LTC', 'SUI', 'APT', 'TON', 'HYPE', 'NEAR', 'ARB', 'OP', 'PEPE', 'WIF', 'FIL', 'ATOM',
  'BCH', 'ETC', 'TRX', 'POL', 'MATIC', 'SHIB', 'ENA', 'BONK', 'KBONK', 'WLD', 'INJ', 'SEI',
  'TIA', 'ONDO',
] as const;

const MAINSTREAM = new Set<string>(MAINSTREAM_ORDER);

export function isExoticAsset(coin: string) {
  const value = String(coin || '');
  return /^@\d+$/i.test(value) || value.includes(':');
}

export function isMainstreamAsset(coin: string) {
  const value = String(coin || '').toUpperCase();
  return MAINSTREAM.has(value) || MAINSTREAM.has(value.replace(/^K/, ''));
}

function normalizeAssetKey(coin: string) {
  return String(coin || '').toUpperCase().replace(/^K/, '');
}

/** 与转账列表一致：主流币 + 合约 exotic 才进入筛选项 */
export function isSelectableAsset(coin: string) {
  return isMainstreamAsset(coin) || isExoticAsset(coin);
}

export function compareSelectableAssets(a: string, b: string) {
  const exoticA = isExoticAsset(a);
  const exoticB = isExoticAsset(b);
  if (exoticA !== exoticB) return exoticA ? 1 : -1;
  const ia = MAINSTREAM_ORDER.indexOf(normalizeAssetKey(a) as (typeof MAINSTREAM_ORDER)[number]);
  const ib = MAINSTREAM_ORDER.indexOf(normalizeAssetKey(b) as (typeof MAINSTREAM_ORDER)[number]);
  if (ia >= 0 && ib >= 0) return ia - ib;
  if (ia >= 0) return -1;
  if (ib >= 0) return 1;
  return String(a).localeCompare(String(b));
}

export function displayAsset(coin: string, label?: string) {
  const raw = String(coin || '');
  const pretty = String(label || '').trim();
  if (pretty && pretty !== raw) return pretty;
  return raw || '--';
}

export function hyperliquidExplorer(address: string) {
  const user = String(address || '').trim();
  if (!user || user === 'Hyperliquid') return 'https://app.hyperliquid.xyz/';
  return `https://app.hyperliquid.xyz/explorer/address/${user}`;
}

export function hyperliquidTrade(coin: string) {
  const value = String(coin || '').trim();
  if (!value) return 'https://app.hyperliquid.xyz/trade';
  return `https://app.hyperliquid.xyz/trade/${encodeURIComponent(value)}`;
}
