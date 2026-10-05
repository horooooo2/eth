type Candle = { t: number; o: number; h: number; l: number; c: number; v: number };

export function readCsv(text: string): string[][] {
  const rows: string[][] = []; let row: string[] = []; let cell = ''; let quoted = false;
  const normalized = text.replace(/^\uFEFF/, '');
  for (let i = 0; i < normalized.length; i += 1) {
    const ch = normalized[i];
    if (ch === '"') { if (quoted && normalized[i + 1] === '"') { cell += '"'; i += 1; } else quoted = !quoted; }
    else if (!quoted && (ch === ',' || ch === '\t')) { row.push(cell.trim()); cell = ''; }
    else if (!quoted && (ch === '\n' || ch === '\r')) { if (ch === '\r' && normalized[i + 1] === '\n') i += 1; row.push(cell.trim()); if (row.some(Boolean)) rows.push(row); row = []; cell = ''; }
    else cell += ch;
  }
  row.push(cell.trim()); if (row.some(Boolean)) rows.push(row); return rows;
}
export function parseTime(value: string): number {
  const n = Number(value);
  if (value && Number.isFinite(n)) return n < 100_000_000_000 ? n * 1000 : n;
  const parsed = Date.parse(value); if (!Number.isFinite(parsed)) throw new Error(`无法识别时间：${value}`); return parsed;
}
export function indexMap(headers: string[], aliases: string[], fallback: number): number { const found = headers.findIndex((h) => aliases.includes(h.trim().toLowerCase())); return found >= 0 ? found : fallback; }
export function parseCandles(text: string, intervalMs = 60_000, minimum = 1200): Candle[] {
  const rows = readCsv(text); if (!rows.length) throw new Error('文件没有有效数据');
  const heads = rows[0].map((x) => x.trim().toLowerCase()); const hasHead = ['timestamp', 'time', 'datetime', 'open_time', 'open time', 'open_time_utc', 'open_time_ms'].some((h) => heads.includes(h));
  if (hasHead && new Set(heads).size !== heads.length) throw new Error('存在重复列名，请先检查 CSV 表头');
  const data = hasHead ? rows.slice(1) : rows;
  const idx = hasHead ? { t: indexMap(heads, ['timestamp', 'time', 'datetime', 'open_time', 'open time', 'open_time_utc', 'open_time_ms'], 0), o: indexMap(heads, ['open', 'o'], 1), h: indexMap(heads, ['high', 'h'], 2), l: indexMap(heads, ['low', 'l'], 3), c: indexMap(heads, ['close', 'c'], 4), v: indexMap(heads, ['volume', 'vol', 'v'], 5) } : { t: 0, o: 1, h: 2, l: 3, c: 4, v: 5 };
  const out = data.map((r, i) => {
    const c = { t: parseTime(r[idx.t]), o: Number(r[idx.o]), h: Number(r[idx.h]), l: Number(r[idx.l]), c: Number(r[idx.c]), v: Number(r[idx.v] || 0) };
    if (![c.t, c.o, c.h, c.l, c.c, c.v].every(Number.isFinite) || c.o <= 0 || c.h <= 0 || c.l <= 0 || c.c <= 0 || c.v < 0 || c.h < Math.max(c.o, c.c, c.l) || c.l > Math.min(c.o, c.c, c.h)) throw new Error(`第 ${i + (hasHead ? 2 : 1)} 行K线数据无效`);
    if (!Number.isInteger(c.t) || c.t % intervalMs !== 0) throw new Error(`第 ${i + (hasHead ? 2 : 1)} 行时间未对齐周期边界`);
    return c;
  }).sort((a, b) => a.t - b.t);
  if (out.length < minimum) throw new Error(`${intervalMs === 60_000 ? '分钟' : '小时'}K线至少需要 ${minimum.toLocaleString()} 根`);
  if (out.some((x, i) => i > 0 && x.t === out[i - 1].t)) throw new Error('K线存在重复时间戳，请先清理后重新导入。');
  if (out.some((x, i) => i > 0 && x.t - out[i - 1].t !== intervalMs)) throw new Error(`发现缺失${intervalMs === 60_000 ? '分钟' : '小时'}。请导入连续K线，避免检测结果失真。`);
  return out;
}
export function guessSymbol(fileName: string, text: string): string {
  const ignored = new Set(['TRADFI', 'KLINE', 'KLINES', 'CANDLE', 'CANDLES', 'MINUTE', 'MINUTES', 'DATA', 'MARKET', 'PRICE', 'CSV', 'ONE', 'MY', 'RAW', 'HISTORICAL', 'EXPORT', 'REPLAY', 'BINANCE', 'OKX', 'BYBIT', '1M', '1MIN', '1MINUTE']);
  const tokens = fileName.toUpperCase().split(/[^A-Z0-9]+/).filter(Boolean);
  const filenameSymbol = tokens.find((token) => /^[A-Z][A-Z0-9]{1,19}$/.test(token) && !ignored.has(token) && !/^\d{6,8}$/.test(token));
  if (filenameSymbol) return filenameSymbol;
  const firstTwoLines = text.replace(/^\uFEFF/, '').split(/\r?\n/, 2);
  const csvStart = readCsv(firstTwoLines.join('\n'));
  const firstLine = csvStart[0]?.map((value) => value.trim().toLowerCase()) || [];
  const symbolColumn = firstLine.findIndex((value) => ['symbol', 'ticker', 'instrument', 'contract'].includes(value));
  if (symbolColumn >= 0) {
    const row = csvStart[1]; const value = row?.[symbolColumn]?.trim().toUpperCase();
    if (value && /^[A-Z][A-Z0-9._:-]{0,29}$/.test(value)) return value;
  }
  return '';
}
export function embeddedFunding(text: string) {
  const rows = readCsv(text), headers = rows[0]?.map(h => h.toLowerCase()) || [];
  const rate = headers.findIndex(h => ['funding_rate', 'fundingrate'].includes(h));
  if (rate < 0) return null;
  const time = indexMap(headers, ['timestamp', 'time', 'datetime', 'open_time', 'open_time_ms', 'open_time_utc'], 0);
  const price = headers.findIndex(h => ['mark_price', 'markprice', 'funding_price'].includes(h));
  return parseFunding('timestamp,fundingRate,mark_price\n' + rows.slice(1).filter(r => r[rate]?.trim() && Number(r[rate]) !== 0).map(r => `${r[time]},${r[rate]},${price >= 0 ? r[price] : ''}`).join('\n'));
}
export function parseFunding(text: string): { t: number; rate: number; price?: number }[] {
  const rows = readCsv(text); if (!rows.length) return [];
  const heads = rows[0].map((x) => x.trim().toLowerCase()); const timeAliases = ['timestamp', 'time', 'datetime', 'fundingtime', 'funding_time', 'funding_timestamp', 'fundingtimestamp', 'calctime', 'calc_time'];
  const hasHead = timeAliases.some((h) => heads.includes(h)) || ['fundingrate', 'funding_rate', 'rate'].some((h) => heads.includes(h));
  if (hasHead && new Set(heads).size !== heads.length) throw new Error('存在重复列名，请先检查 CSV 表头');
  const data = hasHead ? rows.slice(1) : rows;
  const ti = hasHead ? indexMap(heads, timeAliases, 0) : 0;
  const ri = hasHead ? indexMap(heads, ['fundingrate', 'funding_rate', 'rate'], 1) : 1;
  const pi = heads.findIndex(h => ['mark_price', 'markprice', 'funding_price'].includes(h));
  const parsed = data.map((r, i) => { const price = pi >= 0 && r[pi]?.trim() ? Number(r[pi]) : undefined; if (price !== undefined && !(Number.isFinite(price) && price > 0)) throw new Error(`第 ${i + 2} 行资金费参考价无效`); const t = parseTime(r[ti]); const rate = Number(r[ri]); if (!r[ri]?.trim()) throw new Error(`第 ${i + (hasHead ? 2 : 1)} 行缺少资金费率`); if (!Number.isFinite(t) || !Number.isFinite(rate)) throw new Error(`第 ${i + (hasHead ? 2 : 1)} 行资金费率无效`); return { t, rate, ...(price !== undefined ? { price } : {}) }; }).sort((a, b) => a.t - b.t);
  if (parsed.some((x, i) => i > 0 && x.t === parsed[i - 1].t)) throw new Error('资金费文件存在重复时间戳，请先清理后重新导入。');
  return parsed;
}
