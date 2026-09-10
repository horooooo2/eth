/**
 * Read-only strategy config renderer. No edit/save/delete.
 */

export const FORBIDDEN_ACTIONS = [
  'Edit',
  'Save',
  'Delete',
  'Upload',
  'Create',
  '编辑',
  '保存',
  '删除',
  '上传',
  '新建',
];

export type StrategyConfigItem = {
  id: string;
  name?: string;
  type?: string;
  status?: string;
  strategy_key?: string;
  release_stage?: string;
  timeframe?: string;
  symbols?: string[];
  demo_allowed?: boolean;
  live_allowed?: boolean;
  runtime_active?: boolean;
  config_error?: unknown;
  [key: string]: unknown;
};

export type StrategyConfigDetail = {
  id?: string;
  name?: string;
  strategy_key?: string;
  status?: string;
  type?: string;
  implementation?: string;
  dependencies?: string[];
  error?: { code?: string; message?: string };
  release?: {
    stage?: string;
    implemented?: boolean;
    demo_allowed?: boolean;
    live_allowed?: boolean;
    live_permission?: boolean;
  };
  market?: {
    symbols?: string[];
    instrument?: string;
    timeframe?: string;
  };
  source?: {
    config_path?: string;
    schema_version?: string;
    modified_at?: string;
    kind?: string;
  };
  runtime?: {
    online?: boolean;
    active?: boolean;
    state?: string;
    config_match?: boolean | null;
    disk_config_hash?: string;
  };
  implementation_overlay?: {
    stop?: Record<string, unknown>;
  };
  raw_config?: Record<string, unknown>;
  effective_config?: Record<string, unknown>;
  display?: {
    summary_zh?: string;
    entry_summary_zh?: string;
    risk_summary_zh?: string;
    exit_summary_zh?: string;
  };
  summary_zh?: string;
  entry_summary_zh?: string;
  risk_summary_zh?: string;
  exit_summary_zh?: string;
  [key: string]: unknown;
};

export function isPctEquityKey(key: string) {
  return /_pct_equity$/.test(String(key || ''));
}

export function isBpsKey(key: string) {
  return /_bps$/.test(String(key || ''));
}

export function formatValue(key: string, value: unknown) {
  if (typeof value === 'boolean') return value ? 'YES' : 'NO';
  if (typeof value === 'number' && Number.isFinite(value)) {
    if (isPctEquityKey(key)) return `${(value * 100).toFixed(2)}%`;
    if (isBpsKey(key)) return `${value} bps`;
    return String(value);
  }
  if (value == null) return '—';
  return String(value);
}

export function escapeHtml(value: unknown) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function statusClass(status: unknown) {
  const s = String(status || '').toUpperCase();
  if (s === 'READY' || s === 'PRODUCTION' || s === 'MATCH' || s === 'ACTIVE') return 'ok';
  if (s === 'RESEARCH' || s === 'WARNING' || s === 'DIFF' || s === 'RUNTIME OVERRIDE') return 'warn';
  if (s === 'INVALID' || s === 'BLOCKED' || s === 'CONFIG_INVALID') return 'danger';
  return 'muted';
}

export function filterItems(items: StrategyConfigItem[], query: string) {
  const q = String(query || '').trim().toLowerCase();
  if (!q) return items.slice();
  return items.filter((item) => {
    const blob = [item.id, item.name, item.strategy_key, item.type, item.release_stage, item.status]
      .join(' ')
      .toLowerCase();
    return blob.includes(q);
  });
}

export function classify(items: StrategyConfigItem[]) {
  return {
    alpha: (items || []).filter((i) => i.type === 'ALPHA'),
    system: (items || []).filter((i) => i.type === 'SYSTEM'),
  };
}

export function hasForbiddenAction(html: string) {
  const text = String(html || '');
  return FORBIDDEN_ACTIONS.some((word) => new RegExp(`\\b${word}\\b`, 'i').test(text));
}

function renderTree(key: string, value: unknown, depth?: number): string {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const rows = Object.keys(value as Record<string, unknown>)
      .map((k) => renderTree(k, (value as Record<string, unknown>)[k], (depth || 0) + 1))
      .join('');
    return `<div class="kv-block" style="margin-left:${Math.min(depth || 0, 4) * 10}px">
        <div class="kv-k">${escapeHtml(key)}</div>
        <div class="kv-children">${rows}</div>
      </div>`;
  }
  if (Array.isArray(value)) {
    const primitive = value.every((v) => v == null || typeof v !== 'object');
    if (primitive) {
      const badges = value.map((v) => `<span class="badge">${escapeHtml(formatValue(key, v))}</span>`).join('');
      return `<div class="kv"><span class="k">${escapeHtml(key)}</span><span class="v">${badges || '—'}</span></div>`;
    }
    return `<div class="kv-block">
        <div class="kv-k">${escapeHtml(key)}</div>
        ${value.map((item, i) => renderTree(String(i), item, (depth || 0) + 1)).join('')}
      </div>`;
  }
  return `<div class="kv"><span class="k">${escapeHtml(key)}</span><span class="v">${escapeHtml(formatValue(key, value))}</span></div>`;
}

