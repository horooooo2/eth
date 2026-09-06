import { ref } from 'vue';

export interface OkxOpenAlert {
  id: string;
  at: number;
  traderId: string;
  traderName: string;
  kind: 'open';
  kindLabel: string;
  headline: string;
  coin?: string;
  instId?: string;
  side?: 'long' | 'short';
  lever?: number | null;
  margin?: number | null;
  price?: number | null;
  subPosId?: string;
  source?: string;
}

const DOCK_MAX = 20;

export const okxAlerts = ref<OkxOpenAlert[]>([]);

export function ingestOkxAlert(alert: OkxOpenAlert) {
  if (!alert?.id || !alert.traderId) return;
  const next = [alert, ...okxAlerts.value.filter((item) => item.id !== alert.id)];
  okxAlerts.value = next.slice(0, DOCK_MAX);
}

export function dismissOkxAlert(id: string) {
  okxAlerts.value = okxAlerts.value.filter((item) => item.id !== id);
}

export function clearOkxAlerts() {
  okxAlerts.value = [];
}
