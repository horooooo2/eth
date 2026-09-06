import type { Recommendation } from '@/utils/recommend';

export type ResonanceLevel = 'aligned' | 'conflict' | 'mixed';

export interface ResonanceView {
  level: ResonanceLevel;
  title: string;
  whaleLine: string;
  newsLine: string;
  macroLine: string;
  advice: string;
  score: number;
  bias: 'long' | 'short' | 'wait';
}

type Dir = 'long' | 'short' | 'neutral' | 'mixed';

function whaleDir(stats: Recommendation['sources']['stats']): Dir {
  if (stats.longPct >= 55) return 'long';
  if (stats.shortPct >= 55) return 'short';
  return 'mixed';
}

function newsDir(reco: Recommendation): Dir {
  const bull = reco.sources.news.filter((item) => item.lean === 'long').length;
  const bear = reco.sources.news.filter((item) => item.lean === 'short').length;
  if (bull > bear) return 'long';
  if (bear > bull) return 'short';
  return 'neutral';
}

function macroDir(reco: Recommendation): Dir {
  const event = reco.sources.event;
  if (!event) return 'neutral';
  return event.lean;
}

function dirSign(dir: Dir) {
  if (dir === 'long') return 1;
  if (dir === 'short') return -1;
  return 0;
}

export function buildResonanceView(reco: Recommendation): ResonanceView {
  const stats = reco.sources.stats;
  const wDir = whaleDir(stats);
  const nDir = newsDir(reco);
  const mDir = macroDir(reco);

  const whaleLine =
    wDir === 'long'
      ? `多（${stats.longPct}%）`
      : wDir === 'short'
        ? `空（${stats.shortPct}%）`
        : `分歧（多${stats.longPct}%/空${stats.shortPct}%）`;

  const bullNews = reco.sources.news.filter((item) => item.lean === 'long').length;
  const bearNews = reco.sources.news.filter((item) => item.lean === 'short').length;
  const newsLine =
    nDir === 'long'
      ? `偏多（${bullNews}条）`
      : nDir === 'short'
        ? `偏空（${bearNews}条）`
        : bullNews || bearNews
          ? `中性（多${bullNews}/空${bearNews}）`
          : '暂无有效快讯';

  const event = reco.sources.event;
  const macroLine = event
    ? `${event.lean === 'long' ? '偏多' : '偏空'}（${event.title}）`
    : '暂无宏观事件';

  const signs = [wDir, nDir, mDir]
    .map(dirSign)
    .filter((value) => value !== 0);
  const uniqueSigns = new Set(signs);

  let level: ResonanceLevel = 'mixed';
  let title = '方向分歧';
  let advice = '巨鲸、新闻与宏观未形成一致方向，建议观望等待信号确认。';

  if (uniqueSigns.size >= 2) {
    level = 'conflict';
    title = '共振冲突';
    advice = '建议观望，等待方向明确后再行动。';
  } else if (uniqueSigns.size === 1 && signs.length >= 2) {
    level = 'aligned';
    title = '共振一致';
    const sign = [...uniqueSigns][0];
    advice =
      sign > 0
        ? '巨鲸、新闻与宏观偏多共振，可关注回踩做多机会。'
        : '巨鲸、新闻与宏观偏空共振，注意反弹做空或减仓风险。';
  } else if (reco.bias !== 'wait') {
    level = 'mixed';
    title = '弱共振';
    advice =
      reco.bias === 'long'
        ? '整体略偏多，但部分维度信号不足，宜轻仓或等待确认。'
        : '整体略偏空，但部分维度信号不足，宜轻仓或等待确认。';
  }

  return {
    level,
    title,
    whaleLine,
    newsLine,
    macroLine,
    advice,
    score: reco.strength.score,
    bias: reco.bias,
  };
}
