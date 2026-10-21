import {describe,expect,it} from 'vitest';
import {readFileSync} from 'node:fs';
import {renderReleaseConfig,RELEASE} from '../../scripts/releases/ledger-20260930.mjs';
const source=readFileSync('next.config.mjs','utf8');
describe('Offline publication artifact boundary',()=>{
 it('retains the application guard and rejects drift or a real hosted policy',()=>{
  expect(source).toContain('assertApprovedOrLocalSupabaseTarget({');
  expect(()=>renderReleaseConfig('export default {};')).toThrow(/review/);
  expect(()=>renderReleaseConfig(source,{...RELEASE,officialHost:'service.example.com'})).toThrow(/synthetic/);
 });
 it('rejects all hosted deployment environments while permitting only a local disabled backend',()=>{
  const output=renderReleaseConfig(source);
  const block=output.split('/* publication-runtime:start */')[1].split('/* publication-runtime:end */')[0];
  const check=new Function('process','runtimeSupabaseUrl',block);
  expect(()=>check({env:{}},'https://demo.invalid')).not.toThrow();
  for(const env of [{VERCEL_ENV:'production'},{VERCEL_ENV:'preview'},{VERCEL_PROJECT_ID:'any-project'}])expect(()=>check({env},'https://demo.invalid')).toThrow(/disabled|mismatch/);
  for(const url of ['', 'https://service.example.com', 'https://demo.invalid/', 'https://demo.invalid?x=1'])expect(()=>check({env:{}},url)).toThrow(/mismatch/);
 });
 it('keeps browser connections local and never adds a hosted link or account binding',()=>{
  const output=renderReleaseConfig(source);
  expect(output).toContain("connect-src 'self'");expect(output).not.toContain('*.supabase.co');
  expect(output).not.toContain('wss://');expect(output).not.toContain('.vercel.app');
 });
 it('does not ship an operational region or account binding',()=>{
  const policy=readFileSync('scripts/releases/publication-package.mjs','utf8');expect(policy).not.toContain('.vercel/project.json');expect(policy).not.toContain('hnd1');expect(RELEASE.projectId).toBe('fixture-review');
 });
});
