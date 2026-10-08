// Explicit underlying symbols: Binance contract names are not exchange tickers.
const underlyingSymbols: Record<string, string> = {
  HK1810: 'HKEX-1810', XIAOMI: 'HKEX-1810', KUAISHOU: 'HKEX-1024',
  TENCENT: 'HKEX-700', HK0700: 'HKEX-700', MEITUAN: 'HKEX-3690',
  SKHYNIX: 'KRX-000660', KORU: 'AMEX-KORU',
};
for (const ticker of 'WDC NVDA AAPL MSFT AMZN AVGO AMD META SNDK TSLA INTC MU GOOGL GOOG NFLX ARM QCOM PLTR COIN HOOD ADBE COST DDOG ASML QQQ TQQQ SQQQ WMT SHOP'.split(' ')) {
  underlyingSymbols[ticker] = `NASDAQ-${ticker}`;
}
for (const ticker of 'BABA ORCL DELL IBM CRM UBER DIS NKE MCD SONY'.split(' ')) {
  underlyingSymbols[ticker] = `NYSE-${ticker}`;
}
for (const ticker of 'SOXL SOXS EWY EWJ SPY'.split(' ')) {
  underlyingSymbols[ticker] = `AMEX-${ticker}`;
}

export function contractDetails(symbol: string, assetType: string, name = '') {
  const normalized = symbol.trim().toUpperCase();
  if (!/^[A-Z0-9]{1,30}USDT$/.test(normalized)) return null;
  if (assetType === 'CRYPTO') {
    return { href: `https://www.binance.com/zh-CN/futures/${normalized}`, title: '查看币安永续合约详情与走势' };
  }
  const base = normalized.slice(0, -4);
  const underlying = underlyingSymbols[base];
  if (underlying) {
    return { href: `https://cn.tradingview.com/symbols/${underlying}/`, title: '查看对应股票 / ETF 的介绍与走势（TradingView）' };
  }
  // New or unrecognized contracts need discovery rather than a guessed exchange page.
  const query = `${base} ${name} 标的介绍 走势 TradingView`.trim();
  return { href: `https://www.google.com/search?q=${encodeURIComponent(query)}`, title: '查找标的介绍与走势（暂无已确认的详情页）' };
}
