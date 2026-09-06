<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import { fetchPagedTrades } from '@/api';
import { useWhaleStore } from '@/stores/whale';
import type { WhaleTrade } from '@/types';
import { enrichTrade } from '@/utils/tradeEnrichment';
import { formatPrice, formatTimeShort, formatUsd } from '@/utils/format';
import { resolveWhaleTitle } from '@/utils/whaleReference';
import { preferredCoinFilterOptions } from '@/utils/watchedCoins';
import {
  freshModeEnabled,
  freshWindowHours,
  freshWindowMs,
  isClearlyIncreaseTrade,
  isOpeningFillTrade,
  tradePassesFreshGate,
} from '@/utils/freshMode';

const PAGE_SIZE = 50;
const whaleStore = useWhaleStore();
const router = useRouter();

const page = ref(1);
const total = ref(0);
const loading = ref(false);
const trades = ref<WhaleTrade[]>([]);
const asset = ref('');

const pageCount = computed(() => Math.max(1, Math.ceil(total.value / PAGE_SIZE)));
const coinOptions = computed(() => preferredCoinFilterOptions());

const rows = computed(() => {
  void freshModeEnabled.value;
  void freshWindowHours.value;
  const now = Date.now();
  return trades.value
    .filter((t) => t.source !== 'onchain')
    .map((trade) => {
      const whale = whaleStore.enabledWhales.find((w) => w.id === trade.whaleId);
      return enrichTrade(trade, whale, {});
    })
    .filter((row) =>
      tradePassesFreshGate(
        row.trade,
        whaleStore.enabledWhales.find((w) => w.id === row.trade.whaleId) || null,
        now,
      ),
    );
});

async function loadPage() {
  loading.value = true;
  try {
    const data = await fetchPagedTrades({
      page: page.value,
      limit: PAGE_SIZE,
      asset: asset.value || undefined,
      sinceMs: freshModeEnabled.value ? Date.now() - freshWindowMs() : undefined,
    });
    trades.value = data.trades || [];
    total.value = data.total || trades.value.length;
  } catch {
    trades.value = [];
    total.value = 0;
  } finally {
    loading.value = false;
  }
}

function sideText(row: ReturnType<typeof enrichTrade>) {
  if (row.isClosing) return row.side === 'long' ? '减/平多' : '减/平空';
  if (isOpeningFillTrade(row.trade)) {
    return row.side === 'long' ? '开多' : '开空';
  }
  if (isClearlyIncreaseTrade(row.trade)) {
    return row.side === 'long' ? '加多' : '加空';
  }
  return row.side === 'long' ? '开/加多' : '开/加空';
}

function openWhale(id: string) {
  if (!id) return;
  void router.push({ name: 'm-home', query: { id } });
}

watch([page, asset, freshModeEnabled, freshWindowHours], ([, , ,], prev) => {
  if (prev && (freshModeEnabled.value !== prev[2] || freshWindowHours.value !== prev[3]) && page.value !== 1) {
    page.value = 1;
    return;
  }
  void loadPage();
});

onMounted(() => {
  void loadPage();
});
</script>

<template>
  <div class="m-trades">
    <div class="m-card-title">资金动态</div>
    <div class="filters">
      <button type="button" class="chip" :class="{ on: !asset }" @click="asset = ''; page = 1">全部</button>
      <button
        v-for="opt in coinOptions.slice(0, 6)"
        :key="opt.value"
        type="button"
        class="chip"
        :class="{ on: asset === opt.value }"
        @click="asset = opt.value; page = 1"
      >
        {{ opt.label }}
      </button>
    </div>

    <div class="list-area" v-loading="loading">
      <div v-if="!loading && !rows.length" class="m-empty">暂无成交</div>
      <div v-else-if="rows.length" class="list">
        <button
          v-for="row in rows"
          :key="row.trade.id"
          type="button"
          class="item"
          @click="openWhale(row.trade.whaleId || '')"
        >
          <div class="top">
            <span class="type" :class="row.side || ''">
              {{ sideText(row) }}
              <span class="coin">· {{ row.trade.assetLabel || row.trade.asset }}</span>
            </span>
            <span class="usd">{{ formatUsd(row.trade.amountUsd) }}</span>
          </div>
          <div class="bot">
            <span>{{ resolveWhaleTitle(whaleStore.enabledWhales, { id: row.trade.whaleId || '', name: row.trade.whaleName }) }}</span>
            <span>{{ formatPrice(row.trade.price) }} · {{ formatTimeShort(row.trade.time) }}</span>
          </div>
        </button>
      </div>
      <div v-else class="m-empty">加载中…</div>
    </div>

    <div v-if="total > PAGE_SIZE" class="m-pager">
      <button type="button" class="pg" :disabled="page <= 1" @click="page = 1">首页</button>
      <button type="button" class="pg" :disabled="page <= 1" @click="page -= 1">上一页</button>
      <span class="pg-info">{{ page }}/{{ pageCount }} · {{ total }}</span>
      <button type="button" class="pg" :disabled="page >= pageCount" @click="page += 1">下一页</button>
    </div>
  </div>
</template>

<style scoped>
.m-card-title {
  font-size: 13px;
  font-weight: 700;
  color: #8b9bb5;
  margin-bottom: 10px;
}
.filters {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-bottom: 12px;
}
.chip {
  border: 0;
  border-radius: 999px;
  padding: 4px 12px;
  background: #1a222e;
  color: #8b9bb5;
  font: inherit;
  font-size: 12px;
  font-weight: 700;
}
.chip.on {
  background: #2a3a52;
  color: #f0f4fa;
}
.list-area {
  position: relative;
  min-height: 120px;
}
.list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.item {
  text-align: left;
  border: 1px solid #1a222e;
  background: #10171f;
  border-radius: 14px;
  padding: 12px;
  color: inherit;
  font: inherit;
}
.top,
.bot {
  display: flex;
  justify-content: space-between;
  gap: 8px;
}
.bot {
  margin-top: 6px;
  font-size: 12px;
  color: #8b9bb5;
}
.type {
  font-size: 13px;
  font-weight: 800;
}
.type.long {
  color: #4ade80;
}
.type.short {
  color: #f87171;
}
.coin {
  color: #8b9bb5;
  font-weight: 600;
}
.usd {
  font-weight: 700;
  font-size: 13px;
}
.m-empty {
  text-align: center;
  color: #6a7e9c;
  padding: 28px 8px;
  font-size: 13px;
}
.m-pager {
  display: flex;
  justify-content: center;
  align-items: center;
  gap: 8px;
  margin-top: 12px;
  flex-wrap: wrap;
}
.pg {
  border: 0;
  border-radius: 999px;
  padding: 4px 12px;
  background: #1a222e;
  color: #b0c4de;
  font: inherit;
  font-size: 12px;
  font-weight: 700;
}
.pg:disabled {
  opacity: 0.4;
}
.pg-info {
  font-size: 12px;
  color: #e8edf5;
  font-weight: 600;
}
</style>
