import {readFileSync,existsSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {describe,expect,it} from 'vitest';
import config from '../../playwright.config';
import {assertLoopbackBaseUrl} from '../../scripts/test/loopback-target.mjs';
describe('Local-only E2E safety contract (runtime currently blocked)',()=>{
 it('limits review configuration to the explicitly owned loopback origin',()=>{expect(assertLoopbackBaseUrl('http://127.0.0.1:4173')).toBe('http://127.0.0.1:4173');});
 it('rejects remote URLs, TLS-hosted targets, unexpected ports and embedded credentials',()=>{for(const url of ['https://example.com','https://127.0.0.1:4173','http://127.0.0.1:54321','http://user:password@127.0.0.1:4173'])expect(()=>assertLoopbackBaseUrl(url)).toThrow();});
 it('rejects target paths, queries, fragments and hostname lookalikes',()=>{for(const url of ['http://127.0.0.1:4173/app','http://127.0.0.1:4173?x=1','http://127.0.0.1:4173#x','http://localhost.example.com:4173'])expect(()=>assertLoopbackBaseUrl(url)).toThrow();});
 it('does not automatically start a listener or browser',()=>{expect(config.webServer).toBeUndefined();expect(config.use?.baseURL).toBe('http://127.0.0.1:4173');});
 it('refuses execution rather than reporting an E2E pass without prerequisites',()=>{expect(()=>execFileSync(process.execPath,['scripts/test/run-local-supabase-e2e.mjs'],{stdio:'pipe'})).toThrow(/Browser\/database E2E is blocked/);});
 it('does not ship hosted provisioning, cleanup, session-revocation or MFA mutation helpers',()=>{for(const name of ['setup-supabase-e2e.mjs','cleanup-supabase-e2e.mjs','revoke-supabase-e2e-sessions.mjs','verify-hosted-auth-mfa.mjs'])expect(existsSync('scripts/test/'+name)).toBe(false);});
 it('exposes planning commands without advertising a successful full security run',()=>{const pkg=JSON.parse(readFileSync('package.json','utf8'));expect(pkg.scripts['test:db:plan']).toContain('--plan');expect(pkg.scripts['test:e2e:security']).toBeUndefined();});
 it('does not let inherited remote configuration start the E2E workflow',()=>{expect(()=>execFileSync(process.execPath,['scripts/test/run-local-supabase-e2e.mjs'],{env:{...process.env,PLAYWRIGHT_BASE_URL:'https://example.com'},stdio:'pipe'})).toThrow(/Refusing non-local E2E target/);});
});
