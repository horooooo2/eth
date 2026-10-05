import type { WhaleProfile } from '@/types';
import { visibleWhalePositions, scopedWhaleDirection, positionPnlPct } from '@/utils/whaleCardUtils';
import { formatWhaleMetricLines, resolveReferenceTier, whaleCardTitle } from '@/utils/whaleReference';
import { directionLabel, formatUsd, formatPrice } from '@/utils/format';

export function buildWhaleAiPayload(whale: WhaleProfile) {
  const positions = visibleWhalePositions(whale, 'all').slice().sort((a, b) => b.positionValue - a.positionValue);
  const dir = scopedWhaleDirection(whale, 'all');
  const metrics = formatWhaleMetricLines(whale);
  const tier = resolveReferenceTier(whale);
  const winRateRaw = Number(whale.winRate);
  const wr =
    Number.isFinite(winRateRaw) && winRateRaw > 0
      ? `${(winRateRaw <= 1 ? winRateRaw * 100 : winRateRaw).toFixed(0)}%`
      : '—';
  const trades = Number(whale.closedTrades) || 0;
  const ddRaw = Number(whale.maxDrawdown);
  const dd = Number.isFinite(ddRaw) ? `${ddRaw.toFixed(1)}%` : '—';
  const reliabilityLine = `胜率 ${wr} · ${trades}笔 · 最大回撤 ${dd} · 参考等级 ${tier.label}`;
  const statsCombined = [metrics.volumeLine, metrics.statsLine].filter(Boolean).join(' · ');
  const lines = [
    `名称：${whaleCardTitle(whale)}`,
    `地址：${whale.address || '—'}`,
    `综合方向：${directionLabel(dir)}`,
    `持仓数：${positions.length}`,
    '',
    '【账户指标】',
    metrics.volumeLine ? `成交：${metrics.volumeLine}` : '成交：（无）',
    metrics.statsLine
      ? `业绩：${metrics.statsLine}`
      : '业绩：（无月盈亏/累计/胜率/笔数）',
    statsCombined ? `卡片展示：${statsCombined}` : '',
    '',
    '【巨鲸可靠度】',
    `参考等级：${tier.label}（${tier.shortLabel}）`,
    reliabilityLine,
    '',
    '【持仓明细】',
  ];
  if (!positions.length) {
    lines.push('（当前无可见持仓）');
  } else {
    for (const pos of positions.slice(0, 24)) {
      const side = pos.side === 'long' ? '多' : '空';
      const lev = pos.leverage != null ? `${pos.leverage}x` : '—';
      const pnl = Number.isFinite(pos.unrealizedPnl) ? formatUsd(pos.unrealizedPnl) : '—';
      const val = Number.isFinite(pos.positionValue) ? formatUsd(pos.positionValue) : '—';
      const entry = Number.isFinite(pos.entryPx) ? formatPrice(pos.entryPx) : '—';
      const liq =
        pos.liquidationPx != null && pos.liquidationPx !== ''
          ? String(pos.liquidationPx)
          : '—';
      const pnlPct = positionPnlPct(pos);
      const pnlPctText = pnlPct != null ? ` (${pnlPct.toFixed(2)}%)` : '';
      lines.push(
        `- ${pos.coin} ${side}｜名义 ${val}｜开仓 ${entry}｜杠杆 ${lev}｜浮盈亏 ${pnl}${pnlPctText}｜强平 ${liq}`,
      );
    }
    if (positions.length > 24) lines.push(`…另有 ${positions.length - 24} 笔持仓未列出`);
  }
  return {
    title: `巨鲸分析 · ${whaleCardTitle(whale)}`,
    content: lines.join('\n'),
    meta: {
      whaleId: whale.id,
      name: whaleCardTitle(whale),
      address: whale.address || '',
      direction: dir,
      directionLabel: directionLabel(dir),
      positionCount: positions.length,
      volumeLine: metrics.volumeLine || '',
      statsLine: metrics.statsLine || '',
      referenceTier: tier.tier,
      referenceLabel: tier.label,
      referenceShort: tier.shortLabel,
      reliabilityLine,
    },
  };
}

