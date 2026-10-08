// Binance contract codes and underlying exchange tickers are distinct.
// US listings verified against TradingView's public scanner on 2026-10-09:
// https://scanner.tradingview.com/america/scan
// Asian listings and reference markets: https://scanner.tradingview.com/global/scan
const underlyingSymbols: Record<string, string> = {
  HK1810: 'HKEX-1810', XIAOMI: 'HKEX-1810', KUAISHOU: 'HKEX-1024',
  TENCENT: 'HKEX-700', HK0700: 'HKEX-700', MEITUAN: 'HKEX-3690',
  HK0992: 'HKEX-992', HK0625: 'HKEX-625', POPMART: 'HKEX-9992', BYD: 'HKEX-1211',
  MINIMAX: 'HKEX-100', ZHIPU: 'HKEX-2513', ZHONGJI: 'SZSE-300308',
  CSOPSKHYNIX2L: 'HKEX-7709', CSOPSAMSUNG2L: 'HKEX-7747',
  SKHYNIX: 'KRX-000660', SAMSUNG: 'KRX-005930', SAMSUNGEM: 'KRX-009150',
  HYUNDAI: 'KRX-005380', NAVER: 'KRX-035420', LGELECTRONICS: 'KRX-066570',
  HANMI: 'KRX-042700', KODEX200: 'KRX-069500', BRKB: 'NYSE-BRK.B',
  // Commodity references show the underlying market, not Binance contract prices.
  XAU: 'TVC-GOLD', XAG: 'TVC-SILVER', XPT: 'TVC-PLATINUM', XPD: 'TVC-PALLADIUM',
  CL: 'NYMEX-CL1!', WTI: 'NYMEX-CL1!', USOIL: 'NYMEX-CL1!', XTI: 'NYMEX-CL1!',
  BZ: 'NYMEX-BZ1!', BRENT: 'NYMEX-BZ1!', NATGAS: 'NYMEX-NG1!', COPPER: 'COMEX-HG1!',
  USDBRL: 'FX_IDC-USDBRL',
};
for (const ticker of [
  'AAOI AAPL ADBE AGPU AKAM ALAB AMAT AMD AMZN APLD APP ARM ASML ASTS AVGO AXTI BNC BOT',
  'BSP CBRS COIN COST CRDO CRML CRWD CRWV CSCO CYPH DDOG DJT DKNG EBAY FLEX FLNC FWDI GOOG',
  'GOOGL GPRO GTLB HOOD HUT INTC INTW IREN KLAC LITE LRCX MARA MDB META MRNA MRVL MSFT MSTR',
  'MU MUU MVLL NBIS NFLX NVDA NVDL ONDS PANW PAYP PDD PENG PLTR PYPL QCOM QQQ RIVN RKLB',
  'RUM SHAZ SHOP SKDD SKHY SKUU SMCI SMH SNDK SOFI SPCX SQQQ STRC TEAM TEM TER TQQQ TSLA',
  'TSLL TTWO TWST TXN USAR VKTX WDC WEN WMT ZM ZS',
].join(' ').split(' ')) {
  underlyingSymbols[ticker] = `NASDAQ-${ticker}`;
}
for (const ticker of [
  'ACN AMC ANET BABA BE BMNR BX CAT CIEN COHR CRCL CRM CVNA DELL DIS GEV GLW GME',
  'GS HD HIMS HPE IBM IONQ JPM KO LLY MCD MP MRK NET NKE NOK NOW NVO OKLO',
  'ORCL PATH RDDT SECZ SNOW SONY TSM UBER UNH V VRT VST XOM',
].join(' ').split(' ')) {
  underlyingSymbols[ticker] = `NYSE-${ticker}`;
}
for (const ticker of [
  'BITO BWET EWJ EWT EWY EWZ GDX IWM KORU KSTR SOXL SOXS SPY TBT TMF TZA URNM XBI',
  'XLE',
].join(' ').split(' ')) {
  underlyingSymbols[ticker] = `AMEX-${ticker}`;
}
for (const ticker of [
  'DRAM LYTE RAM SNXX STXX UVXY',
].join(' ').split(' ')) {
  underlyingSymbols[ticker] = `CBOE-${ticker}`;
}

export function contractDetails(symbol: string, assetType: string, name = '') {
  const normalized = symbol.trim().toUpperCase();
  if (!/^[A-Z0-9]{1,30}USDT$/.test(normalized)) return null;
  const contractUrl = `https://www.binance.com/zh-CN/futures/${normalized}`;
  if (assetType === 'CRYPTO') {
    return { href: contractUrl, title: '查看币安永续合约详情与走势' };
  }
  const base = normalized.slice(0, -4);
  const underlying = underlyingSymbols[base];
  if (underlying) {
    return { href: `https://cn.tradingview.com/symbols/${underlying}/`, title: `查看 ${name || base} 的标的介绍与参考走势（TradingView）` };
  }
  // New/private instruments may not have an underlying listing. Always provide
  // the actual contract page instead of guessing an exchange or launching search.
  return { href: contractUrl, title: '查看币安合约详情与走势（标的详情页尚未确认）' };
}
