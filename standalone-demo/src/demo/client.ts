import { AuthSessionMissingError, StorageApiError, createClient as createSupabaseClient, type AuthChangeEvent, type Session } from '@supabase/supabase-js';
import {
  createDemoTransport, getDemoStore, getDemoSession, setDemoActor, subscribeDemoStore,
  DEMO_SUPABASE_URL, DEMO_SUPABASE_ANON_KEY, createDemoAttachmentUrl,
} from './data';

// Every SDK request is fulfilled by the browser's synthetic local-data transport.
// There is deliberately no native-fetch fallback, hosted URL, environment key or real account.
const client = createSupabaseClient(DEMO_SUPABASE_URL, DEMO_SUPABASE_ANON_KEY, {
  auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  global: { fetch: createDemoTransport(getDemoStore()) },
});
const sdkGetUser = client.auth.getUser.bind(client.auth);
const sdkSetSession = client.auth.setSession.bind(client.auth);
const sdkUpdateUser = client.auth.updateUser.bind(client.auth);
async function primeSdkSession() {
  const session = getDemoSession();
  const generation = getDemoStore().getGeneration();
  if (!session) return new AuthSessionMissingError();
  const { error } = await sdkSetSession({ access_token: session.access_token, refresh_token: session.refresh_token });
  if (getDemoStore().getGeneration() !== generation || getDemoSession()?.user.id !== session.user.id) return new AuthSessionMissingError();
  return error;
}
client.auth.getSession = async () => {
  const session = getDemoSession();
  if (session) return { data: { session }, error: null };
  return { data: { session: null }, error: null };
};
client.auth.getUser = async (_jwt?: string) => {
  const session = getDemoSession();
  const generation = getDemoStore().getGeneration();
  if (!session) return { data: { user: null }, error: new AuthSessionMissingError() };
  // The transport validates the synthetic token's actor/generation, including a
  // token captured before the current second. Read the actual local user/factors.
  const result = await sdkGetUser(_jwt ?? session.access_token);
  if (getDemoStore().getGeneration() !== generation || getDemoSession()?.user.id !== session.user.id) return { data: { user: null }, error: new AuthSessionMissingError() };
  return result;
};
client.auth.updateUser = async (attributes, options) => {
  const error = await primeSdkSession();
  if (error) return { data: { user: null }, error };
  return sdkUpdateUser(attributes, options);
};
// MFA and updateUser use the SDK's private session, rather than getSession().
// Prime only its nonpersistent memory store; all SDK I/O still goes to demo.invalid.
client.auth.mfa = new Proxy(client.auth.mfa, {
  get(target, property, receiver) {
    const method = Reflect.get(target, property, receiver);
    if (typeof method !== 'function') return method;
    return async (...args: unknown[]) => {
      const error = await primeSdkSession();
      if (error) return { data: null, error };
      return Reflect.apply(method, target, args);
    };
  },
});
client.auth.signOut = async () => { await setDemoActor(null); return { error: null }; };
client.auth.onAuthStateChange = (callback: (event: AuthChangeEvent, session: Session | null) => void) => {
  let previous = getDemoSession()?.user.id ?? null;
  let active = true;
  const unsubscribe = subscribeDemoStore(() => {
    const session = getDemoSession();
    const current = session?.user.id ?? null;
    if (previous !== current && active) {
      previous = current;
      callback(session ? 'SIGNED_IN' : 'SIGNED_OUT', session);
    }
  });
  const subscription = { id: crypto.randomUUID(), callback, unsubscribe: () => { active = false; unsubscribe(); } };
  queueMicrotask(() => { if (active) callback('INITIAL_SESSION', getDemoSession()); });
  return { data: { subscription } };
};
export function createClient() { return client; }

const storageFrom = client.storage.from.bind(client.storage);
client.storage.from = (bucketId: string) => {
  const bucket = storageFrom(bucketId);
  bucket.createSignedUrl = async (path, _expiresIn, options) => {
    try {
      const url = await createDemoAttachmentUrl(bucketId, path, options?.download);
      if (!url) return { data: null, error: new StorageApiError('Demo attachment not found', 404, 'not_found') };
      return { data: { signedUrl: url }, error: null };
    } catch {
      return { data: null, error: new StorageApiError('Demo attachment unavailable for this role', 403, 'not_authorized') };
    }
  };
  return bucket;
};
