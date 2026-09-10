/**
 * Read-only Strategy Configuration Center.
 * Production disk truth is MODULAR_JSON (system.json + registry + strategies/ + modules/).
 * Callers cannot pass filesystem paths. No silent legacy fallback.
 */

'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const ID_RE = /^S[1-9]$/;

const SECRET_KEY_RE =
  /^(api[_-]?key|secret|passphrase|password|token|jwt|session|authorization|private[_-]?key|access[_-]?key)$/i;

const WRAPPER_KEYS = new Set([
  'schema_version',
  'config_type',
  'strategy_id',
  'module_id',
  'name',
  'release_stage',
  'implemented',
  'demo_allowed',
  'live_allowed',
  'deprecated',
  'deprecation_status',
  'canonical_source',
  'replacement',
  'display',
  'summary_zh',
  'entry_summary_zh',
  'risk_summary_zh',
  'exit_summary_zh',
]);

const REGISTRY = Object.freeze({
  S1: {
    id: 'S1',
    type: 'ALPHA',
    name: '趋势跟踪',
    strategy_key: 'S1_trend',
    release_stage: 'PRODUCTION',
    implemented: true,
    demo_allowed: true,
    live_policy_allowed: true,
    implementation: 'src.strategies.s1_trend',
    config_rel: 'strategies/s1_trend.json',
    dependencies: ['S3', 'S4', 'S5', 'S6', 'S7'],
    preferred_sections: ['market', 'signal', 'risk', 'stop', 'dependencies'],
  },
  S2: {
    id: 'S2',
    type: 'ALPHA',
    name: '极端情绪反转',
    strategy_key: 'S2_reversal',
    release_stage: 'PRODUCTION',
    implemented: true,
    demo_allowed: false,
    live_policy_allowed: true,
    implementation: 'src.strategies.s2_reversal',
    config_rel: 'strategies/s2_reversal.json',
    dependencies: ['S3', 'S4', 'S5', 'S6', 'S7'],
    preferred_sections: ['market', 'sentiment', 'reversal', 'risk', 'stop', 'dependencies'],
  },
  S9: {
    id: 'S9',
    type: 'ALPHA',
    name: '高频动量突破',
    strategy_key: 'S9_high_frequency_momentum',
    release_stage: 'DEMO_VALIDATION',
    implemented: true,
    demo_allowed: true,
    live_policy_allowed: false,
    implementation: 'src.strategies.s9_momentum',
    config_rel: 'strategies/s9_high_frequency_momentum.json',
    dependencies: ['S3', 'S4', 'S5', 'S6', 'S7'],
    preferred_sections: ['market', 'signal', 'risk', 'stop', 'dependencies'],
  },
  S8: {
    id: 'S8',
    type: 'ALPHA',
    name: '巨鲸行为共振',
    strategy_key: 'S8_whale_intelligence',
    release_stage: 'RESEARCH',
    implemented: false,
    demo_allowed: false,
    live_policy_allowed: false,
    implementation: null,
    config_rel: 'strategies/s8_whale_intelligence.json',
    dependencies: ['S3', 'S4', 'S5', 'S6', 'S7'],
    preferred_sections: ['basic'],
  },
  S3: {
    id: 'S3',
    type: 'SYSTEM',
    name: 'Market Regime',
    strategy_key: 'S3_regime',
    release_stage: 'PRODUCTION',
    implemented: true,
    demo_allowed: false,
    live_policy_allowed: false,
    implementation: 'src.strategies.s3_regime',
    config_rel: 'modules/s3_regime.json',
    dependencies: [],
    preferred_sections: ['regime'],
  },
  S4: {
    id: 'S4',
    type: 'SYSTEM',
    name: 'Execution Timing',
    strategy_key: 'S4_execution',
    release_stage: 'PRODUCTION',
    implemented: true,
    demo_allowed: false,
    live_policy_allowed: false,
    implementation: 'src.strategies.s4_execution',
    config_rel: 'modules/s4_execution_timing.json',
    dependencies: [],
    preferred_sections: ['timing'],
  },
  S5: {
    id: 'S5',
    type: 'SYSTEM',
    name: 'Risk Budget',
    strategy_key: 'S5_risk_budget',
    release_stage: 'PRODUCTION',
    implemented: true,
    demo_allowed: false,
    live_policy_allowed: false,
    implementation: 'src.strategies.s5_risk_budget',
    config_rel: 'modules/s5_risk_budget.json',
    dependencies: [],
    preferred_sections: ['portfolio', 'allocation'],
  },
  S6: {
    id: 'S6',
    type: 'SYSTEM',
    name: 'Safety',
    strategy_key: 'S6_anomaly',
    release_stage: 'PRODUCTION',
    implemented: true,
    demo_allowed: false,
    live_policy_allowed: false,
    implementation: 'src.strategies.s6_anomaly',
    config_rel: 'modules/s6_safety.json',
    dependencies: [],
    preferred_sections: ['safety'],
  },
  S7: {
    id: 'S7',
    type: 'SYSTEM',
    name: 'Strategy Health',
    strategy_key: 'S7_health',
    release_stage: 'PRODUCTION',
    implemented: true,
    demo_allowed: false,
    live_policy_allowed: false,
    implementation: 'src.strategies.s7_health',
    config_rel: 'modules/s7_strategy_health.json',
    dependencies: [],
    preferred_sections: ['health'],
  },
});

