import type { CoinMarket, MacroEvent, MarketsResponse } from '@/types';
import { formatPct, formatPrice } from '@/utils/format';

export type AnalysisTone = 'up' | 'down' | 'accent' | 'warn' | 'hold';

export interface AnalysisSpan {
  text: string;
  tone?: AnalysisTone;
}

export interface AnalysisBlock {
  title: string;
  paragraphs: AnalysisSpan[][];
}

export type CryptoMove = { pct: number; label: string } | null;
export type FedMarketItem = MarketsResponse['macro']['fed']['items'][number];
export type AnchorKind = 'dxy' | 'tnx' | 'fng';

function fngLabel(value: string) {
  if (value === 'Greed') return '贪婪';
  if (value === 'Fear') return '恐惧';
  if (value === 'Extreme Greed') return '极度贪婪';
  if (value === 'Extreme Fear') return '极度恐惧';
  if (value === 'Neutral') return '中性';
  return value || '中性';
}

function fngTone(value: number): AnalysisTone {
  if (value >= 70) return 'down';
  if (value >= 60) return 'warn';
  if (value <= 30) return 'up';
  if (value < 45) return 'accent';
  return 'hold';
}

function moveTone(label?: string): AnalysisTone {
  if (label === '偏多') return 'up';
  if (label === '偏空') return 'down';
  return 'hold';
}

function eventKind(title: string) {
  if (/ISM|PMI/.test(title)) return 'pmi';
  if (/ADP/.test(title)) return 'adp';
  if (/非农/.test(title)) return 'nfp';
  if (/JOLTS|职位空缺|Job Openings/i.test(title)) return 'jolts';
  if (/初请|Claims/i.test(title)) return 'claims';
  if (/失业/.test(title)) return 'unemp';
  if (/时薪/.test(title)) return 'wages';
  if (/休市|劳工节/.test(title)) return 'holiday';
  if (/回购/.test(title)) return 'repo';
  if (/PPI|欧央行/.test(title)) return 'ppi';
  if (/CPI/.test(title)) return 'cpi';
  if (/CLARITY/.test(title)) return 'clarity';
  if (/FOMC/.test(title)) return 'fomc';
  if (/日央行|四巫/.test(title)) return 'boj';
  if (/Upbit|开发者/.test(title)) return 'upbit';
  return 'generic';
}

