import {describe,expect,it} from 'vitest';
import {readFileSync} from 'node:fs';
import {planLocalVerification} from '../../scripts/staging/apply-visual-excellence-migrations.mjs';
describe('Local additive-migration verification plan (no database execution)',()=>{
 it('selects the reviewed source migrations only for a disposable loopback target',()=>{
  const plan=planLocalVerification({url:'http://127.0.0.1:54321',projectRef:'local'});
  expect(plan.migrations).toEqual(['20260902173000_fix_asset_status_custody_atomicity.sql','20260902180000_restore_exact_delivery_strong_proof.sql']);
  for(const name of plan.migrations)expect(readFileSync('migrations/'+name,'utf8').length).toBeGreaterThan(100);
  expect(()=>planLocalVerification({url:'https://example.com',projectRef:'unknown'})).toThrow();
 });
 it('plans rollback probes and never reports migrations as executed',()=>{
  const plan=planLocalVerification({url:'http://127.0.0.1:54321',projectRef:'local'});
  expect(plan.transaction).toEqual(['begin','rollback']);expect(plan.executed).toBe(false);
  expect(plan.checks).toEqual(['custody_closure','exact_asset_verification','legacy_browser_closed','delivery_sod']);
 });
});
