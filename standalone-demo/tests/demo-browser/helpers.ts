import { test as base, expect, type Page, type BrowserContext, type TestInfo, type Request } from '@playwright/test';
import { stat } from 'node:fs/promises';
import inventory from './fixtures/source-inventory.json' with { type: 'json' };

export type Row = Record<string, unknown>;
export type DemoSnapshot = {
  generation: number; revision: number; actorId: string | null;
  tables: Record<string, Row[]>; operations: Record<string, unknown>; blobs: Record<string, unknown>;
  mfa: Record<string, Row[]>;
  authScenario?: { actorId: string; status: 'pending' | 'rejected' | 'approved' };
};
export type RpcResult = { data: unknown; error: { code?: string; message: string } | null };
export const id = (group: number, number: number) => `${group.toString(16).padStart(8, '0')}-0000-4000-8000-${number.toString(16).padStart(12, '0')}`;
export const personas = ['it_manager', 'employee', 'warehouse_manager', 'viewer', 'portal_project_manager', 'portal_requester', 'portal_receiver', 'admin', 'technician', 'auditor'] as const;

export const test = base.extend<{ strictAudit: void }>({
  strictAudit: [async ({ page, context, browser, baseURL }, use, info) => {
    if (!baseURL) throw new Error('Explicit demo baseURL is required.');
    const origin = new URL(baseURL).origin;
    const errors: string[] = [];
    const requestStarts = new WeakMap<Request, number>();
    const observedRequests: { page: Page; url: string; method: string; navigation: boolean; mainFrame: boolean }[] = [];
    const requestFailures: { page: Page; url: string; method: string; error: string; navigation: boolean; startedAt: number | undefined; failedAt: number }[] = [];
    const downloads: Promise<{ page: Page; url: string; bytes: number; failure: string | null; startedAt: number; completedAt: number }>[] = [];
    const offOrigin: string[] = [];
    const attach = (current: Page) => {
      current.on('pageerror', error => errors.push(error.message));
      current.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
      current.on('request', request => {
        requestStarts.set(request, performance.now());
        const navigation = request.isNavigationRequest();
        observedRequests.push({ page: current, url: request.url(), method: request.method(), navigation, mainFrame: navigation && request.frame() === current.mainFrame() });
      });
      current.on('requestfailed', request => requestFailures.push({ page: current, url: request.url(), method: request.method(), error: request.failure()?.errorText ?? 'failed', navigation: request.isNavigationRequest(), startedAt: requestStarts.get(request), failedAt: performance.now() }));
      current.on('download', download => {
        const startedAt = performance.now();
        downloads.push((async () => {
          const failure = await download.failure();
          const file = failure === null ? await download.path() : null;
          return { page: current, url: download.url(), bytes: file ? (await stat(file)).size : 0, failure, startedAt, completedAt: performance.now() };
        })());
      });
      current.on('websocket', socket => {
        const url = new URL(socket.url());
        if (url.host !== new URL(origin).host) offOrigin.push(`websocket:${url.origin}`);
      });
    };
    attach(page);
    context.on('page', attach);
    await context.route('**/*', async route => {
      const url = new URL(route.request().url());
      if (!['data:', 'blob:', 'about:'].includes(url.protocol) && url.origin !== origin) {
        offOrigin.push(`${route.request().method()} ${url.origin}${url.pathname}`);
        await route.abort('blockedbyclient');
      } else await route.continue();
    });
    await use();
    const completedDownloads = await Promise.all(downloads);
    // Chromium reports a navigation cancellation when a Blob navigation
    // becomes a download. Accept only that exact same-page Blob URL after
    // Playwright confirms a successful, nonempty on-disk download.
    const canceledDownloads = requestFailures.filter(request => {
      const url = new URL(request.url);
      const paired = completedDownloads.filter(download => download.page === request.page && download.url === request.url);
      const navigation = observedRequests.filter(observed => observed.page === request.page && observed.url === request.url);
      return request.method === 'GET' && request.navigation && request.error === 'net::ERR_ABORTED'
        && url.protocol === 'blob:' && url.origin === origin
        && request.startedAt !== undefined
        && navigation.length === 1 && navigation[0].method === 'GET' && navigation[0].navigation && navigation[0].mainFrame
        && requestFailures.filter(other => other.page === request.page && other.url === request.url).length === 1
        && paired.length === 1
        && paired.some(download => download.failure === null && download.bytes > 0
          && download.startedAt >= request.startedAt! && request.failedAt >= request.startedAt! && request.failedAt <= download.completedAt);
    });
    const failed = requestFailures.filter(request => !canceledDownloads.includes(request))
      .map(request => `${request.method} ${new URL(request.url).pathname}: ${request.error}`);
    const scripts = page.isClosed() ? [] : await page.locator('script[src]').evaluateAll(elements => elements.map(element => new URL((element as HTMLScriptElement).src).pathname));
    const stylesheets = page.isClosed() ? [] : await page.locator('link[rel="stylesheet"][href]').evaluateAll(elements => elements.map(element => new URL((element as HTMLLinkElement).href).pathname));
    await info.attach('demo-build-binding', { body: JSON.stringify({ baseURL, browserVersion: browser.version(), pageClosed: page.isClosed(), scripts, stylesheets }, null, 2), contentType: 'application/json' });
    await info.attach('demo-browser-audit', { body: JSON.stringify({ errors, failed, offOrigin, rawFailedRequestCount: requestFailures.length, completedBlobDownloadCancellations: canceledDownloads.map(request => {
      const download = completedDownloads.find(item => item.page === request.page && item.url === request.url)!;
      return { method: request.method, protocol: 'blob:', sameOrigin: true, error: request.error, completedBytes: download.bytes, requestToDownloadMs: download.startedAt - request.startedAt!, requestToCancellationMs: request.failedAt - request.startedAt!, downloadToCompletionMs: download.completedAt - download.startedAt, cancellationToCompletionMs: download.completedAt - request.failedAt };
    }) }, null, 2), contentType: 'application/json' });
    expect(offOrigin, 'No document/image/download/SDK/popup request may leave the independent demo origin.').toEqual([]);
    expect(errors, 'All console and page errors require investigation.').toEqual([]);
    expect(failed, 'Unexpected failed network requests require investigation.').toEqual([]);
    if (origin === 'https://demo.invalid' && !page.isClosed()) {
      await expect(page.locator('meta[name="robots"]')).toHaveAttribute('content', /noindex/i);
    }
  }, { auto: true }],
});
export { expect };

