/**
 * Read-only strategy config renderer. No edit/save/delete.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.StrategyConfigView = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const FORBIDDEN_ACTIONS = ['Edit', 'Save', 'Delete', 'Upload', 'Create', '编辑', '保存', '删除', '上传', '新建'];

  function isPctEquityKey(key) {
    return /_pct_equity$/.test(String(key || ''));
  }

  function isBpsKey(key) {
    return /_bps$/.test(String(key || ''));
  }

  function formatValue(key, value) {
    if (typeof value === 'boolean') return value ? 'YES' : 'NO';
    if (typeof value === 'number' && Number.isFinite(value)) {
      if (isPctEquityKey(key)) return `${(value * 100).toFixed(2)}%`;
      if (isBpsKey(key)) return `${value} bps`;
      return String(value);
    }
    if (value == null) return '—';
    return String(value);
  }

  function escapeHtml(value) {
    return String(value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function statusClass(status) {
    const s = String(status || '').toUpperCase();
    if (s === 'READY' || s === 'PRODUCTION' || s === 'MATCH' || s === 'ACTIVE') return 'ok';
    if (s === 'RESEARCH' || s === 'WARNING' || s === 'DIFF' || s === 'RUNTIME OVERRIDE') return 'warn';
    if (s === 'INVALID' || s === 'BLOCKED' || s === 'CONFIG_INVALID') return 'danger';
    return 'muted';
  }

  function filterItems(items, query) {
    const q = String(query || '').trim().toLowerCase();
    if (!q) return items.slice();
    return items.filter((item) => {
      const blob = [item.id, item.name, item.strategy_key, item.type, item.release_stage, item.status]
        .join(' ')
        .toLowerCase();
      return blob.includes(q);
    });
  }

  function classify(items) {
    return {
      alpha: (items || []).filter((i) => i.type === 'ALPHA'),
      system: (items || []).filter((i) => i.type === 'SYSTEM'),
    };
  }

  function hasForbiddenAction(html) {
    const text = String(html || '');
    return FORBIDDEN_ACTIONS.some((word) => new RegExp(`\\b${word}\\b`, 'i').test(text));
  }

  function renderTree(key, value, depth) {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const rows = Object.keys(value)
        .map((k) => renderTree(k, value[k], (depth || 0) + 1))
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

  function renderStructured(detail) {
    if (!detail) return '<div class="empty">未选择</div>';
    if (detail.error) {
      return `<div class="err-panel">
        <div class="err-code">${escapeHtml(detail.error.code || 'CONFIG_INVALID')}</div>
        <div class="err-msg">${escapeHtml(detail.error.message || 'configuration error')}</div>
      </div>`;
    }
    const raw = detail.raw_config || {};
    const overlay = detail.implementation_overlay || {};
    const parts = [];
    if (detail.id === 'S8' || detail.release?.implemented === false) {
      parts.push(`<div class="err-panel warn-panel">
        <div class="err-code">研究中 / 尚未实现</div>
        <div class="err-msg">S8 巨鲸行为共振目前处于研究阶段，尚未实现可执行交易逻辑，也不允许模拟盘或实盘交易。</div>
      </div>`);
    }
    parts.push(`<h3>基本信息</h3>
      ${renderTree('策略 ID', detail.id)}
      ${renderTree('名称', detail.name)}
      ${renderTree('配置键', detail.strategy_key)}
      ${renderTree('发布阶段', detail.release?.stage)}
      ${renderTree('已实现', detail.release?.implemented)}
      ${renderTree('模拟盘允许', detail.release?.demo_allowed)}
      ${renderTree('实盘能力', detail.release?.live_allowed)}
      ${renderTree('实盘权限', detail.release?.live_permission)}
      ${renderTree('实现模块', detail.implementation || '—')}
      ${renderTree('配置来源', detail.source?.config_path)}
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
      parts.push(`<h3>依赖模块</h3><div class="kv"><span class="k">modules</span><span class="v">${badges}</span></div>`);
    }
    if (raw && typeof raw === 'object') {
      parts.push('<h3>配置详情</h3>');
      for (const [key, value] of Object.entries(raw)) {
        parts.push(renderTree(key, value, 0));
      }
    }
    return parts.join('');
  }

  function prettyJson(value) {
    return JSON.stringify(value == null ? {} : value, null, 2);
  }

  function runtimeSyncLabel(runtime) {
    if (!runtime || !runtime.online) return { text: 'OFFLINE', cls: 'muted' };
    if (runtime.config_match === true) return { text: 'MATCH', cls: 'ok' };
    if (runtime.config_match === false) return { text: 'RUNTIME DIFF', cls: 'warn' };
    return { text: 'UNKNOWN', cls: 'muted' };
  }

  return {
    FORBIDDEN_ACTIONS,
    isPctEquityKey,
    formatValue,
    filterItems,
    classify,
    hasForbiddenAction,
    renderStructured,
    prettyJson,
    runtimeSyncLabel,
    statusClass,
    escapeHtml,
  };
});