const ALPHA_IDS = ['S1', 'S2', 'S9', 'S8'];
const SYSTEM_IDS = ['S3', 'S4', 'S5', 'S6', 'S7'];

function normalizeId(raw) {
  return String(raw || '').trim().toUpperCase();
}

function isKnownId(id) {
  return Boolean(REGISTRY[normalizeId(id)]);
}

function fail(code, message, status = 400, details) {
  const err = new Error(message);
  err.status = status;
  err.code = code;
  err.details = details || {};
  return err;
}

function engineRoot() {
  if (process.env.V41_ENGINE_ROOT) return path.resolve(process.env.V41_ENGINE_ROOT);
  return path.resolve(__dirname, '..', '..', 'ai-trading-system-v41');
}

function logicalOf(rel) {
  const n = String(rel || '').replace(/\\/g, '/').replace(/^\/+/, '');
  return n.startsWith('config/') ? n : `config/${n}`;
}

function canonicalize(value) {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(canonicalize);
  const out = {};
  for (const key of Object.keys(value).sort()) {
    out[key] = canonicalize(value[key]);
  }
  return out;
}

function configHash(value) {
  const canonical = JSON.stringify(canonicalize(value === undefined ? null : value));
  return crypto.createHash('sha256').update(canonical).digest('hex');
}

function stripWrapper(doc) {
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return doc;
  const out = {};
  for (const [key, value] of Object.entries(doc)) {
    if (!WRAPPER_KEYS.has(key)) out[key] = value;
  }
  return out;
}

function isSecretKey(key) {
  const kn = String(key || '').trim().toLowerCase().replace(/-/g, '_');
  if (SECRET_KEY_RE.test(kn)) return true;
  return kn.endsWith('_secret') || kn.endsWith('_passphrase') || kn.endsWith('_password') || kn.endsWith('_token');
}

function redactSecrets(value) {
  if (Array.isArray(value)) return value.map(redactSecrets);
  if (!value || typeof value !== 'object') return value;
  const out = {};
  for (const [key, item] of Object.entries(value)) {
    out[key] = isSecretKey(key) ? '[REDACTED]' : redactSecrets(item);
  }
  return out;
}

function livePermissionEnabled() {
  const raw = String(process.env.V41_LIVE_TRADING_ENABLED || '').trim().toLowerCase();
  return raw === 'true' || raw === '1' || raw === 'yes' || raw === 'on';
}

function readJsonFile(abs, logical) {
  if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
    return { ok: false, error: { code: 'CONFIG_INVALID', message: `missing ${logical}` }, document: null, stat: null };
  }
  let text;
  try {
    text = fs.readFileSync(abs, 'utf8');
  } catch {
    return { ok: false, error: { code: 'CONFIG_INVALID', message: `unreadable ${logical}` }, document: null, stat: null };
  }
  let document;
  try {
    document = JSON.parse(text);
  } catch {
    const st = fs.statSync(abs);
    return { ok: false, error: { code: 'CONFIG_INVALID', message: `invalid JSON: ${logical}` }, document: null, stat: st };
  }
  if (!document || typeof document !== 'object' || Array.isArray(document)) {
    return { ok: false, error: { code: 'CONFIG_INVALID', message: `config root must be an object: ${logical}` }, document: null, stat: fs.statSync(abs) };
  }
  return { ok: true, error: null, document, stat: fs.statSync(abs) };
}

