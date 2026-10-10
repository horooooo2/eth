export type ValidationSortKey = 'usd' | 'openTime' | 'entryPx' | 'unrealizedPnl';
export function sortValidationPositions<T extends {address:string;openTime?:number|null;usd:number;entryPx:number|null;unrealizedPnl:number|null}>(rows:T[],key:ValidationSortKey,ascending:boolean):T[]{
 return [...rows].sort((a,b)=>{
  const av=a[key],bv=b[key];
  if(av==null)return bv==null?a.address.localeCompare(b.address):1;
  if(bv==null)return -1;
  return (ascending?av-bv:bv-av)||a.address.localeCompare(b.address);
 });
}
