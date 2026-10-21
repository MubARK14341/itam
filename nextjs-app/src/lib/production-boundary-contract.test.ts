import {readFileSync,existsSync} from 'node:fs';
import {describe,expect,it} from 'vitest';
import {APPROVED_STAGING as fixture,DENIED_PRODUCTION,assertApprovedSupabaseTarget,assertApprovedOrLocalSupabaseTarget,assertApprovedHostedQaUrl,assertApprovedVercelProject,assertApprovedVercelShareUrl,validateApprovedSupabaseTarget,validateApprovedHostedQaUrl,validateApprovedVercelShareUrl,assertPublicationEnvironment} from '../../scripts/safety/production-boundary.mjs';
describe('Publication boundary (reserved-domain policy fixtures)',()=>{
 it('accepts the exact synthetic identity and never identifies it as a real hosted project',()=>{
  expect(fixture.supabaseApiHost).toMatch(/\.example\.invalid$/);
  expect(assertApprovedSupabaseTarget({url:`https://${fixture.supabaseApiHost}`,projectRef:fixture.supabaseProjectRef,databaseHost:fixture.supabaseDatabaseHost,databaseName:'postgres'})).toMatchObject({kind:'staging'});
 });
 it('rejects the denied policy fixture and every real or unknown hosted origin',()=>{
  expect(()=>assertApprovedSupabaseTarget({url:'https://production.example.invalid',projectRef:DENIED_PRODUCTION.supabaseProjectRefs[0]})).toThrow(/denylisted Production/);
  for(const url of ['https://unknown.supabase.co','https://example.com'])expect(validateApprovedSupabaseTarget({url,projectRef:fixture.supabaseProjectRef})).toMatchObject({ok:false});
 });
 it('fails closed for missing fields, credentials, paths, ports, queries and fragments',()=>{
  expect(validateApprovedSupabaseTarget({})).toMatchObject({ok:false});
  for(const url of [`https://user:password@${fixture.supabaseApiHost}`,`https://${fixture.supabaseApiHost}:8443`,`https://${fixture.supabaseApiHost}/rest/v1`,`https://${fixture.supabaseApiHost}?x=1`,`https://${fixture.supabaseApiHost}#x`])expect(validateApprovedSupabaseTarget({url,projectRef:fixture.supabaseProjectRef})).toMatchObject({ok:false});
 });
 it('accepts only fixed or generated reserved-domain preview fixtures',()=>{
  expect(assertApprovedHostedQaUrl(`https://${fixture.fixedPreviewHost}/login`).hostname).toBe(fixture.fixedPreviewHost);
  expect(assertApprovedHostedQaUrl('https://preview-generated.example.invalid').hostname).toBe('preview-generated.example.invalid');
 });
 it('rejects unknown and real hosted QA URLs',()=>{
  for(const url of ['https://example.com','https://unknown.vercel.app',''])expect(validateApprovedHostedQaUrl(url)).toMatchObject({ok:false});
 });
 it('checks exact origin and a single ephemeral share parameter even in synthetic policy tests',()=>{
  const target=`https://${fixture.fixedPreviewHost}`;
  expect(assertApprovedVercelShareUrl(target+'/?_vercel_share=synthetic',target).origin).toBe(target);
  for(const url of ['https://other.example.invalid/?_vercel_share=synthetic',target+'/?_vercel_share=synthetic&next=https://example.com',target+'/#fragment',''])expect(validateApprovedVercelShareUrl(url,target)).toMatchObject({ok:false});
 });
 it('requires all three exact synthetic project fields; no real account is approved',()=>{
  const input={projectId:fixture.vercelProjectId,projectName:fixture.vercelProjectName,teamId:fixture.vercelTeamId};
  expect(assertApprovedVercelProject(input)).toMatchObject(input);
  for(const key of Object.keys(input))expect(()=>assertApprovedVercelProject({...input,[key]:'other'})).toThrow();
 });
 it('keeps hosted CLI wrappers unconditionally closed and excludes mutation helpers',()=>{
  for(const file of ['deploy-preview.mjs','run-supabase-command.mjs']){
   const source=readFileSync('scripts/staging/'+file,'utf8');expect(source).toContain('denyHostedOperation()');expect(source).not.toContain('spawn');
  }
  expect(existsSync('scripts/test/cleanup-supabase-e2e.mjs')).toBe(false);
 });
 it('enforces the actual runtime configuration independently of inherited hosted credentials',()=>{
  const config=readFileSync('next.config.mjs','utf8');expect(config).toContain('assertPublicationEnvironment(process.env)');expect(config).toContain('assertApprovedOrLocalSupabaseTarget({');expect(config).toContain("connect-src 'self'");
  expect(assertApprovedOrLocalSupabaseTarget({url:'https://demo.invalid',projectRef:'demo'})).toMatchObject({kind:'demo'});
  expect(assertPublicationEnvironment({NEXT_PUBLIC_SUPABASE_URL:'https://demo.invalid'})).toBe(true);
  for(const env of [{VERCEL_ENV:'preview'},{VERCEL_ENV:'production'},{DATABASE_URL:'postgresql://local'},{SUPABASE_SERVICE_ROLE_KEY:'synthetic'},{NEXT_PUBLIC_SUPABASE_SERVICE_ROLE_KEY:'synthetic'},{NEXT_PUBLIC_SUPABASE_URL:'https://unknown.supabase.co'}])expect(()=>assertPublicationEnvironment(env)).toThrow();
 });
});
