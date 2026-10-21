import {describe,expect,it} from 'vitest';
import {readFileSync} from 'node:fs';
import {mkdtempSync,readdirSync,rmSync} from 'node:fs';
import {resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {renderReleaseConfig,prepareRelease,RELEASE} from '../../scripts/releases/emerald-20261003.mjs';
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

 it('packages only reviewable source without account bindings, credentials, tests or migrations',()=>{
  const destination=resolve(mkdtempSync(resolve(tmpdir(),'itam-review-test-')),'artifact');
  const manifest=prepareRelease(process.cwd(),destination);
  expect(manifest.mode).toBe('offline_review_only');expect(manifest.deployable).toBe(false);
  expect(readdirSync(destination).sort()).toEqual(['itam-app','release-manifest.json']);
  for(const path of Object.keys(manifest.files))expect(path).not.toMatch(/(?:^|\/)(?:\.env|node_modules|\.next|\.vercel|migrations)|\.(?:test|spec)\.[cm]?[jt]sx?$/);
  expect(readFileSync(resolve(destination,'itam-app/next.config.mjs'),'utf8')).toBe(renderReleaseConfig(source));
  expect(()=>prepareRelease(process.cwd(),destination)).toThrow(/already exists/);
  rmSync(resolve(destination,'..'),{recursive:true});
 });
});
