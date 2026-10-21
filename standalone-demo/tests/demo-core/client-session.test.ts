import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Session } from '@supabase/supabase-js';

const fixture = vi.hoisted(() => ({ generation: 1, actor: 'manager', factor: false, name: 'Manager', calls: [] as string[], pause: null as null | (() => Promise<void>) }));
function session(): Session | null {
  if (!fixture.actor) return null;
  const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const user = { id: fixture.actor, aud: 'authenticated', role: 'authenticated', email: 'synthetic@demo.invalid', created_at: '2026-01-01T00:00:00Z', app_metadata: {}, user_metadata: { full_name: fixture.name } };
  const token = `${encode({ alg: 'none', typ: 'JWT' })}.${encode({ sub: fixture.actor, generation: fixture.generation, exp: 2000000000 })}.demo-local`;
  return { user, access_token: token, refresh_token: 'demo-refresh-local', expires_in: 3600, token_type: 'bearer' };
}
vi.mock('../../src/demo/data', () => ({
  DEMO_SUPABASE_URL: 'https://demo.invalid', DEMO_SUPABASE_ANON_KEY: 'demo-placeholder-anon-key',
  getDemoStore: () => ({ getGeneration: () => fixture.generation }),
  getDemoSession: () => session(),
  setDemoActor: async (actor: string | null) => { fixture.actor = actor ?? ''; fixture.generation += 1; },
  subscribeDemoStore: () => () => {},
  createDemoAttachmentUrl: async () => 'blob:synthetic-only',
  createDemoTransport: () => async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.origin !== 'https://demo.invalid') throw new Error('External transport is forbidden');
    const method = init?.method ?? 'GET'; fixture.calls.push(`${method} ${url.pathname}`);
    if (fixture.pause) { const pause = fixture.pause; fixture.pause = null; await pause(); }
    if (method === 'PUT') fixture.name = JSON.parse(String(init?.body)).data.full_name;
    const user = { ...session()!.user, factors: fixture.factor ? [{ id: 'local-factor', factor_type: 'totp', status: 'verified', created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z' }] : [] };
    return new Response(JSON.stringify(user), { status: 200, headers: { 'Content-Type': 'application/json' } });
  },
}));
const { createClient } = await import('../../src/demo/client');
beforeEach(() => { fixture.generation = 1; fixture.actor = 'manager'; fixture.factor = false; fixture.name = 'Manager'; fixture.calls = []; fixture.pause = null; });

describe('SDK session bridge', () => {
  it('primes the nonpersistent SDK session so profile updates reach the local transport', async () => {
    const result = await createClient().auth.updateUser({ data: { full_name: 'Updated demo manager' } });
    expect(result.error).toBeNull();
    expect(result.data.user?.user_metadata.full_name).toBe('Updated demo manager');
    expect(fixture.calls).toContain('PUT /auth/v1/user');
    expect(fixture.calls.every((call) => call.endsWith('/auth/v1/user'))).toBe(true);
  });
  it('reads verified MFA factors from the local user rather than an immutable persona', async () => {
    fixture.factor = true;
    const result = await createClient().auth.mfa.listFactors();
    expect(result.error).toBeNull();
    expect(result.data?.totp.map((factor) => factor.id)).toEqual(['local-factor']);
  });
  it('rejects a user read when actor generation changes during the local response', async () => {
    fixture.pause = async () => { fixture.actor = 'employee'; fixture.generation += 1; };
    const result = await createClient().auth.getUser();
    expect(result.data.user).toBeNull();
    expect(result.error?.name).toBe('AuthSessionMissingError');
  });
  it('does not attempt profile writes with no selected actor', async () => {
    fixture.actor = '';
    const result = await createClient().auth.updateUser({ data: { full_name: 'Denied' } });
    expect(result.error?.name).toBe('AuthSessionMissingError');
    expect(fixture.calls).toEqual([]);
  });
});