export async function waitForUiAnimations(page: Page) {
  // Preserve the real animation. Audit/capture its settled color and opacity,
  // while leaving infinite status spinners untouched.
  await page.evaluate(async () => {
    const finiteAnimations = document.getAnimations().filter(animation =>
      animation.playState === 'running' && Number.isFinite(Number(animation.effect?.getComputedTiming().endTime)));
    await Promise.all(finiteAnimations.map(animation => animation.finished.catch(() => undefined)));
  });
}

export async function chooseRole(page: Page, persona: typeof personas[number]) {
  await page.goto('/login');
  if (['admin', 'technician', 'auditor'].includes(persona)) await page.locator('[data-demo-advanced]').click();
  await page.locator(`[data-demo-role="${persona}"]`).click();
  await expect(page.locator('[data-demo-runtime="browser-only"]')).toBeVisible();
  await expect.poll(() => new URL(page.url()).pathname).not.toBe('/login');
}
export async function setLanguageThroughUi(page: Page, language: 'ar' | 'en') {
  // AuthChrome has lang attributes; the real staff/portal toggles instead
  // expose a labelled Language group with the same visible buttons.
  const button = page.getByRole('group', { name: /^(Language|اللغة)$/ })
    .getByRole('button', { name: language === 'ar' ? 'ع' : 'EN', exact: true });
  await button.click();
  await expect(button).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('html')).toHaveAttribute('dir', language === 'ar' ? 'rtl' : 'ltr');
}
export async function snapshot(page: Page): Promise<DemoSnapshot> {
  return page.evaluate(async () => {
    const modulePath = '/src/demo/data/index.ts';
    const data = await import(modulePath);
    return data.readDemoSnapshot();
  });
}
// Read the real browser database through its public IndexedDB API. This ships
// no test hook and also works against the static production preview.
export async function persistedSnapshot(page: Page): Promise<DemoSnapshot> {
  return page.evaluate(async () => {
    const databases = await indexedDB.databases();
    if (!databases.some(database => database.name === 'itam-manager-demo-v1')) throw new Error('Demo database was not initialized.');
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('itam-manager-demo-v1', 1);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(new Error('Unable to inspect demo database.'));
      request.onupgradeneeded = () => { request.transaction?.abort(); reject(new Error('Read-only audit must not create a database.')); };
    });
    try {
      return await new Promise<DemoSnapshot>((resolve, reject) => {
        const transaction = database.transaction('local-state', 'readonly');
        const request = transaction.objectStore('local-state').get('state');
        let result: DemoSnapshot;
        request.onsuccess = () => { result = request.result; };
        transaction.oncomplete = () => resolve(result);
        transaction.onabort = transaction.onerror = () => reject(new Error('Read-only demo audit failed.'));
      });
    } finally { database.close(); }
  });
}
export async function rpc(page: Page, name: string, params: Row = {}): Promise<RpcResult> {
  return page.evaluate(async ({ name, params }) => {
    const modulePath = '/src/demo/client.ts';
    const client = await import(modulePath);
    const { data, error } = await client.createClient().rpc(name, params);
    return { data, error: error ? { code: error.code, message: error.message } : null };
  }, { name, params });
}
export async function readTable(page: Page, table: string, select: string, filter?: { key: string; value: string }): Promise<RpcResult> {
  return page.evaluate(async ({ table, select, filter }) => {
    const modulePath = '/src/demo/client.ts';
    const client = await import(modulePath);
    let query = client.createClient().from(table).select(select);
    if (filter) query = query.eq(filter.key, filter.value);
    const { data, error } = await query;
    return { data, error: error ? { code: error.code, message: error.message } : null };
  }, { table, select, filter });
}
export async function mutationResult(info: TestInfo, action: string, expected: unknown, actual: unknown) {
  await info.attach('demo-state-oracle', { body: JSON.stringify({ channel: 'sdk-rpc', action, expected, actual }, null, 2), contentType: 'application/json' });
}
export async function proveUiActions(info: TestInfo, keys: string[], oracle: Row) {
  for (const key of keys) {
    const action = inventory.actions.find(action => action.key === key);
    if (!action?.mounted) throw new Error(`UI proof must reference an actual mounted source action: ${key}`);
  }
  await info.attach('demo-source-actions-ui', { body: JSON.stringify({ channel: 'ui', sourceActionKeys: keys, oracle }, null, 2), contentType: 'application/json' });
}
export function successful(result: RpcResult) {
  expect(result.error).toBeNull();
  expect(result.data).toMatchObject({ ok: true });
}
export function denied(result: RpcResult) {
  expect(result.error !== null || (typeof result.data === 'object' && result.data !== null && 'ok' in result.data && result.data.ok === false)).toBe(true);
}
export function row(state: DemoSnapshot, table: string, target: string): Row {
  const result = state.tables[table]?.find(item => item.id === target);
  expect(result, `${table}/${target} must exist in the actual persisted snapshot`).toBeDefined();
  return result!;
}
export async function auditContext(context: BrowserContext, origin: string) {
  const violations: string[] = [];
  context.on('request', request => { const url = new URL(request.url()); if (['http:', 'https:'].includes(url.protocol) && url.origin !== origin) violations.push(`${url.origin}${url.pathname}`); });
  context.on('page', page => {
    page.on('pageerror', error => violations.push(`pageerror:${error.message}`));
    page.on('console', message => { if (message.type() === 'error') violations.push(`console:${message.text()}`); });
    page.on('requestfailed', request => violations.push(`requestfailed:${new URL(request.url()).pathname}:${request.failure()?.errorText ?? 'failed'}`));
    page.on('websocket', socket => { if (new URL(socket.url()).host !== new URL(origin).host) violations.push(`websocket:${new URL(socket.url()).origin}`); });
  });
  return violations;
}
