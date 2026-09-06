import { ref } from 'vue';
import type { XFeedTweet } from '@/api';

/** X Tab 未读（Socket 推到新推文且当前不在 X） */
export const xUnread = ref(false);
/** Socket 增量，供 XFeed 合并 */
export const xSocketTweets = ref<XFeedTweet[]>([]);

export function noteXTweets(tweets: XFeedTweet[]) {
  const list = Array.isArray(tweets) ? tweets.filter((t) => t?.id) : [];
  if (!list.length) return;
  const seen = new Set(xSocketTweets.value.map((t) => t.id));
  const add = list.filter((t) => !seen.has(t.id));
  if (!add.length) return;
  xSocketTweets.value = [...add, ...xSocketTweets.value].slice(0, 80);
  xUnread.value = true;
}

export function clearXUnread() {
  xUnread.value = false;
}

export function consumeXSocketTweets() {
  const list = xSocketTweets.value;
  xSocketTweets.value = [];
  return list;
}
