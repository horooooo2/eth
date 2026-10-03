const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeCatalog, normalizeRadarCatalog } = require('../lib/tradfiMarkets');

const exchangeInfo = {
  symbols: [
    { symbol: 'BTCUSDT', baseAsset: 'BTC', quoteAsset: 'USDT', status: 'TRADING', contractType: 'PERPETUAL', underlyingSubType: ['Crypto'] },
    { symbol: 'DOGEUSDT', baseAsset: 'DOGE', quoteAsset: 'USDT', status: 'TRADING', contractType: 'PERPETUAL', underlyingSubType: ['Crypto'] },
    { symbol: 'XAUUSDT', baseAsset: 'XAU', quoteAsset: 'USDT', status: 'TRADING', contractType: 'TRADIFI_PERPETUAL', underlyingSubType: ['TradFi'], underlyingType: 'COMMODITY' },
    { symbol: 'QQQUSDT', baseAsset: 'QQQ', quoteAsset: 'USDT', status: 'TRADING', contractType: 'TRADIFI_PERPETUAL', underlyingSubType: ['TradFi'], underlyingType: 'ETF' },
    { symbol: 'NVDAUSDT', baseAsset: 'NVDA', quoteAsset: 'USDT', status: 'TRADING', contractType: 'TRADIFI_PERPETUAL', underlyingSubType: ['TradFi'], underlyingType: 'EQUITY' },
    { symbol: 'SPCXUSDT', baseAsset: 'SPCX', quoteAsset: 'USDT', status: 'TRADING', contractType: 'TRADIFI_PERPETUAL', underlyingSubType: ['TradFi'], underlyingType: 'EQUITY' },
    { symbol: 'SNDKUSDT', baseAsset: 'SNDK', quoteAsset: 'USDT', status: 'TRADING', contractType: 'PERPETUAL', underlyingSubType: ['TradFi'], underlyingType: 'EQUITY' },
    { symbol: 'MICROCAPUSDT', baseAsset: 'MICROCAP', quoteAsset: 'USDT', status: 'TRADING', contractType: 'PERPETUAL', underlyingSubType: ['Crypto'] },
    { symbol: 'ETHUSDC', baseAsset: 'ETH', quoteAsset: 'USDC', status: 'TRADING', contractType: 'PERPETUAL', underlyingSubType: ['Crypto'] },
    { symbol: 'OLDUSDT', baseAsset: 'OLD', quoteAsset: 'USDT', status: 'BREAK', contractType: 'PERPETUAL', underlyingSubType: ['Crypto'] },
  ],
};

test('雷达目录包含 USDT 主流币与 TradFi 永续，同时保留旧 TradFi 目录边界', () => {
  const radar = normalizeRadarCatalog(exchangeInfo);
  assert.deepEqual(radar.map((row) => row.symbol), ['BTCUSDT', 'NVDAUSDT', 'QQQUSDT', 'SNDKUSDT', 'SPCXUSDT', 'XAUUSDT']);
  assert.equal(radar.find((row) => row.symbol === 'BTCUSDT').assetType, 'CRYPTO');
  assert.equal(radar.find((row) => row.symbol === 'SNDKUSDT').assetType, 'TRADFI');
  assert.equal(radar.find((row) => row.symbol === 'XAUUSDT').name, '黄金');
  assert.equal(radar.find((row) => row.symbol === 'NVDAUSDT').name, '英伟达');
  assert.equal(radar.find((row) => row.symbol === 'NVDAUSDT').radarTier, 'CORE');
  assert.equal(radar.find((row) => row.symbol === 'SPCXUSDT').name, 'SpaceX');
  assert.equal(radar.find((row) => row.symbol === 'SPCXUSDT').radarTier, 'VOLATILE');
  assert.equal(radar.some((row) => row.symbol === 'DOGEUSDT' || row.symbol === 'MICROCAPUSDT'), false);
  assert.equal(normalizeRadarCatalog(exchangeInfo, ['DOGEUSDT']).some((row) => row.symbol === 'DOGEUSDT'), true);
  assert.deepEqual(normalizeCatalog(exchangeInfo).map((row) => row.symbol), ['NVDAUSDT', 'QQQUSDT', 'SNDKUSDT', 'SPCXUSDT', 'XAUUSDT']);
});
