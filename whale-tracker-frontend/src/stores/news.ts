import { defineStore } from 'pinia';
import { ref } from 'vue';
import { fetchCalendar, fetchNews, isRetryableLoadError, retryableErrorText, scheduleSilentRetry, withRetrySuffix } from '@/api';
import type { CalendarEvent, NewsArticle } from '@/types';

export const useNewsStore = defineStore('news', () => {
  const articles = ref<NewsArticle[]>([]);
  const events = ref<CalendarEvent[]>([]);
  const keywords = ref<string[]>([]);
  const updatedAt = ref(0);
  const stale = ref(false);
  const loading = ref(false);
  const error = ref('');

  async function load(refresh = false, silent = false) {
    const first = !articles.value.length;
    if (!silent || first) loading.value = true;
    if (!silent) error.value = '';
    let retrying = false;
    try {
      const [news, calendar] = await Promise.all([
        fetchNews(refresh),
        fetchCalendar().catch(() => ({ events: [] as CalendarEvent[] })),
      ]);
      articles.value = news.articles || [];
      events.value = calendar.events || [];
      keywords.value = news.keywords || [];
      updatedAt.value = news.updatedAt || 0;
      stale.value = Boolean(news.stale);
      error.value = '';
      if (news.warning && (!silent || first) && !/timeout/i.test(news.warning)) {
        error.value = news.warning;
      }
    } catch (err) {
      retrying = isRetryableLoadError(err);
      if (retrying) {
        if (!silent || first) {
          error.value = withRetrySuffix(retryableErrorText(err, '新闻加载失败'));
        }
        scheduleSilentRetry('news', () => load(refresh, true));
      } else if (!silent || first) {
        error.value = err instanceof Error ? err.message : '新闻加载失败';
      }
    } finally {
      if (!(retrying && first)) loading.value = false;
    }
  }

  return {
    articles,
    events,
    keywords,
    updatedAt,
    stale,
    loading,
    error,
    load,
  };
});
