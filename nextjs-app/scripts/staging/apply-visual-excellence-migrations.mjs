import {assertApprovedOrLocalSupabaseTarget} from '../safety/production-boundary.mjs';
export function planLocalVerification(target){
 const identity=assertApprovedOrLocalSupabaseTarget(target);
 if(identity.kind!=='local')throw Error('Only a disposable loopback target may be planned');
 return {mode:'plan_only',executed:false,migrations:['20260902173000_fix_asset_status_custody_atomicity.sql','20260902180000_restore_exact_delivery_strong_proof.sql'],transaction:['begin','rollback'],checks:['custody_closure','exact_asset_verification','legacy_browser_closed','delivery_sod']};
}
