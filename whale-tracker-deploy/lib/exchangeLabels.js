/**
 * 常见交易所热钱包（小写 0x）。API 未标注 owner 时用于补全「[交易所名]」。
 */
const EXCHANGE_ADDRESSES = new Map([
  // Binance
  ['0x28c6c06298d514db089934071355e5743bf21d60', 'Binance'],
  ['0x21a31ee1afc51d94c2efccaa2092ad1028285549', 'Binance'],
  ['0xdfd5293d8e347dfe59e90efd55b2956a1343963d', 'Binance'],
  ['0x56eddb7aa87536c195933ec18e4a75b57e24c0aa', 'Binance'],
  ['0xf977814e90da44bfa03b6295a0616a897441acec', 'Binance'],
  ['0xbe0eb53f46cd790cd13851f5ca36f8b7d3d65ab6', 'Binance'],
  ['0x5a52e96bacdabb82fd05763e25335261b270efcb', 'Binance'],
  ['0x3f5ce5fbfe3e9af3971dd833d26ba9b5c936f0be', 'Binance'],
  ['0xd551234ae421e3bcba99a0da6d736074f22192ff', 'Binance'],
  ['0x564286362092d8e7936f0548241a90a3c7d5c4eb', 'Binance'],
  ['0x0681d8db095565fe8a346fa0277bffde9c0edbbf', 'Binance'],
  ['0xfe9e8709d3215319030ad1c9e4cbad3d5e0c7a0b', 'Binance'],
  ['0x4e9ce17857b23e1e2c5e77628a1c3c774f185b8b', 'Binance'],
  ['0x85b931a32a0725be14285b66f1a22178c672d69b', 'Binance'],
  ['0x708396f17127c42383e3b9014072679b2f60b82f', 'Binance'],
  ['0xe0f0cfde7ee664943906f37f866a0aa70d17e842', 'Binance'],
  ['0x001866ae5b3de6caa5a51543fd9fb64f524f5478', 'Binance'],
  // Coinbase
  ['0x71660c4005ba85c37ccec55d0c4493e66fe775d3', 'Coinbase'],
  ['0x503828976d22510aad0201ac7ec88293211d23da', 'Coinbase'],
  ['0xddfabcdc4d8ffc6d5beaf154f18b778f892a0740', 'Coinbase'],
  ['0x3cd751e6b11165aa7263047a64bc9c9f1e5e4d5a', 'Coinbase'],
  ['0xb5d85cbf7cb3ee0d56b3bb207d5fc4b82f43f511', 'Coinbase'],
  ['0xa9d1e08c7793af67e9d92fe308d5697fb81d3e43', 'Coinbase'],
  // Kraken
  ['0x2910543af39aba0cd09dab72a1bc7b1b3d5d3e8e', 'Kraken'],
  ['0x0a869d79a7052c7f1b55a8ebabbea3420f0d1e13', 'Kraken'],
  ['0xe853c56864a2ebe4576a807d26fdc4a0ada51919', 'Kraken'],
  ['0x267be1c1d684f78cb4f6a176c4911b741e4ffdc0', 'Kraken'],
  ['0xfa52274dd61e1643d2205169732f291441df4748', 'Kraken'],
  // Bitfinex
  ['0x1151314c646ce4e0efd76d1af4760ae66a9fe30f', 'Bitfinex'],
  ['0x742d35cc6634c0532925a3b844bc454e4438f44e', 'Bitfinex'],
  ['0x876eabf441b2ee5b5b0554fd502a8e0600950cfa', 'Bitfinex'],
  ['0x77134cbc06cb00b66f4c7e623d5fdbf6777635ec', 'Bitfinex'],
  // OKX
  ['0x6cc5f688a315f3dc28a925cc3b5c2d78c6a8a7c8', 'OKX'],
  ['0x98ec059dc3adfbdd63429454aeb0c990fba4a128', 'OKX'],
  ['0x236f9f97e0e62388479bf9e5ba4889e46b0273c3', 'OKX'],
  // Gate.io
  ['0x0d0707963952f2fba59dd06f2b425ace40b492fe', 'Gate.io'],
  // HTX
  ['0x18709e89bd403f470088abdacebe86cc60dda12e', 'HTX'],
  ['0x46705dfff24256421a05d056c29e81bdc09723b8', 'HTX'],
  ['0xdc76cd25977e0a5ae17155770273ad58648900d3', 'HTX'],
  // Gemini
  ['0xd24400ae8bfebb18ca49be86258a3c749cf46853', 'Gemini'],
  ['0x6fc82a5fe25a5cdb58bc74600a40a69c065263f8', 'Gemini'],
  // Bitstamp
  ['0x1522900b6dafac587d499a862861c0869be6e428', 'Bitstamp'],
  // Crypto.com
  ['0xcffad3200574698b78f32232aa9d63eabd290703', 'Crypto.com'],
  ['0x6262998ced04146fa42253a5c0f21a1ce62533ae', 'Crypto.com'],
  // KuCoin
  ['0x2b5634c42055806a59e9107ed44d43c426e58258', 'KuCoin'],
]);

const EXCHANGE_TYPE_HINTS =
  /exchange|cex|binance|coinbase|kraken|okx|okex|bybit|bitfinex|huobi|htx|gate|kucoin|gemini|bitstamp|crypto\.com|bitmex|deribit/i;

function normalizeAddrKey(address) {
  const raw = String(address || '').trim();
  if (!raw) return '';
  if (/^0x/i.test(raw)) return raw.toLowerCase();
  return raw;
}

function lookupExchangeByAddress(address) {
  const key = normalizeAddrKey(address);
  if (!key) return '';
  return EXCHANGE_ADDRESSES.get(key) || '';
}

function isExchangeParty(label, ownerType, address) {
  if (lookupExchangeByAddress(address)) return true;
  if (label && EXCHANGE_TYPE_HINTS.test(label)) return true;
  if (ownerType && EXCHANGE_TYPE_HINTS.test(ownerType)) return true;
  return false;
}

function resolvePartyMeta(party, address) {
  const ownerType = String(
    (party && typeof party === 'object' && (party.ownerType || party.type || party.owner_type)) || '',
  ).trim();
  const apiOwner = String(
    (party && typeof party === 'object' && (party.owner || party.name || party.label || party.exchange)) ||
      '',
  ).trim();
  const mapped = lookupExchangeByAddress(address);
  const label = mapped || apiOwner;
  const isExchange = isExchangeParty(label, ownerType, address);
  return { label, ownerType, isExchange };
}

function formatExchangeTag(label) {
  if (!label) return '';
  const cleaned = String(label).replace(/^\[|\]$/g, '').trim();
  if (!cleaned || /^unknown$/i.test(cleaned) || /^whale$/i.test(cleaned)) return '';
  return `[${cleaned}]`;
}

function resolveFlowDirection(fromMeta, toMeta) {
  if (fromMeta.isExchange && toMeta.isExchange) return 'exchange';
  if (toMeta.isExchange && !fromMeta.isExchange) return 'inflow';
  if (fromMeta.isExchange && !toMeta.isExchange) return 'outflow';
  return 'transfer';
}

module.exports = {
  EXCHANGE_ADDRESSES,
  lookupExchangeByAddress,
  resolvePartyMeta,
  formatExchangeTag,
  resolveFlowDirection,
};
