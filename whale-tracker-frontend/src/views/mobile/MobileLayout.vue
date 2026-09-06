<script setup lang="ts">
import { computed } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useDashboardBootstrap } from '@/composables/useDashboardBootstrap';
import { unlockAlertSound } from '@/utils/alertSound';

useDashboardBootstrap();

const route = useRoute();
const router = useRouter();

const tabs = [
  { name: 'm-home', label: '巨鲸', icon: 'whale' },
  { name: 'm-alerts', label: '异动', icon: '⚡' },
  { name: 'm-trades', label: '成交', icon: '⇄' },
  { name: 'm-me', label: '我的', icon: '···' },
] as const;

const active = computed(() => String(route.name || ''));

function go(name: string) {
  if (active.value === name) return;
  void router.push({ name });
}
</script>

<template>
  <div class="m-shell" @pointerdown="unlockAlertSound">
    <main class="m-main">
      <RouterView />
    </main>

    <nav class="m-tabs" aria-label="主导航">
      <button
        v-for="tab in tabs"
        :key="tab.name"
        type="button"
        class="m-tab"
        :class="{ active: active === tab.name }"
        @click="go(tab.name)"
      >
        <span class="m-tab-ico" aria-hidden="true">
          <svg
            v-if="tab.icon === 'whale'"
            class="whale-ico"
            viewBox="0 0 24 24"
            width="20"
            height="20"
            fill="currentColor"
          >
            <path
              d="M20.5 11.2c-.9-2.4-3.2-4.2-6-4.5-1.1-.1-2.2.1-3.1.5C9.8 5.4 7.4 4.2 4.8 4.5c-.4 0-.7.4-.6.8.3 1.3 1.1 2.4 2.2 3.1C4.9 9.5 3.5 11.2 3.2 13c-.2 1.2.1 2.4.8 3.4.7 1 1.8 1.6 3 1.7h.2c1.2 0 2.3-.5 3.1-1.3.7.5 1.6.8 2.5.8h.3c1.9-.1 3.6-1.1 4.6-2.6 1.2.3 2.5 0 3.4-.9.5-.5.8-1.2.8-1.9 0-.4-.3-.8-.7-.9-.4-.1-.8.1-.9.5-.1.3-.4.5-.7.5-.5 0-.9-.4-.9-.9 0-.3.1-.5.3-.7.2-.2.2-.5 0-.7-.1-.1-.3-.2-.5-.2-.6 0-1.1.3-1.4.8zM8.2 14.8c-.4 0-.8-.3-.8-.8s.3-.8.8-.8.8.3.8.8-.4.8-.8.8z"
            />
          </svg>
          <template v-else>{{ tab.icon }}</template>
        </span>
        <span class="m-tab-label">{{ tab.label }}</span>
      </button>
    </nav>
  </div>
</template>

<style scoped>
.m-shell {
  --m-bg: #0b0e14;
  --m-card: #141a24;
  --m-line: #1f2937;
  --m-text: #e8edf5;
  --m-muted: #6a7e9c;
  --m-soft: #8b9bb5;
  --m-gold: #fbbf24;
  --m-bull: #4ade80;
  --m-bear: #f87171;
  --m-tab-h: 56px;
  --m-safe-bottom: env(safe-area-inset-bottom, 0px);
  box-sizing: border-box;
  width: 100%;
  max-width: 480px;
  margin: 0 auto;
  height: 100vh;
  height: 100dvh;
  height: 100svh;
  max-height: 100svh;
  background: var(--m-bg);
  color: var(--m-text);
  display: flex;
  flex-direction: column;
  overflow: hidden;
  position: relative;
}
.m-main {
  flex: 1 1 auto;
  min-height: 0;
  overflow-x: hidden;
  overflow-y: auto;
  -webkit-overflow-scrolling: touch;
  overscroll-behavior: contain;
  padding: 12px 14px 16px;
}
.m-tabs {
  position: relative;
  z-index: 40;
  flex: 0 0 auto;
  width: 100%;
  display: flex;
  justify-content: space-around;
  gap: 4px;
  min-height: var(--m-tab-h);
  padding: 6px 8px calc(10px + var(--m-safe-bottom));
  background: #0f141c;
  border-top: 1px solid #1a1f2a;
  box-shadow: 0 -8px 24px #00000059;
}
.m-tab {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 2px;
  border: 0;
  background: transparent;
  color: var(--m-muted);
  font: inherit;
  padding: 6px 4px;
  min-height: 44px;
  -webkit-tap-highlight-color: transparent;
}
.m-tab.active {
  color: var(--m-gold);
}
.m-tab-ico {
  font-size: 18px;
  line-height: 1.2;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-height: 20px;
}
.whale-ico {
  color: #60a5fa;
}
.m-tab.active .whale-ico {
  color: #93c5fd;
}
.m-tab-label {
  font-size: 10px;
  font-weight: 600;
}
</style>
