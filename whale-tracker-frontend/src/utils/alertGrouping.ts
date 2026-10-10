import type { WhaleAlert } from './whaleAlerts';

/** Display-only grouping. Original events and detail items remain intact. */
export function groupNearbyAlerts(alerts: WhaleAlert[], windowMs = 10 * 60000): WhaleAlert[] {
  const time = (a: WhaleAlert) => Math.max(0, ...a.items.map(i => Number(i.time) || 0)) || a.at || 0;
  const result: WhaleAlert[] = [], latest = new Map<string, WhaleAlert>();
  const seen = new Set<string>();
  for (const alert of [...alerts].sort((a,b) => time(b)-time(a))) {
    if(seen.has(alert.id))continue;
    seen.add(alert.id);
    const item=alert.items[0];
    const key=JSON.stringify([alert.whaleId, item?.coin?.toUpperCase()]);
    const eligible=item && ['open','increase'].includes(item.kind) && item.side && alert.items.every(i=>i.coin===item.coin&&i.kind===item.kind&&i.side===item.side&&i.evidenceSource===item.evidenceSource);
    const previous=latest.get(key), lead=previous?.items[0];
    if(eligible && previous && lead?.kind===item.kind && lead.side===item.side && lead.evidenceSource===item.evidenceSource && time(previous)-time(alert)<=windowMs){
      previous.items.push(...alert.items);
    }else{
      const copy={...alert,items:[...alert.items]};result.push(copy);
      // Closing, reducing or reversing breaks a sequence, even inside the window.
      if(eligible)latest.set(key,copy);else latest.delete(key);
    }
  }
  return result;
}

export function locatedCoinFilter(current:string, target:string|undefined, preferences:string[]) {
  if(!target)return current;
  return preferences.find(p=>p.toUpperCase()===target.toUpperCase()) || 'all';
}
