export type ValidationSortKey = 'default' | 'usd' | 'entryPx' | 'unrealizedPnl';
export function sortValidationPositions<T extends {address:string;monthPnl?:number|null;usd:number;entryPx:number|null;unrealizedPnl:number|null}>(rows:T[],key:ValidationSortKey,ascending:boolean):T[]{
 return [...rows].sort((a,b)=>{
  const field=key==='default'?'monthPnl':key;
  const av=Number.isFinite(a[field])?a[field]:null,bv=Number.isFinite(b[field])?b[field]:null;
  if(av==null)return bv==null?a.address.localeCompare(b.address):1;
  if(bv==null)return -1;
  return (ascending&&key!=='default'?av-bv:bv-av)||a.address.localeCompare(b.address);
 });
}