function mapRegistryEntry(item) {
  const id = String((item && item.id) || '').toUpperCase();
  const type = String((item && item.type) || '');
  return {
    id,
    type: type === 'SYSTEM_MODULE' ? 'SYSTEM' : 'ALPHA',
    name: item.name,
    strategy_key: item.strategy_key,
    release_stage: item.release_stage,
    implemented: Boolean(item.implemented),
    demo_allowed: Boolean(item.demo_allowed),
    live_policy_allowed: Boolean(item.live_allowed),
    implementation: item.implementation || null,
    config_rel: String(item.config || '').replace(/\\/g, '/'),
    dependencies: Array.isArray(item.dependencies) ? item.dependencies : [],
    preferred_sections: Array.isArray(item.preferred_sections) ? item.preferred_sections : [],
  };
}

function mergedEntry(id, diskEntry) {
  const base = REGISTRY[id] || {};
  if (!diskEntry) return { ...base };
  return {
    ...base,
    ...diskEntry,
    preferred_sections: diskEntry.preferred_sections && diskEntry.preferred_sections.length
      ? diskEntry.preferred_sections
      : base.preferred_sections,
    dependencies: diskEntry.dependencies && diskEntry.dependencies.length ? diskEntry.dependencies : base.dependencies,
  };
}

