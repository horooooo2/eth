// Copy before sorting: shared market snapshots must never be reordered per user.
function sortRows(rows, value, order='desc') {
  return [...rows].sort((a,b)=>{
    const rawA=value(a),rawB=value(b);
    const x=rawA==null||rawA===''?NaN:Number(rawA),y=rawB==null||rawB===''?NaN:Number(rawB);
    if(!Number.isFinite(x))return Number.isFinite(y)?1:a.symbol.localeCompare(b.symbol);
    if(!Number.isFinite(y))return -1;
    return (order==='asc'?x-y:y-x)||a.symbol.localeCompare(b.symbol);
  });
}
module.exports={sortRows};
