/** Pure synthetic-state validation; no credentials, SDK or hosted connection. */
export function verifySyntheticAssets(assets,movements){
 if(!assets.every(a=>typeof a.id==='string'&&a.id.startsWith('DEMO-')))throw Error('Only synthetic assets are accepted');
 for(const asset of assets){
  if(!asset.archived_at&&['damaged','retired'].includes(asset.status))throw Error('Active assets retain a remediated legacy status');
  if(asset.archived_at&&!movements.some(m=>m.asset_id===asset.id&&['damaged','retired'].includes(m.from_status)))throw Error('Archived legacy asset movement history invariant failed');
 }
 return {active:assets.filter(a=>!a.archived_at).length,archived:assets.filter(a=>!!a.archived_at).length};
}