function eventPaths(kind: string): AnalysisSpan[][] {
  const map: Record<string, AnalysisSpan[][]> = {
    pmi: [
      [{ text: '强于预期：', tone: 'down' }, { text: ' 加息概率上修，加密 ' }, { text: '承压', tone: 'down' }],
      [{ text: '符合预期：', tone: 'warn' }, { text: ' 横盘' }],
      [{ text: '弱于预期：', tone: 'up' }, { text: ' 加息概率回落，加密 ' }, { text: '反弹', tone: 'up' }],
    ],
    adp: [
      [{ text: '就业偏强：', tone: 'down' }, { text: ' 非农前加密 ' }, { text: '偏空震荡', tone: 'down' }],
      [{ text: '接近预期：', tone: 'warn' }, { text: ' 影响有限' }],
      [{ text: '就业偏弱：', tone: 'up' }, { text: ' 加密可能先 ' }, { text: '反弹', tone: 'up' }, { text: '，方向仍看非农' }],
    ],
    nfp: [
      [{ text: '明显强于预期：', tone: 'down' }, { text: ' 加息概率跳升，BTC ' }, { text: '下跌', tone: 'down' }],
      [{ text: '符合预期：', tone: 'warn' }, { text: ' 继续震荡，等 CPI' }],
      [{ text: '明显弱于预期：', tone: 'up' }, { text: ' 加息概率回落，BTC ' }, { text: '反弹', tone: 'up' }],
    ],
    jolts: [
      [{ text: '空缺偏多：', tone: 'down' }, { text: ' 就业仍热，加密 ' }, { text: '承压', tone: 'down' }],
      [{ text: '符合预期：', tone: 'warn' }, { text: ' 影响有限' }],
      [{ text: '空缺偏少：', tone: 'up' }, { text: ' 招工降温，加密 ' }, { text: '反弹', tone: 'up' }],
    ],
    claims: [
      [{ text: '初请偏低：', tone: 'down' }, { text: ' 就业仍强，偏 ' }, { text: '利空', tone: 'down' }],
      [{ text: '符合预期：', tone: 'warn' }, { text: ' 当作噪音' }],
      [{ text: '初请偏高：', tone: 'up' }, { text: ' 失业加快，加密 ' }, { text: '反弹', tone: 'up' }],
    ],
    unemp: [
      [{ text: '失业率下降：', tone: 'down' }, { text: ' 支持加息，加密 ' }, { text: '承压', tone: 'down' }],
      [{ text: '失业率上升：', tone: 'up' }, { text: ' 加息概率下降，加密 ' }, { text: '反弹', tone: 'up' }],
    ],
    wages: [
      [{ text: '薪资偏热：', tone: 'down' }, { text: ' 通胀黏性，' }, { text: '利空', tone: 'down' }],
      [{ text: '薪资偏冷：', tone: 'up' }, { text: ' 加息理由变弱，' }, { text: '利多', tone: 'up' }],
    ],
    holiday: [
      [{ text: '美股休市，加密仍交易，方向容易失真，降低杠杆。', tone: 'warn' }],
    ],
    repo: [
      [{ text: '回购扩容偏 ' }, { text: '利多流动性', tone: 'up' }, { text: '，但通常不是当天反转催化剂。' }],
    ],
    ppi: [
      [{ text: 'PPI 偏高 / 欧央行偏鹰：', tone: 'down' }, { text: ' 加密 ' }, { text: '承压', tone: 'down' }],
      [{ text: '符合预期：', tone: 'warn' }, { text: ' 继续看 CPI' }],
      [{ text: 'PPI 偏低 / 欧央行偏鸽：', tone: 'up' }, { text: ' 加密 ' }, { text: '反弹', tone: 'up' }],
    ],
    cpi: [
      [{ text: 'CPI 高于预期：', tone: 'down' }, { text: ' 加息概率急升，BTC ' }, { text: '下跌', tone: 'down' }],
      [{ text: '符合预期：', tone: 'warn' }, { text: ' 方向交给 FOMC' }],
      [{ text: 'CPI 低于预期：', tone: 'up' }, { text: ' 加息概率回落，BTC ' }, { text: '反弹', tone: 'up' }],
    ],
    clarity: [
      [{ text: '推进/通过：', tone: 'up' }, { text: ' 监管溢价下降，' }, { text: '利多', tone: 'up' }],
      [{ text: '推迟/否决：', tone: 'down' }, { text: ' 短线 ' }, { text: '利空', tone: 'down' }],
    ],
    fomc: [
      [{ text: '加息 + 鹰派：', tone: 'down' }, { text: ' BTC ' }, { text: '下跌', tone: 'down' }],
      [{ text: '维持：', tone: 'warn' }, { text: ' 空头回补，可能 ' }, { text: '反弹', tone: 'up' }, { text: ' 但涨幅受限' }],
      [{ text: '降息 / 转鸽：', tone: 'up' }, { text: ' 加密 ' }, { text: '趋势反弹', tone: 'up' }],
    ],
    boj: [
      [{ text: '日央行意外鹰派：', tone: 'down' }, { text: ' 风险资产 ' }, { text: '闪跌', tone: 'down' }],
      [{ text: '维持不变：', tone: 'up' }, { text: ' 冲击减弱' }],
      [{ text: '四巫日放大波动，降低杠杆。', tone: 'warn' }],
    ],
    upbit: [
      [{ text: '行业情绪事件，对 BTC 主趋势影响有限。' }],
    ],
    generic: [
      [{ text: '数据偏热 → 加息概率升 → 加密 ' }, { text: '承压', tone: 'down' }],
      [{ text: '数据偏冷 → 加息概率降 → 加密 ' }, { text: '反弹', tone: 'up' }],
    ],
  };
  return map[kind] || map.generic;
}

export function buildEventAnalysis(
  event: MacroEvent,
  data: MarketsResponse,
  coin: CoinMarket | null,
  prevMove?: CryptoMove,
): AnalysisBlock[] {
  const blocks: AnalysisBlock[] = [];
  const prevDate = event.previousDate ? event.previousDate.slice(5).replace('-', '/') : '';
  if (event.previous || prevMove) {
    const lines: AnalysisSpan[][] = [];
    if (event.previous) {
      lines.push([
        { text: '上期 ' },
        { text: event.previous, tone: 'accent' },
        ...(prevDate ? [{ text: `（${prevDate}）` }] : []),
      ]);
    }
    if (prevMove) {
      const tone = moveTone(prevMove.label);
      lines.push([
        { text: `当时 ${coin?.id || 'BTC'} ` },
        { text: formatPct(prevMove.pct), tone },
        { text: ' ' },
        { text: prevMove.label, tone },
      ]);
    }
    blocks.push({ title: '上期', paragraphs: lines });
  }

  const hike = data.macro.fed.hikePct.toFixed(0);
  blocks.push({
    title: '预测',
    paragraphs: [
      ...eventPaths(eventKind(event.title)),
      [
        { text: '当前加息 ' },
        { text: `${hike}%`, tone: 'down' },
        ...(coin ? [{ text: '，现价 ' }, { text: `$${formatPrice(coin.price)}`, tone: 'accent' as const }] : []),
        { text: '。' },
      ],
    ],
  });
  return blocks;
}

