import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEMO_ROUTES, matchDemoRoute } from '../../src/demo/route-manifest';
import { clearDemoOwnedBrowserState } from '../../src/demo/reset';

afterEach(() => vi.unstubAllGlobals());

describe('actual route contract', () => {
  it('maps every one of the 35 source routes, including dynamic pages', () => {
    expect(DEMO_ROUTES).toHaveLength(35);
    expect(new Set(DEMO_ROUTES.map((entry) => entry.path)).size).toBe(35);
    for (const route of DEMO_ROUTES) {
      const sample = route.path.replace(':id', 'demo-record').replace(':token', 'public-demo-token');
      expect(matchDemoRoute(sample)?.entry).toBe(route);
    }
  });
  it('keeps new/import paths out of detail routes and preserves encoded parameters', () => {
    expect(matchDemoRoute('/assets/new')?.entry.path).toBe('/assets/new');
    expect(matchDemoRoute('/assets/import')?.entry.path).toBe('/assets/import');
    expect(matchDemoRoute('/client-portal/requests/new')?.params).toEqual({});
    expect(matchDemoRoute('/a/public%20demo/')?.params).toEqual({ token: 'public demo' });
    expect(matchDemoRoute('/assets/%E0%A4%A')).toBeNull();
    expect(matchDemoRoute('/unknown')).toBeNull();
    expect(matchDemoRoute('/assets/id/extra')).toBeNull();
  });
});

function storage(values: Record<string, string>) {
  return Object.assign({
    removeItem(key: string) { Reflect.deleteProperty(this, key); },
  }, values);
}
it('reset clears only owned operation/view/preview state while retaining preferences and unrelated keys', () => {
  const session = storage({ 'itam:portal-create:v1:actor': 'op', 'itam:pending-operation:v1:actor': 'op', itam_exposure_preview: '{}', unrelated: 'keep' });
  const local = storage({ 'itam.private-views.v1:actor': 'views', 'studio-demo:read-invalidation': 'epoch', itam_lang: 'ar', itam_theme: 'dark', unrelated: 'keep' });
  vi.stubGlobal('sessionStorage', session); vi.stubGlobal('localStorage', local);
  clearDemoOwnedBrowserState();
  expect(session).not.toHaveProperty('itam:portal-create:v1:actor');
  expect(session).not.toHaveProperty('itam:pending-operation:v1:actor');
  expect(session).not.toHaveProperty('itam_exposure_preview');
  expect(local).not.toHaveProperty('itam.private-views.v1:actor');
  expect(local).not.toHaveProperty('studio-demo:read-invalidation');
  expect(local).toMatchObject({ itam_lang: 'ar', itam_theme: 'dark', unrelated: 'keep' });
  expect(session).toHaveProperty('unrelated', 'keep');
});

it('a same-profile reset received by both notification channels reopens the document once', async () => {
  vi.resetModules();
  const listeners = new Map<string, (event: { key?: string; newValue?: string }) => void>();
  const replace = vi.fn();
  const values = new Map<string, string>();
  const session = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value), removeItem: (key: string) => values.delete(key) };
  let notice: ((event: MessageEvent<unknown>) => void) | null = null;
  class Channel {
    set onmessage(handler: (event: MessageEvent<unknown>) => void) { notice = handler; }
    close() {}
  }
  vi.stubGlobal('sessionStorage', session);
  vi.stubGlobal('localStorage', { removeItem: vi.fn() });
  vi.stubGlobal('BroadcastChannel', Channel);
  vi.stubGlobal('window', { location: { replace }, addEventListener: (name: string, listener: (event: { key?: string; newValue?: string }) => void) => listeners.set(name, listener) });
  const reset = await import('../../src/demo/reset');
  reset.installDemoResetLifecycle();
  listeners.get('storage')!({ key: 'studio-demo:reset-notice', newValue: '{"version":1,"generation":2}' });
  const deliver = notice as unknown as (event: { data: unknown }) => void;
  deliver({ data: { version: 1, generation: 2 } });
  expect(replace).toHaveBeenCalledExactlyOnceWith('/login');
  expect(values.get('studio-demo:reset-pending')).toBe('1');
});
