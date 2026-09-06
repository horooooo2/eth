<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from 'vue';
import { fetchXFeed, type XFeedAccount, type XFeedTweet } from '@/api';
import { clearXUnread, consumeXSocketTweets, xSocketTweets } from '@/stores/xFeed';

const COLLAPSE_MAX = 200;

const props = defineProps<{
  limit?: number;
  bootReady?: boolean;
  /** 当前是否在 X Tab（用于清未读） */
  active?: boolean;
}>();

const loading = ref(false);
const error = ref('');
const tweets = ref<XFeedTweet[]>([]);
const accounts = ref<XFeedAccount[]>([]);
const updatedAt = ref(0);
const loaded = ref(false);
const filterUser = ref('all');
/** 已展开的推文 id */
const expandedIds = ref<Set<string>>(new Set());
/** 正文实际高度超过 200px 的推文 */
const overflowIds = ref<Set<string>>(new Set());
const bodyEls = new Map<string, HTMLElement>();

function isExpanded(id: string) {
  return expandedIds.value.has(id);
}

function isOverflow(id: string) {
  return overflowIds.value.has(id);
}

function canToggle(id: string) {
  return isOverflow(id) || isExpanded(id);
}

function toggleExpand(id: string) {
  if (!canToggle(id)) return;
  const next = new Set(expandedIds.value);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  expandedIds.value = next;
  scheduleMeasure();
}

function setBodyRef(id: string, el: unknown) {
  if (el instanceof HTMLElement) bodyEls.set(id, el);
  else bodyEls.delete(id);
}

function sameIdSet(a: Set<string>, b: Set<string>) {
  if (a.size !== b.size) return false;
  for (const id of a) {
    if (!b.has(id)) return false;
  }
  return true;
}

function measureAll() {
  const next = new Set<string>();
  for (const [id, el] of bodyEls) {
    if (el.scrollHeight > COLLAPSE_MAX + 1) next.add(id);
  }
  // 避免每次赋新 Set 触发无限更新
  if (sameIdSet(overflowIds.value, next)) return;
  overflowIds.value = next;
}

function scheduleMeasure() {
  void nextTick(() => {
    requestAnimationFrame(() => measureAll());
  });
}

const filterOptions = computed(() => {
  const base = [{ username: 'all', label: '全部' }];
  const fromApi = (accounts.value || []).map((a) => ({
    username: a.username,
    label: a.label || a.name || a.username,
  }));
  if (fromApi.length) return [...base, ...fromApi];
  return [
    ...base,
    { username: 'VitalikButerin', label: 'V神' },
    { username: 'elonmusk', label: '马斯克' },
    { username: 'cz_binance', label: 'CZ' },
  ];
});

const visibleTweets = computed(() => {
  const u = filterUser.value;
  if (!u || u === 'all') return tweets.value;
  return tweets.value.filter(
    (t) => String(t.username || t.user?.username || '').toLowerCase() === u.toLowerCase(),
  );
});