export function renderStructured(detail: StrategyConfigDetail | null) {
  if (!detail) return '<div class="empty">未选择</div>';
  if (detail.error) {
    return `<div class="err-panel">
        <div class="err-code">${escapeHtml(detail.error.code || 'CONFIG_INVALID')}</div>
        <div class="err-msg">${escapeHtml(detail.error.message || 'configuration error')}</div>
      </div>`;
  }
  const raw = detail.raw_config || {};
  const overlay = detail.implementation_overlay || {};
  const parts: string[] = [];
  if (detail.id === 'S8' || detail.release?.implemented === false) {
    parts.push(`<div class="err-panel warn-panel">
        <div class="err-code">RESEARCH / NOT IMPLEMENTED</div>
        <div class="err-msg">S8 仅研究占位，不能当作可运行策略。</div>
      </div>`);
  }
  parts.push(`<h3>基本信息</h3>
      ${renderTree('Strategy ID', detail.id)}
      ${renderTree('名称', detail.name)}
      ${renderTree('strategy_key', detail.strategy_key)}
      ${renderTree('release stage', detail.release?.stage)}
      ${renderTree('implemented', detail.release?.implemented)}
      ${renderTree('demo_allowed', detail.release?.demo_allowed)}
      ${renderTree('live_allowed', detail.release?.live_allowed)}
      ${renderTree('live_permission', detail.release?.live_permission)}
      ${renderTree('implementation module', detail.implementation || '—')}
      ${renderTree('config source', detail.source?.config_path)}
      ${renderTree('schema_version', detail.source?.schema_version)}
    `);
  if (detail.market) {
    parts.push(`<h3>市场配置</h3>
        ${renderTree('symbols', detail.market.symbols || [])}
        ${renderTree('instrument', detail.market.instrument)}
        ${renderTree('timeframe', detail.market.timeframe)}
      `);
  }
  if (overlay.stop) {
    parts.push(`<h3>止损实现（代码，非 JSON 字段）</h3>
        ${renderTree('method', overlay.stop.method)}
        ${renderTree('lookback_bars', overlay.stop.lookback_bars)}
        ${renderTree('left_confirmation', overlay.stop.left_confirmation)}
        ${renderTree('right_confirmation', overlay.stop.right_confirmation)}
        ${renderTree('module', overlay.stop.module)}
      `);
  }
  if (detail.dependencies && detail.dependencies.length) {
    const badges = detail.dependencies
      .map((id) => `<button type="button" class="badge link" data-jump="${escapeHtml(id)}">${escapeHtml(id)}</button>`)
      .join('');
    parts.push(`<h3>依赖</h3><div class="kv"><span class="k">modules</span><span class="v">${badges}</span></div>`);
  }
  if (raw && typeof raw === 'object') {
    parts.push('<h3>配置详情</h3>');
    for (const [key, value] of Object.entries(raw)) {
      parts.push(renderTree(key, value, 0));
    }
  }
  return parts.join('');
}

export function prettyJson(value: unknown) {
  return JSON.stringify(value == null ? {} : value, null, 2);
}

export function runtimeSyncLabel(runtime: StrategyConfigDetail['runtime']) {
  if (!runtime || !runtime.online) return { text: 'OFFLINE', cls: 'muted' };
  if (runtime.config_match === true) return { text: 'MATCH', cls: 'ok' };
  if (runtime.config_match === false) return { text: 'RUNTIME DIFF', cls: 'warn' };
  return { text: 'UNKNOWN', cls: 'muted' };
}

export function renderSummary(detail: StrategyConfigDetail | null) {
  if (!detail) return '<div class="empty">未选择</div>';
  if (detail.error) {
    return `<div class="err-panel">
        <div class="err-code">${escapeHtml(detail.error.code || 'CONFIG_INVALID')}</div>
        <div class="err-msg">${escapeHtml(detail.error.message || 'configuration error')}</div>
      </div>`;
  }
  const rel = detail.release || {};
  const sync = runtimeSyncLabel(detail.runtime);
  const display = detail.display || {};
  const summaryZh = String(detail.summary_zh || display.summary_zh || '').trim();
  const entryZh = String(detail.entry_summary_zh || display.entry_summary_zh || '').trim();
  const riskZh = String(detail.risk_summary_zh || display.risk_summary_zh || '').trim();
  const exitZh = String(detail.exit_summary_zh || display.exit_summary_zh || '').trim();
  const parts = [
    '<h3>概要</h3>',
    renderTree('策略', `${detail.id || '—'} · ${detail.name || '—'}`),
    renderTree('类型', detail.type || '—'),
    renderTree('阶段', rel.stage || detail.status || '—'),
    renderTree('已实现', rel.implemented),
    renderTree('品种', detail.market?.instrument || (detail.market?.symbols || []).join(', ') || '—'),
    renderTree('周期', detail.market?.timeframe || '—'),
    renderTree('Demo Allowed', rel.demo_allowed ? 'YES' : 'NO'),
    renderTree('Live Allowed', rel.live_allowed ? 'YES' : 'NO'),
    renderTree('Live Permission', rel.live_permission ? 'ON' : 'OFF'),
    renderTree('Runtime', detail.runtime?.active ? 'ACTIVE' : detail.runtime?.state || 'OFFLINE'),
    `<div class="kv"><span class="k">Config Sync</span><span class="v ${sync.cls}">${escapeHtml(sync.text)}</span></div>`,
    renderTree('配置文件', detail.source?.config_path || '—'),
  ];
  if (summaryZh) parts.push(`<p class="meta" style="padding:6px 18px">${escapeHtml(summaryZh)}</p>`);
  if (entryZh) parts.push(renderTree('入场', entryZh));
  if (riskZh) parts.push(renderTree('风险', riskZh));
  if (exitZh) parts.push(renderTree('退出', exitZh));
  if (detail.id === 'S8' || rel.implemented === false) {
    parts.unshift(`<div class="err-panel warn-panel">
        <div class="err-code">研究中 / 尚未实现</div>
        <div class="err-msg">该条目仅研究占位，不能当作可运行策略。</div>
      </div>`);
  }
  return parts.join('');
}
