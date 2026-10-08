const DAY = 86400000;
const GROUPS = { STOCK: '股票', INDEX_ETF: '指数 / ETF', METAL_ENERGY: '金属 / 能源', UNKNOWN: '待识别' };
const set = text => new Set(text.split(' '));
const funds = set('BITO BWET EWJ EWT EWY EWZ GDX IWM KODEX200 KORU KSTR MUU NVDL QQQ SMH SOXL SOXS SPY SQQQ TBT TMF TQQQ TSLL TZA URNM UVXY XBI XLE CSOPSAMSUNG2L CSOPSKHYNIX2L');
const commodities = set('XAU XAG XPT XPD COPPER CL WTI USOIL XTI BZ BRENT NATGAS');
const chineseAdrs = set('BABA PDD JD BIDU NTES TCOM NIO XPEV LI BILI TME TAL EDU ZTO YMM BEKE FUTU TIGR VIPS ATHM WB IQ DQ JKS LU QFIN');
const chineseStocks = set('BYD ZHONGJI CXMT UNITREE MINIMAX MOONSHOT ZHIPU KUAISHOU TENCENT XIAOMI MEITUAN POPMART');
const usStocks = set('AAOI AAPL ACN ADBE AKAM ALAB AMAT AMC AMD AMZN ANET APLD APP ARM ASML ASTS AVGO AXTI BE BMNR BRKB BX CAT CIEN COHR COIN COST CRCL CRDO CRML CRM CRWD CRWV CSCO CVNA DDOG DELL DIS DJT DKNG EBAY FLEX FLNC GEV GLW GME GOOGL GOOG GPRO GS GTLB HD HIMS HOOD HPE HUT IBM INTC IONQ IREN JPM KLAC KO LITE LLY LRCX MARA MCD MDB META MP MRK MRNA MRVL MSFT MSTR MU NBIS NET NFLX NKE NOK NOW NVDA NVO OKLO ONDS ORCL PANW PATH PLTR PYPL QCOM RDDT RIVN RKLB RUM SHOP SMCI SNDK SNOW SOFI SONY STRC TEAM TEM TER TSLA TSM TTWO TWST TXN UBER UNH USAR VKTX VRT VST V WDC WEN WMT ZM ZS');
const koreanStocks = set('SKHYNIX SAMSUNG SAMSUNGEM HYUNDAI NAVER LGELECTRONICS HANMI');

function classifyTradfi(symbol) {
  const base = String(symbol || '').replace(/USDT$/, '');
  const info = (assetGroup, stockMarket = null, liquidityExempt = false) => ({ assetGroup, stockMarket, liquidityExempt });
  if (funds.has(base)) return info('INDEX_ETF', null, true);
  if (commodities.has(base)) return info('METAL_ENERGY', null, true);
  if (/^HK\d{4,5}$/.test(base)) return info('STOCK', 'HK', true);
  if (chineseAdrs.has(base)) return info('STOCK', 'CHINA_ADR', true);
  if (chineseStocks.has(base)) return info('STOCK', ['KUAISHOU', 'TENCENT', 'XIAOMI', 'MEITUAN', 'POPMART'].includes(base) ? 'HK' : 'CN', true);
  if (usStocks.has(base)) return info('STOCK', 'US');
  if (koreanStocks.has(base)) return info('STOCK', 'KR');
  // Unknown instruments stay visible until their underlying asset is confirmed.
  return info('UNKNOWN', null, true);
}

// Versioned calendars: do not assume unknown years/markets are weekday-only.
// NYSE: https://www.nyse.com/trade/hours-calendars
// KRX closure rules: https://global.krx.co.kr/contents/GLB/06/0606/0606030101/GLB0606030101T3.jsp
// Korean holidays: https://www.bok.or.kr/eng/main/contents.do?menuNo=400373
const holidays = {
  US: {
    2025: '01-01 01-09 01-20 02-17 04-18 05-26 06-19 07-04 09-01 11-27 12-25',
    2026: '01-01 01-19 02-16 04-03 05-25 06-19 07-03 09-07 11-26 12-25',
    2027: '01-01 01-18 02-15 03-26 05-31 06-18 07-05 09-06 11-25 12-24',
    2028: '01-17 02-21 04-14 05-29 06-19 07-04 09-04 11-23 12-25',
  },
  KR: { 2026: '01-01 02-16 02-17 02-18 03-02 05-01 05-05 05-25 06-03 07-17 08-17 09-24 09-25 10-05 10-09 12-25 12-31' },
};
const formats = {
  US: new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }),
  KR: new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit' }),
};
function tradingDay(day, market) {
  if (!formats[market]) return null;
  // Binance daily bars use UTC. Anchor inside the underlying's regular session
  // to obtain its trading-date label; do not interpret 00:00 UTC as US midnight.
  const date = formats[market].format(new Date(day + (market === 'US' ? 18 : 3) * 3600000));
  const calendar = holidays[market][date.slice(0, 4)];
  if (!calendar) return null;
  const weekday = new Date(date + 'T12:00:00Z').getUTCDay();
  return weekday !== 0 && weekday !== 6 && !calendar.split(' ').includes(date.slice(5));
}

function liquidityFor(symbol, bars, asOf, minimum = 5000000) {
  const classification = classifyTradfi(symbol);
  const end = Math.floor(asOf / DAY) * DAY;
  const result = { version: 1, asOf: end, minimum, averageQuoteVolume: null, sampleDays: 0, filtered: false, status: 'exempt' };
  if (classification.liquidityExempt) return result;
  const dates = [];
  for (let day = end - DAY; dates.length < 20 && day >= end - 91 * DAY; day -= DAY) {
    const open = tradingDay(day, classification.stockMarket);
    if (open == null) return { ...result, status: 'calendar-unavailable' };
    if (open) dates.push(day);
  }
  const byDay = new Map();
  for (const bar of bars) {
    if (!Number.isFinite(bar.openTime) || bar.closeTime !== bar.openTime + DAY - 1 || bar.closeTime >= end) continue;
    if (byDay.has(bar.openTime) && byDay.get(bar.openTime) !== bar.quoteVolume) return { ...result, status: 'conflicting-data' };
    byDay.set(bar.openTime, bar.quoteVolume);
  }
  const values = dates.map(date => byDay.get(date));
  const valid = values.filter(value => Number.isFinite(value) && value >= 0);
  if (dates.length !== 20 || valid.length !== 20) return { ...result, sampleDays: valid.length, status: 'insufficient' };
  const averageQuoteVolume = valid.reduce((sum, value) => sum + value, 0) / 20;
  if (!Number.isFinite(averageQuoteVolume)) return { ...result, status: 'invalid-data' };
  return { ...result, averageQuoteVolume, sampleDays: 20, filtered: averageQuoteVolume < minimum, status: 'ready' };
}
module.exports = { classifyTradfi, liquidityFor, tradingDay, GROUPS };