function formatTime(raw?: string | null) {
  if (!raw) return '—';
  const t = Date.parse(raw);
  if (!Number.isFinite(t)) return String(raw).slice(0, 24);
  return new Date(t).toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function formatCount(n?: number) {
  const v = Number(n) || 0;
  if (v >= 1e6) return `${(v / 1e6).toFixed(1)}M`;
  if (v >= 1e3) return `${(v / 1e3).toFixed(1)}K`;
  return String(v);
}

function displayText(item: XFeedTweet) {
  return (item.textZh || item.text || '').trim();
}

function showOriginal(item: XFeedTweet) {
  return Boolean(item.textZh && item.text && item.textZh !== item.text);
}

function refLabel(item: XFeedTweet) {
  if (item.refKind === 'retweet') return '转发';
  if (item.refKind === 'quote' || item.isQuote) return '引用';
  return '相关';
}

function mergeTweets(incoming: XFeedTweet[]) {
  if (!incoming?.length) return;
  const map = new Map(tweets.value.map((t) => [t.id, t]));
  for (const t of incoming) {
    if (!t?.id) continue;
    const prev = map.get(t.id);
    map.set(t.id, prev ? { ...prev, ...t, textZh: t.textZh || prev.textZh } : t);
  }
  tweets.value = [...map.values()].sort((a, b) => {
    const ta = Date.parse(a.createdAt || '') || 0;
    const tb = Date.parse(b.createdAt || '') || 0;
    return tb - ta;
  });
}

async function load() {
  if (loading.value) return;
  loading.value = true;
  error.value = '';
  try {
    const data = await fetchXFeed({ limit: props.limit || 40 });
    accounts.value = data.accounts || [];
    tweets.value = data.tweets || [];
    updatedAt.value = data.updatedAt || data.refreshedAt || Date.now();
    loaded.value = true;
    mergeTweets(consumeXSocketTweets());
    scheduleMeasure();
  } catch (err) {
    error.value = err instanceof Error ? err.message : 'X 推文加载失败';
  } finally {
    loading.value = false;
  }
}

watch(
  () => props.bootReady,
  (ready) => {
    if (!ready) return;
    if (!loaded.value) void load();
  },
  { immediate: true },
);

watch(
  () => props.active,
  (active) => {
    if (active) {
      clearXUnread();
      scheduleMeasure();
    }
  },
  { immediate: true },
);

watch(xSocketTweets, (list) => {
  if (!list.length) return;
  mergeTweets(consumeXSocketTweets());
  if (props.active) clearXUnread();
  scheduleMeasure();
});

watch(filterUser, () => {
  scheduleMeasure();
});

onMounted(() => {
  if (props.bootReady && !loaded.value) void load();
});
</script>

<template>
  <div class="x-feed">
    <header class="x-head">
      <div class="filters">
        <button
          v-for="opt in filterOptions"
          :key="opt.username"
          type="button"
          class="chip"
          :class="{ on: filterUser === opt.username }"
          @click="filterUser = opt.username"
        >
          {{ opt.label }}
        </button>
      </div>
      <button type="button" class="refresh" :disabled="loading" @click="load()">刷新</button>
    </header>

    <el-skeleton v-if="loading && !tweets.length" :rows="6" animated />
    <el-alert v-else-if="error && !tweets.length" type="warning" :closable="false" :title="error" />
    <el-empty v-else-if="!visibleTweets.length" description="暂无推文" />
    <div v-else class="list">
      <article
        v-for="item in visibleTweets"
        :key="item.id"
        class="tweet"
        :class="{
          expanded: isExpanded(item.id),
          collapsible: isOverflow(item.id),
        }"
      >
        <div class="who">
          <img
            v-if="item.user?.avatar"
            class="avatar"
            :src="item.user.avatar"
            :alt="item.label || item.username"
          />
          <div class="meta">
            <strong>{{ item.label || item.user?.name || item.username }}</strong>
            <span class="handle">@{{ item.username || item.user?.username }}</span>
          </div>
        </div>
        <div
          class="body"
          :ref="(el) => setBodyRef(item.id, el)"
          :class="{ clickable: canToggle(item.id) }"
          @click="toggleExpand(item.id)"
        >
          <p class="text">{{ displayText(item) }}</p>
          <p v-if="showOriginal(item)" class="orig">{{ item.text }}</p>

          <div v-if="item.refTweet" class="ref">
            <div class="ref-head">
              <span class="ref-kind">{{ refLabel(item) }}</span>
              <strong>{{ item.refTweet.user?.name || item.refTweet.user?.username }}</strong>
              <span class="handle">@{{ item.refTweet.user?.username }}</span>
            </div>
            <p class="text">{{ displayText(item.refTweet) }}</p>
            <p v-if="showOriginal(item.refTweet)" class="orig">{{ item.refTweet.text }}</p>
          </div>
          <div
            v-else-if="item.isQuote || item.isRetweet"
            class="ref ref-missing"
          >
            {{ item.isRetweet ? '转发内容未返回' : '引用推文详情未返回' }}（可点打开在 X 查看）
          </div>

          <div
            v-if="isOverflow(item.id) && !isExpanded(item.id)"
            class="fade"
            aria-hidden="true"
          />
        </div>
        <div class="foot">
          <span class="time">{{ formatTime(item.createdAt) }}</span>
          <span>转 {{ formatCount(item.retweets) }}</span>
          <span>赞 {{ formatCount(item.likes) }}</span>
          <span v-if="item.views">阅 {{ formatCount(item.views) }}</span>
          <button
            v-if="canToggle(item.id)"
            type="button"
            class="expand"
            @click="toggleExpand(item.id)"
          >
            {{ isExpanded(item.id) ? '收起' : '展开' }}
          </button>
          <a
            v-if="item.url"
            class="open"
            :class="{ 'ml-auto': !canToggle(item.id) }"
            :href="item.url"
            target="_blank"
            rel="noopener noreferrer"
            @click.stop
          >
            打开
          </a>
        </div>
      </article>
    </div>
  </div>
