import { createDemoTransport, getDemoStore } from './data';
export type { ReadSeed, ReadSeedEntry, DataRequestKind } from '../studio/lib/supabase/read-prefetch';
import type { ReadSeed, DataRequestKind } from '../studio/lib/supabase/read-prefetch';
const listeners = new Set<() => void>();
let epoch = 0;
export const SEED_KEY_HEADERS = ['accept', 'accept-profile', 'content-profile', 'prefer', 'range'];
export const READ_EPOCH_COOKIE = 'studio_demo_read_epoch';
export const READ_INVALIDATION_STORAGE_KEY = 'studio-demo:read-invalidation';
export function clearReadPrefetch(notify = true) { epoch += 1; if (notify) listeners.forEach((listener) => listener()); }
export function subscribeReadInvalidation(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; }
export function readEpochCookie() { return String(epoch); }
export function seedReadPrefetch(_seed: ReadSeed | null | undefined) {}
export function forgetPrefetchShapes() { clearReadPrefetch(); }
export function classifyDataRequest(method: string, _url: URL): DataRequestKind { return ['GET', 'HEAD'].includes(method.toUpperCase()) ? 'read' : 'write'; }
export function userIdFromAuthorization(value: string | undefined): string | null {
  const token = value?.replace(/^Bearer\s+/i, '');
  if (!token) return null;
  try { return JSON.parse(atob(token.split('.')[1].replaceAll('-', '+').replaceAll('_', '/'))).sub ?? null; } catch { return null; }
}
export const prefetchAwareFetch: typeof fetch = (input, init) => createDemoTransport(getDemoStore())(input, init);
export async function prefetchRouteData(_pathname: string, _auth: { accessToken: string; apiKey: string; userId: string }, _signal?: AbortSignal) {}
