import {describe,expect,it} from 'vitest';
import {verifySyntheticAssets} from '../../scripts/staging/verify-manager-demo.mjs';
const active={id:'DEMO-active',status:'available',archived_at:null};
const archived={id:'DEMO-archived',status:'retired',archived_at:'2026-01-01'};
const movement={asset_id:archived.id,from_status:'retired'};
describe('Synthetic preserved-asset verifier',()=>{
 it('distinguishes active and archived synthetic assets without importing hosted record counts',()=>{expect(verifySyntheticAssets([active,archived],[movement])).toEqual({active:1,archived:1});});
 it('rejects a legacy state on an operational asset',()=>{expect(()=>verifySyntheticAssets([{...active,status:'damaged'}],[])).toThrow(/legacy status/);});
 it('requires preserved legacy movement evidence for an archived asset',()=>{expect(()=>verifySyntheticAssets([archived],[])).toThrow(/movement history/);});
 it('rejects records lacking an explicit synthetic identity',()=>{expect(()=>verifySyntheticAssets([{...active,id:'non-demo-record'}],[])).toThrow(/synthetic/);});
});