</template>

<style scoped>
.x-feed {
  height: 100%;
  min-height: 0;
  display: flex;
  flex-direction: column;
  color: var(--text);
}
.x-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 10px 14px;
  border-bottom: 1px solid var(--border);
  flex-shrink: 0;
}
.filters {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  min-width: 0;
}
.chip {
  height: 26px;
  padding: 0 10px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: transparent;
  color: var(--muted);
  font: inherit;
  font-size: 12px;
  cursor: pointer;
}
.chip.on {
  color: var(--accent, #1d9bf0);
  border-color: color-mix(in srgb, var(--accent, #1d9bf0) 45%, var(--border));
  background: color-mix(in srgb, var(--accent, #1d9bf0) 14%, transparent);
}
.refresh {
  flex-shrink: 0;
  height: 28px;
  padding: 0 10px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: transparent;
  color: var(--text);
  font: inherit;
  font-size: 12px;
  cursor: pointer;
}
.refresh:disabled {
  opacity: 0.5;
  cursor: default;
}
.list {
  flex: 1;
  min-height: 0;
  overflow: auto;
  padding: 8px 10px 12px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.tweet {
  padding: 10px 12px;
  border: 1px solid var(--border);
  border-radius: 10px;
  background: color-mix(in srgb, var(--card) 88%, transparent);
}
.body {
  position: relative;
}
.body.clickable {
  cursor: pointer;
}
.tweet.collapsible:not(.expanded) .body {
  max-height: 200px;
  overflow: hidden;
}
.tweet.expanded .body {
  max-height: none;
  overflow: visible;
}
.fade {
  pointer-events: none;
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  height: 40px;
  background: linear-gradient(
    to bottom,
    transparent,
    color-mix(in srgb, var(--card) 92%, transparent)
  );
}
.who {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 8px;
}
.avatar {
  width: 28px;
  height: 28px;
  border-radius: 50%;
  object-fit: cover;
  background: var(--border);
}
.meta {
  display: flex;
  flex-direction: column;
  gap: 1px;
  min-width: 0;
}
.meta strong {
  font-size: 13px;
  line-height: 1.2;
}
.handle {
  font-size: 11px;
  color: var(--muted);
}
.text {
  margin: 0;
  font-size: 13px;
  line-height: 1.5;
  white-space: pre-wrap;
  word-break: break-word;
}
.orig {
  margin: 6px 0 0;
  font-size: 11px;
  line-height: 1.45;
  color: var(--muted);
  white-space: pre-wrap;
  word-break: break-word;
}
.ref {
  margin-top: 8px;
  padding: 8px 10px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: color-mix(in srgb, var(--bg, #0b0f14) 35%, transparent);
}
.ref-missing {
  font-size: 12px;
  color: var(--muted);
}
.ref-head {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 6px;
  margin-bottom: 6px;
  font-size: 12px;
}
.ref-kind {
  font-size: 11px;
  color: var(--accent, #1d9bf0);
}
.foot {
  margin-top: 8px;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px;
  font-size: 11px;
  color: var(--muted);
}
.expand {
  margin-left: auto;
  padding: 0;
  border: 0;
  background: transparent;
  color: var(--accent, #1d9bf0);
  font: inherit;
  font-size: 11px;
  cursor: pointer;
}
.expand:hover {
  text-decoration: underline;
}
.open {
  color: var(--accent, #1d9bf0);
  text-decoration: none;
}
.open.ml-auto {
  margin-left: auto;
}
.open:hover {
  text-decoration: underline;
}
</style>
