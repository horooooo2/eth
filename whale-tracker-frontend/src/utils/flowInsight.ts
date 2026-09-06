import { formatUsd } from '@/utils/format';

export type FlowDirection = 'inflow' | 'outflow' | 'exchange' | 'transfer';

export interface FlowInsightItem {
  asset?: string;
  amountUsd?: number;
  flowDirection?: FlowDirection | string;
  exchangeName?: string;
}

export type FlowInsightTone = 'sell' | 'buy' | 'neutral' | 'muted';

export interface FlowInsightView {
  text: string;
  tone: FlowInsightTone;
  watch: boolean;
}

const MAJOR_ASSETS = new Set(['BTC', 'ETH', 'SOL', 'USDT', 'USDC']);

function assetOf(item: FlowInsightItem) {
  return String(item.asset || '').trim().toUpperCase() || '资产';
}

function exchangeOf(item: FlowInsightItem) {
  const name = String(item.exchangeName || '').replace(/^\[|\]$/g, '').trim();
  return name || '交易所';
}

/** 单笔流向解读（谨慎措辞，不做价格预测） */
export function buildFlowInsight(item: FlowInsightItem): FlowInsightView {
  const dir = (item.flowDirection || 'transfer') as FlowDirection;
  const asset = assetOf(item);
  const usd = Number(item.amountUsd) || 0;
  const exchange = exchangeOf(item);
  const large = usd >= 5_000_000;
  const major = MAJOR_ASSETS.has(asset);

  if (dir === 'inflow') {
    const watch = large || (major && usd >= 1_000_000);
    return {
      tone: 'sell',
      watch,
      text: watch
        ? `${asset} 充入${exchange}，短期或增加抛压关注（充值≠必然卖出）`
        : `${asset} 流入${exchange}，关注是否转为卖盘`,
    };
  }

  if (dir === 'outflow') {
    const watch = large || (major && usd >= 1_000_000);
    return {
      tone: 'buy',
      watch,
      text: watch
        ? `${asset} 从${exchange}提出，常见于囤积/离场，关注吸筹信号`
        : `${asset} 流出${exchange}，偏向囤积或调仓关注`,
    };
  }

  if (dir === 'exchange') {
    return {
      tone: 'neutral',
      watch: false,
      text: `${asset} 交易所互转，多为搬砖/归集，方向意义较弱`,
    };
  }

  return {
    tone: 'muted',
    watch: false,
    text: `${asset} 链上转账未识别交易所，暂无明确抛压/吸筹含义`,
  };
}

export interface FlowNetSummary {
  inflowUsd: number;
  outflowUsd: number;
  netUsd: number;
  labeledCount: number;
  topAsset: string;
  topAssetNetUsd: number;
  headline: string;
  detail: string;
  tone: FlowInsightTone;
}

/**
 * 近 24h 已识别交易所净流向摘要。
 * 净流入为正 = 更多充进交易所（抛压关注）；净流出为负 = 更多提出（吸筹关注）。
 */
export function buildFlowNetSummary(items: FlowInsightItem[]): FlowNetSummary | null {
  let inflowUsd = 0;
  let outflowUsd = 0;
  let labeledCount = 0;
  const byAsset = new Map<string, number>();

  for (const item of items) {
    const dir = item.flowDirection;
    const usd = Number(item.amountUsd) || 0;
    if (!usd) continue;
    if (dir !== 'inflow' && dir !== 'outflow') continue;
    labeledCount += 1;
    const asset = assetOf(item);
    if (dir === 'inflow') {
      inflowUsd += usd;
      byAsset.set(asset, (byAsset.get(asset) || 0) + usd);
    } else {
      outflowUsd += usd;
      byAsset.set(asset, (byAsset.get(asset) || 0) - usd);
    }
  }

  if (!labeledCount) return null;

  const netUsd = inflowUsd - outflowUsd;
  let topAsset = '';
  let topAssetNetUsd = 0;
  for (const [asset, net] of byAsset.entries()) {
    if (Math.abs(net) > Math.abs(topAssetNetUsd)) {
      topAsset = asset;
      topAssetNetUsd = net;
    }
  }

  let tone: FlowInsightTone = 'neutral';
  let headline = '近 24h 交易所流向大致平衡';
  if (netUsd >= 1_000_000) {
    tone = 'sell';
    headline = `近 24h 净流入交易所 ${formatUsd(netUsd)}，关注抛压`;
  } else if (netUsd <= -1_000_000) {
    tone = 'buy';
    headline = `近 24h 净流出交易所 ${formatUsd(Math.abs(netUsd))}，关注吸筹`;
  }

  const detailParts = [
    `流入 ${formatUsd(inflowUsd)}`,
    `流出 ${formatUsd(outflowUsd)}`,
    `已识别 ${labeledCount} 笔`,
  ];
  if (topAsset && Math.abs(topAssetNetUsd) >= 500_000) {
    detailParts.push(
      topAssetNetUsd > 0
        ? `${topAsset} 净流入 ${formatUsd(topAssetNetUsd)}`
        : `${topAsset} 净流出 ${formatUsd(Math.abs(topAssetNetUsd))}`,
    );
  }

  return {
    inflowUsd,
    outflowUsd,
    netUsd,
    labeledCount,
    topAsset,
    topAssetNetUsd,
    headline,
    detail: detailParts.join(' · '),
    tone,
  };
}
