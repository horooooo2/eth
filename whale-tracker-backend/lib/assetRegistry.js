/**
 * 标的注册表：明确资产类型，替代「代码长度推断公司类」
 */
const CRYPTO_SPOT_OR_PERP = new Set([
  'BTC', 'ETH', 'SOL', 'BNB', 'XRP', 'DOGE', 'ADA', 'AVAX', 'DOT', 'LINK',
  'UNI', 'AAVE', 'ATOM', 'NEAR', 'APT', 'SUI', 'ARB', 'OP', 'HYPE', 'TON',
  'TRX', 'LTC', 'BCH', 'FIL', 'INJ', 'SEI', 'PEPE', 'WIF', 'BONK',
]);

/** @type {Record<string, { assetType: string, entity: string, instrumentType: string, benchmark: string, names?: string[], newsQuery?: string }>} */
const REGISTRY = {
  BTC: { assetType: 'crypto', entity: 'Bitcoin', instrumentType: 'perp', benchmark: 'BTC', names: ['BTC', '比特币', 'Bitcoin'] },
  ETH: { assetType: 'crypto', entity: 'Ethereum', instrumentType: 'perp', benchmark: 'BTC', names: ['ETH', '以太坊', 'Ethereum'] },
  SOL: { assetType: 'crypto', entity: 'Solana', instrumentType: 'perp', benchmark: 'BTC', names: ['SOL', 'Solana', '索拉纳'] },
  HYPE: { assetType: 'crypto', entity: 'Hyperliquid', instrumentType: 'perp', benchmark: 'BTC', names: ['HYPE', 'Hyperliquid'] },
  BNB: { assetType: 'crypto', entity: 'BNB', instrumentType: 'perp', benchmark: 'BTC' },
  SNDK: {
    assetType: 'equity_mapped',
    entity: 'SanDisk',
    instrumentType: 'perp',
    benchmark: 'NDX',
    names: ['SNDK', 'SanDisk', '闪迪'],
    newsQuery: 'SanDisk OR SNDK 闪迪',
  },
  UNITREE: {
    assetType: 'equity_mapped',
    entity: 'Unitree',
    instrumentType: 'perp',
    benchmark: 'STAR50',
    names: ['Unitree', '宇树科技', '宇树'],
    newsQuery: 'Unitree Robotics OR 宇树科技',
  },
  TSLA: {
    assetType: 'equity_mapped',
    entity: 'Tesla',
    instrumentType: 'perp',
    benchmark: 'NDX',
    names: ['Tesla', '特斯拉', 'TSLA'],
    newsQuery: 'Tesla OR 特斯拉 股票',
  },
  NVDA: {
    assetType: 'equity_mapped',
    entity: 'Nvidia',
    instrumentType: 'perp',
    benchmark: 'NDX',
    names: ['Nvidia', '英伟达', 'NVDA'],
    newsQuery: 'Nvidia OR 英伟达',
  },
  AAPL: { assetType: 'equity_mapped', entity: 'Apple', instrumentType: 'perp', benchmark: 'NDX', names: ['Apple', '苹果', 'AAPL'] },
  MSFT: { assetType: 'equity_mapped', entity: 'Microsoft', instrumentType: 'perp', benchmark: 'NDX' },
  META: { assetType: 'equity_mapped', entity: 'Meta', instrumentType: 'perp', benchmark: 'NDX' },
  GOOGL: { assetType: 'equity_mapped', entity: 'Alphabet', instrumentType: 'perp', benchmark: 'NDX' },
  AMZN: { assetType: 'equity_mapped', entity: 'Amazon', instrumentType: 'perp', benchmark: 'NDX' },
  COIN: { assetType: 'equity_mapped', entity: 'Coinbase', instrumentType: 'perp', benchmark: 'NDX', names: ['Coinbase', 'COIN'] },
  MSTR: {
    assetType: 'equity_mapped',
    entity: 'MicroStrategy',
    instrumentType: 'perp',
    benchmark: 'BTC',
    names: ['MicroStrategy', 'Strategy', 'MSTR'],
    newsQuery: 'MicroStrategy OR Strategy bitcoin',
  },
};

function normalizeId(raw) {
  return String(raw || '')
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');
}

/** 旧逻辑 fallback：短代码且不在主流加密 → 视为公司类映射 */
function legacyEquityLike(id) {
  if (CRYPTO_SPOT_OR_PERP.has(id)) return false;
  if (REGISTRY[id]?.assetType === 'crypto') return false;
  return id.length >= 2 && id.length <= 5;
}

function resolveAsset(coinInput) {
  const id = normalizeId(coinInput) || 'BTC';
  const row = REGISTRY[id];
  if (row) {
    return {
      id,
      assetType: row.assetType,
      entity: row.entity,
      instrumentType: row.instrumentType || 'perp',
      benchmark: row.benchmark || (row.assetType === 'crypto' ? 'BTC' : 'NDX'),
      names: [...new Set([id, ...(row.names || [])])],
      newsQuery: row.newsQuery || null,
      equityLike: row.assetType === 'equity_mapped',
      fromRegistry: true,
    };
  }

  const equityLike = legacyEquityLike(id);
  return {
    id,
    assetType: equityLike ? 'equity_mapped' : CRYPTO_SPOT_OR_PERP.has(id) ? 'crypto' : 'unknown',
    entity: id,
    instrumentType: 'perp',
    benchmark: equityLike ? 'NDX' : 'BTC',
    names: [id],
    newsQuery: null,
    equityLike,
    fromRegistry: false,
    fallback: true,
  };
}

module.exports = {
  REGISTRY,
  CRYPTO_SPOT_OR_PERP,
  normalizeId,
  resolveAsset,
  legacyEquityLike,
};
