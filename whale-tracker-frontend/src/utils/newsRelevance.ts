import type { NewsArticle } from '@/types';

export type NewsTopicTag = 'BTC' | 'ETH' | '宏观';

const BTC_PATTERN = /\bBTC\b|比特币|Bitcoin/i;
const ETH_PATTERN = /\bETH\b|以太坊|Ethereum|以太/i;
const MACRO_PATTERN =
  /美联储|央行|通胀|CPI|PPI|非农|利率|GDP|关税|就业|量化宽松|加息|降息|日本央行|韩国|宏观|ETF|监管|地缘|战争|原油|美元|美债/i;

export function newsTopicTags(item: Pick<NewsArticle, 'title' | 'summary' | 'matchedKeywords'>): NewsTopicTag[] {
  const text = `${item.title || ''} ${item.summary || ''} ${(item.matchedKeywords || []).join(' ')}`;
  const tags: NewsTopicTag[] = [];
  if (BTC_PATTERN.test(text)) tags.push('BTC');
  if (ETH_PATTERN.test(text)) tags.push('ETH');
  if (MACRO_PATTERN.test(text) || !tags.length) tags.push('宏观');
  return [...new Set(tags)];
}

export function topicTagEffect(tag: NewsTopicTag, focusCoin?: string) {
  if (focusCoin && tag === focusCoin) return 'dark' as const;
  return 'plain' as const;
}

export function topicTagType(tag: NewsTopicTag, focusCoin?: string) {
  if (focusCoin && tag === focusCoin) return 'success' as const;
  if (tag === 'BTC') return 'warning' as const;
  if (tag === 'ETH') return 'primary' as const;
  return 'info' as const;
}
