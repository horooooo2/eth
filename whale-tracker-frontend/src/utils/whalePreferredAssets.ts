import { computed } from 'vue';
import { useWhaleStore } from '@/stores/whale';
import { preferredCoinsState } from './watchedCoins';
import { whaleUnderlyingAliases } from './whaleAssetLabel';

export function preferredWhaleAssets(crypto: string[], available: string[]) {
  const wanted = new Set(crypto.map(s => s.toUpperCase()));
  const matches = available.filter(coin => {
    const ticker = coin.split(':').pop()?.toUpperCase() || '';
    return wanted.has(ticker) || wanted.has(whaleUnderlyingAliases[ticker] || ticker);
  });
  return [...new Set(crypto.flatMap(pref => {
    const key = pref.toUpperCase();
    const found = matches.filter(coin => {
      const ticker = coin.split(':').pop()?.toUpperCase() || '';
      return ticker === key || whaleUnderlyingAliases[ticker] === key;
    });
    return found.length ? found : [pref];
  }))];
}
export function useWhalePreferredAssets() {
  const store = useWhaleStore();
  return computed<string[]>((previous) => {
    const next = preferredWhaleAssets(preferredCoinsState.value, [
    ...store.enabledWhales.flatMap(w => (w.positions || []).map(p => p.coin)),
    ...Object.values(store.alertsById).flatMap(a => (a.items || []).map(i => i.coin || '')),
  ].filter(Boolean));
    return previous && previous.length === next.length && previous.every((coin, i) => coin === next[i]) ? previous : next;
  });
}