export function buildFedItemAnalysis(
  item: FedMarketItem,
  data: MarketsResponse,
  coin: CoinMarket | null,
  prevMove?: CryptoMove,
): AnalysisBlock[] {
  const fed = data.macro.fed;
  const prev = fed.previous;
  const kind = item.kind === 'hike' || /加息/.test(item.label)
    ? 'hike'
    : item.kind === 'cut' || /降息/.test(item.label)
      ? 'cut'
      : 'hold';
  const tone: AnalysisTone = kind === 'hike' ? 'down' : kind === 'cut' ? 'up' : 'warn';
  const now = item.pct.toFixed(1);
  const blocks: AnalysisBlock[] = [];

  if (prev) {
    const lines: AnalysisSpan[][] = [[
      { text: `${prev.date.slice(5).replace('-', '/')} ` },
      { text: prev.label, tone: 'warn' },
      ...(prev.detail ? [{ text: ` · ${prev.detail}` }] : []),
    ]];
    if (prevMove) {
      const move = moveTone(prevMove.label);
      lines.push([
        { text: `当时 ${coin?.id || 'BTC'} ` },
        { text: formatPct(prevMove.pct), tone: move },
        { text: ' ' },
        { text: prevMove.label, tone: move },
      ]);
    }
    blocks.push({ title: '上期', paragraphs: lines });
  }

  const meaning =
    kind === 'hike'
      ? [{ text: '加息路径对加密 ' }, { text: '承压', tone: 'down' }, { text: '。概率升到 70%+ 按偏空处理。' }]
      : kind === 'cut'
        ? [{ text: '降息路径对加密 ' }, { text: '利多', tone: 'up' }, { text: '。概率一旦跳升，偏向反弹。' }]
        : [{ text: '维持利率偏 ' }, { text: '震荡', tone: 'warn' }, { text: '，可反弹但涨幅受限。' }];

  blocks.push({
    title: '预测',
    paragraphs: [
      [
        { text: '当前 ' },
        { text: `${now}%`, tone },
        { text: ` · 合计加息 ${fed.hikePct.toFixed(0)}% / 维持 ${fed.holdPct.toFixed(0)}% / 降息 ${fed.cutPct.toFixed(0)}%` },
      ],
      meaning as AnalysisSpan[],
    ],
  });
  return blocks;
}

export function buildAnchorAnalysis(
  kind: AnchorKind,
  data: MarketsResponse,
  coin: CoinMarket | null,
): AnalysisBlock[] {
  const dxy = data.macro.dxy;
  const tnx = data.macro.treasury10y;
  const fng = data.macro.fearGreed;
  const price = coin ? `$${formatPrice(coin.price)}` : '';

  if (kind === 'dxy') {
    const up = (dxy?.change || 0) > 0;
    return [{
      title: '美元指数',
      paragraphs: dxy
        ? [
            [{ text: `${dxy.value.toFixed(2)}，变动 ` }, { text: formatPct(dxy.changePct), tone: up ? 'down' : 'up' }],
            up
              ? [{ text: '美元上行，加密 ' }, { text: '承压', tone: 'down' }]
              : [{ text: '美元回落，加密偏 ' }, { text: '利多', tone: 'up' }],
          ]
        : [[{ text: '暂无数据' }]],
    }];
  }

  if (kind === 'tnx') {
    const up = (tnx?.change || 0) > 0;
    return [{
      title: '美债 10Y',
      paragraphs: tnx
        ? [
            [{ text: `${tnx.value.toFixed(2)}%，变动 ` }, { text: formatPct(tnx.changePct), tone: up ? 'down' : 'up' }],
            up
              ? [{ text: '收益率上行，加密 ' }, { text: '承压', tone: 'down' }]
              : [{ text: '收益率回落，加密偏 ' }, { text: '利多', tone: 'up' }],
          ]
        : [[{ text: '暂无数据' }]],
    }];
  }

  const value = fng.value || 50;
  const tone = fngTone(value);
  return [{
    title: '恐慌贪婪',
    paragraphs: [
      [{ text: `${value} ${fngLabel(fng.label)}`, tone }, ...(price ? [{ text: ` · ${price}` }] : [])],
      value >= 70
        ? [{ text: '过热，防回撤', tone: 'down' }]
        : value <= 30
          ? [{ text: '恐慌，避免追空', tone: 'up' }]
          : [{ text: '中性附近，不当主信号', tone: 'warn' }],
    ],
  }];
}
