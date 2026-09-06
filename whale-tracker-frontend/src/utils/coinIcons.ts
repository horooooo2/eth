/** OKX / 公共 CDN 币种图标 */

const OKX_ICON = (coin: string) =>
  `https://www.okx.com/cdn/oksupport/asset/currency/icon/${coin.toLowerCase()}.png`;

const JSDELIVR_ICON = (coin: string) =>
  `https://cdn.jsdelivr.net/gh/spothq/cryptocurrency-icons@master/32/color/${coin.toLowerCase()}.png`;

/** 归一化币种符号（BTC-USDT-SWAP → BTC） */
export function normalizeCoinSymbol(raw: string | undefined | null) {
  const s = String(raw || '')
    .trim()
    .toUpperCase()
    .replace(/-SWAP$/i, '')
    .replace(/-USDT$/i, '')
    .replace(/USDT$/i, '');
  if (!s) return '';
  const head = s.split(/[-_/]/)[0] || '';
  return head.replace(/[^A-Z0-9]/g, '');
}

export function coinIconCandidates(raw: string | undefined | null) {
  const coin = normalizeCoinSymbol(raw);
  if (!coin) return [] as string[];
  return [OKX_ICON(coin), JSDELIVR_ICON(coin)];
}

export function coinIconUrl(raw: string | undefined | null) {
  return coinIconCandidates(raw)[0] || '';
}