function loadModularPack() {
  const root = engineRoot();
  const systemLogical = 'config/system.json';
  const registryLogical = 'config/strategy_registry.json';
  const systemAbs = path.join(root, 'config', 'system.json');
  const registryAbs = path.join(root, 'config', 'strategy_registry.json');
  const systemExists = fs.existsSync(systemAbs);
  const registryExists = fs.existsSync(registryAbs);
  const baseSource = {
    kind: 'MODULAR_JSON',
    config_path: systemLogical,
    schema_version: '1.0',
    modified_at: null,
    config_hash: null,
  };

  if (!systemExists && !registryExists) {
    return {
      ok: false,
      error: { code: 'CONFIG_NOT_FOUND', message: 'modular config files not found' },
      source: baseSource,
      documents: {},
      entries: { ...REGISTRY },
      paths: {},
      stats: {},
    };
  }
  if (!systemExists || !registryExists) {
    return {
      ok: false,
      error: { code: 'CONFIG_INVALID', message: 'modular config incomplete (system.json / strategy_registry.json)' },
      source: baseSource,
      documents: {},
      entries: { ...REGISTRY },
      paths: {},
      stats: {},
    };
  }

  const registryRead = readJsonFile(registryAbs, registryLogical);
  if (!registryRead.ok) {
    return {
      ok: false,
      error: registryRead.error,
      source: { ...baseSource, config_path: registryLogical },
      documents: {},
      entries: { ...REGISTRY },
      paths: {},
      stats: {},
    };
  }
  const systemRead = readJsonFile(systemAbs, systemLogical);
  if (!systemRead.ok) {
    return {
      ok: false,
      error: systemRead.error,
      source: { ...baseSource, modified_at: systemRead.stat ? systemRead.stat.mtime.toISOString() : null },
      documents: {},
      entries: { ...REGISTRY },
      paths: {},
      stats: {},
    };
  }

  const diskEntries = {};
  const alpha = Array.isArray(registryRead.document.alpha_strategies) ? registryRead.document.alpha_strategies : [];
  const modules = Array.isArray(registryRead.document.system_modules) ? registryRead.document.system_modules : [];
  for (const item of [...alpha, ...modules]) {
    const mapped = mapRegistryEntry(item);
    if (mapped.id) diskEntries[mapped.id] = mapped;
  }

  const entries = {};
  for (const id of [...ALPHA_IDS, ...SYSTEM_IDS]) {
    entries[id] = mergedEntry(id, diskEntries[id]);
  }

  const documents = { SYSTEM: systemRead.document, REGISTRY: registryRead.document };
  const paths = { SYSTEM: systemLogical, REGISTRY: registryLogical };
  const stats = { SYSTEM: systemRead.stat, REGISTRY: registryRead.stat };
  let firstError = null;

  for (const id of [...ALPHA_IDS, ...SYSTEM_IDS]) {
    const entry = entries[id];
    const rel = entry.config_rel || (REGISTRY[id] && REGISTRY[id].config_rel);
    const logical = logicalOf(rel);
    const abs = path.join(root, 'config', rel.replace(/^config\//, ''));
    if (rel.includes('..') || path.isAbsolute(rel)) {
      firstError = firstError || { code: 'CONFIG_INVALID', message: `unsafe registry path for ${id}` };
      continue;
    }
    const read = readJsonFile(abs, logical);
    paths[id] = logical;
    stats[id] = read.stat;
    if (!read.ok) {
      firstError = firstError || read.error;
      continue;
    }
    const expectedType = entry.type === 'SYSTEM' ? 'SYSTEM_MODULE' : 'ALPHA_STRATEGY';
    const expectedIdKey = entry.type === 'SYSTEM' ? 'module_id' : 'strategy_id';
    if (String(read.document.schema_version || '') !== '1.0') {
      firstError = firstError || { code: 'CONFIG_INVALID', message: `schema_version invalid: ${logical}` };
    } else if (String(read.document.config_type || '') !== expectedType) {
      firstError = firstError || { code: 'CONFIG_INVALID', message: `config_type invalid: ${logical}` };
    } else if (String(read.document[expectedIdKey] || '') !== id) {
      firstError = firstError || { code: 'CONFIG_INVALID', message: `wrong id in ${logical}` };
    }
    documents[id] = read.document;
  }

  if (String(systemRead.document.schema_version || '') !== '1.0' || String(systemRead.document.config_type || '') !== 'SYSTEM') {
    firstError = firstError || { code: 'CONFIG_INVALID', message: 'system.json schema invalid' };
  }

  return {
    ok: !firstError,
    error: firstError,
    source: {
      kind: 'MODULAR_JSON',
      config_path: systemLogical,
      schema_version: String(systemRead.document.schema_version || '1.0'),
      modified_at: systemRead.stat.mtime.toISOString(),
      config_hash: configHash(systemRead.document),
    },
    documents,
    entries,
    paths,
    stats,
  };
}

function sourceFor(pack, id) {
  const logical = (pack.paths && pack.paths[id]) || (REGISTRY[id] && logicalOf(REGISTRY[id].config_rel));
  const st = pack.stats && pack.stats[id];
  const doc = pack.documents && pack.documents[id];
  return {
    kind: 'MODULAR_JSON',
    config_path: logical,
    schema_version: doc && doc.schema_version ? String(doc.schema_version) : '1.0',
    modified_at: st ? st.mtime.toISOString() : null,
    config_hash: doc ? configHash(doc) : null,
  };
}

function loadDiskDocument() {
  const pack = loadModularPack();
  return {
    ok: pack.ok,
    error: pack.error,
    source: pack.source,
    document: pack.documents && pack.documents.SYSTEM,
    pack,
  };
}

function resolveDiskSource() {
  const pack = loadModularPack();
  const root = engineRoot();
  return {
    logical: pack.source.config_path,
    abs: path.join(root, pack.source.config_path),
    missing: Boolean(pack.error && pack.error.code === 'CONFIG_NOT_FOUND'),
    kind: 'MODULAR_JSON',
  };
}

function extractRawConfig(entry, pack) {
  if (!pack || !pack.documents) return null;
  const doc = pack.documents[entry.id];
  return doc === undefined ? null : doc;
}

function tradingPayload(entry, raw) {
  if (raw == null) return null;
  if (entry.id === 'S8') return raw;
  return stripWrapper(raw);
}

function marketHints(entry, raw) {
  const trading = tradingPayload(entry, raw) || {};
  const tf = trading.timeframe || trading.primary_timeframe || null;
  const symbols = entry.type === 'ALPHA' && entry.implemented ? ['BTC-USDT-SWAP'] : [];
  return {
    symbols,
    instrument: symbols[0] || null,
    timeframe: tf || null,
    default_active_strategy_id: 'S1',
  };
}

function statusDot(entry, pack, raw) {
  if (!entry.implemented) return 'NOT_IMPLEMENTED';
  if (!pack.ok) return 'INVALID';
  if (raw == null) return 'INVALID';
  if (entry.release_stage === 'RESEARCH') return 'RESEARCH';
  const trading = tradingPayload(entry, raw);
  if (trading && trading.enabled === false) return 'DISABLED';
  return 'READY';
}

function liveCapability(entry) {
  return Boolean(entry.live_policy_allowed);
}

function summaryRow(entry, pack, runtime) {
  const raw = extractRawConfig(entry, pack);
  const st = statusDot(entry, pack, raw);
  const market = pack.ok ? marketHints(entry, raw) : { symbols: [], timeframe: null };
  const active = Boolean(runtime && runtime.online && runtime.active_strategy === entry.id);
  return {
    id: entry.id,
    type: entry.type,
    name: entry.name,
    strategy_key: entry.strategy_key,
    release_stage: entry.release_stage,
    implemented: entry.implemented,
    demo_allowed: Boolean(entry.demo_allowed),
    live_allowed: liveCapability(entry),
    live_policy_allowed: Boolean(entry.live_policy_allowed),
    live_permission: livePermissionEnabled(),
    status: st,
    timeframe: market.timeframe,
    symbols: market.symbols,
    runtime_active: active,
    config_error: !pack.ok || (entry.implemented && raw == null),
  };
}

function overview(rows, runtime, pack) {
  const alphas = rows.filter((r) => r.type === 'ALPHA');
  const implemented = alphas.filter((r) => r.implemented).length;
  const research = alphas.filter((r) => !r.implemented || r.release_stage === 'RESEARCH').length;
  const demo = alphas.filter((r) => r.demo_allowed).length;
  const live = alphas.filter((r) => r.live_allowed).length;
  const enabled = runtime && runtime.online && runtime.active_strategy
    ? runtime.active_strategy
    : (runtime && runtime.online ? 'NONE' : 'OFFLINE');
  return {
    alpha_count: alphas.length,
    implemented_count: implemented,
    research_count: research,
    demo_allowed_count: demo,
    live_allowed_count: live,
    current_active: enabled,
    live_permission: livePermissionEnabled(),
    source_kind: (pack && pack.source && pack.source.kind) || 'MODULAR_JSON',
  };
}

function implementationOverlay(entry) {
  if (entry.id !== 'S1' || !entry.implemented) return null;
  return {
    stop: {
      source: 'CODE',
      module: 'src/runtime/demo_execute_v1.py',
      method: 'CONFIRMED_SWING_2X2',
      lookback_bars: 20,
      left_confirmation: 2,
      right_confirmation: 2,
      note: 'Official S1 structure stop. JSON only stores the formula + min bps. Not a second trading truth source.',
    },
  };
}

async function readRuntimeView(deps, id) {
  const fetchOne = deps && typeof deps.fetchRuntimeConfig === 'function' ? deps.fetchRuntimeConfig : null;
  if (!fetchOne) {
    return { online: false, state: 'OFFLINE', active_strategy: null, effective_config: null, effective_config_hash: null };
  }
  try {
    const data = await fetchOne(id);
    if (!data || typeof data !== 'object') {
      return { online: false, state: 'OFFLINE', active_strategy: null, effective_config: null, effective_config_hash: null };
    }
    const state = String(data.state || data.engine_state || '').toUpperCase() || 'UNKNOWN';
    const online = state !== 'OFFLINE' && data.online !== false;
    const effective = data.effective_config === undefined ? null : data.effective_config;
    return {
      online,
      state,
      active_strategy: data.active_strategy || null,
      effective_config: effective,
      effective_config_hash: data.effective_config_hash || (effective != null ? configHash(effective) : null),
      config_path: data.config_path || null,
      source_kind: data.source_kind || null,
      s9_readiness: data.s9_readiness || null,
    };
  } catch {
    return { online: false, state: 'OFFLINE', active_strategy: null, effective_config: null, effective_config_hash: null };
  }
}

function defaultRuntimeFetch() {
  return async function fetchRuntimeConfig(id) {
    const v41 = require('./v41EngineClient');
    if (!id) return v41.getStrategyConfigList();
    return v41.getStrategyConfig(id);
  };
}

function listConfigs(options = {}) {
  const pack = loadModularPack();
  return Promise.resolve(options.runtime || { online: false, state: 'OFFLINE', active_strategy: null })
    .then((runtime) => {
      const rows = [...ALPHA_IDS, ...SYSTEM_IDS].map((id) =>
        summaryRow(pack.entries[id] || REGISTRY[id], pack, runtime),
      );
      return {
        overview: overview(rows, runtime, pack),
        source: pack.source,
        load_error: pack.error,
        items: rows,
        alpha: rows.filter((r) => r.type === 'ALPHA'),
        system_modules: rows.filter((r) => r.type === 'SYSTEM'),
      };
    });
}

async function getConfig(rawId, options = {}) {
  const id = normalizeId(rawId);
  if (!ID_RE.test(id) || !REGISTRY[id]) {
    throw fail('STRATEGY_CONFIG_NOT_FOUND', 'unknown strategy config id', 404, { id: String(rawId || '') });
  }
  const pack = loadModularPack();
  const entry = pack.entries[id] || REGISTRY[id];
  const runtime = options.runtime || (await readRuntimeView(options.deps || { fetchRuntimeConfig: options.fetchRuntimeConfig }, id));
  const raw = extractRawConfig(entry, pack);
  const redactedRaw = raw == null ? null : redactSecrets(raw);
  const trading = redactedRaw == null ? null : redactSecrets(tradingPayload(entry, redactedRaw));
  const diskHash = trading == null ? null : configHash(trading);
  const display = redactedRaw && redactedRaw.display && typeof redactedRaw.display === 'object' ? redactedRaw.display : {};
  const effective = runtime.effective_config == null ? null : redactSecrets(runtime.effective_config);
  const effectiveTrading = effective == null ? null : (id === 'S8' ? effective : stripWrapper(effective));
  const effectiveHash = effectiveTrading != null ? configHash(effectiveTrading) : null;
  let config_match = null;
  if (!runtime.online) config_match = null;
  else if (diskHash && effectiveHash) config_match = diskHash === effectiveHash;
  else config_match = null;

  const invalid = Boolean((pack.error && pack.error.code) || (entry.implemented && raw == null));

  return {
    id: entry.id,
    type: entry.type,
    name: entry.name,
    strategy_key: entry.strategy_key,
    release: {
      stage: entry.release_stage,
      implemented: entry.implemented,
      demo_allowed: Boolean(entry.demo_allowed),
      live_allowed: liveCapability(entry),
      live_policy_allowed: Boolean(entry.live_policy_allowed),
      live_permission: livePermissionEnabled(),
    },
    implementation: entry.implementation,
    dependencies: entry.dependencies,
    preferred_sections: entry.preferred_sections,
    source: sourceFor(pack, id),
    raw_config: redactedRaw,
    display,
    summary_zh: display.summary_zh || '',
    entry_summary_zh: display.entry_summary_zh || '',
    risk_summary_zh: display.risk_summary_zh || '',
    exit_summary_zh: display.exit_summary_zh || '',
    effective_config: effective,
    implementation_overlay: implementationOverlay(entry),
    market: pack.ok ? marketHints(entry, raw) : { symbols: [], timeframe: null },
    runtime: {
      state: runtime.state || 'OFFLINE',
      online: Boolean(runtime.online),
      active: Boolean(runtime.online && runtime.active_strategy === entry.id),
      active_strategy: runtime.active_strategy || null,
      disk_config_hash: diskHash,
      file_hash: redactedRaw == null ? null : configHash(redactedRaw),
      effective_config_hash: runtime.online ? effectiveHash : null,
      config_match,
    },
    status: invalid ? 'INVALID' : statusDot(entry, pack, raw),
    error: invalid
      ? pack.error || { code: 'CONFIG_INVALID', message: `missing ${entry.config_rel}` }
      : null,
    s9_readiness:
      id === 'S9'
        ? require('./s9ReadinessOverlay').overlayS9RuntimeReadiness(
            runtime.s9_readiness || {
              S9_IMPLEMENTATION_READINESS: runtime.S9_IMPLEMENTATION_READINESS,
              S9_DEMO_PREFLIGHT_READINESS: runtime.S9_DEMO_PREFLIGHT_READINESS,
              S9_DEMO_VALIDATION_STATUS: 'UNVERIFIED',
            },
          )
        : undefined,
  };
}

async function listConfigsWithRuntime(deps) {
  const fetchRuntimeConfig = (deps && deps.fetchRuntimeConfig) || defaultRuntimeFetch();
  const runtime = await readRuntimeView({ fetchRuntimeConfig }, '');
  return listConfigs({ runtime });
}

async function getConfigWithRuntime(id, deps) {
  const fetchRuntimeConfig = (deps && deps.fetchRuntimeConfig) || defaultRuntimeFetch();
  return getConfig(id, { deps: { fetchRuntimeConfig } });
}

module.exports = {
  REGISTRY,
  ALPHA_IDS,
  SYSTEM_IDS,
  ID_RE,
  WRAPPER_KEYS,
  canonicalize,
  configHash,
  stripWrapper,
  redactSecrets,
  isSecretKey,
  isKnownId,
  normalizeId,
  resolveDiskSource,
  loadDiskDocument,
  loadModularPack,
  listConfigs,
  getConfig,
  listConfigsWithRuntime,
  getConfigWithRuntime,
  livePermissionEnabled,
};
