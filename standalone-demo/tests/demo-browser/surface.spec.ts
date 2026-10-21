import inventory from './fixtures/source-inventory.json' with { type: 'json' };
import { readFile } from 'node:fs/promises';
import { en } from '../../src/studio/lib/translations/en';
import { ar } from '../../src/studio/lib/translations/ar';
import { test, expect, chooseRole, setLanguageThroughUi, proveUiActions, persistedSnapshot, id, personas } from './helpers';

const landings: Record<(typeof personas)[number], string> = {
  it_manager: '/dashboard', employee: '/my-tasks', warehouse_manager: '/my-tasks', viewer: '/overview',
  portal_project_manager: '/client-portal', portal_requester: '/client-portal', portal_receiver: '/client-portal',
  admin: '/dashboard', technician: '/my-tasks', auditor: '/overview',
};
const actualPath = (route: string) => route
  .replace('/assets/[id]', `/assets/${id(11, 1)}`)
  .replace('/consumables/[id]', `/consumables/${id(14, 3)}`)
  .replace('/client-portal/requests/[id]', `/client-portal/requests/${id(16, 13)}`)
  .replace('/requests/[id]', `/requests/${id(16, 1)}`)
  .replace('/a/[token]', `/a/${id(111, 1)}`);

const detailTabs: Record<string, { prefix: string; keys: string[] }> = {
  '/assets/[id]': { prefix: 'asset-sections', keys: inventory.tabs.assetDetail },
  '/consumables/[id]': { prefix: 'consumable-ledger', keys: inventory.tabs.consumableDetail },
  '/requests/[id]': { prefix: 'request-detail', keys: inventory.tabs.requestDetail },
};

for (const persona of personas) {
  test(`credential-free persona ${persona} lands in its actual permitted surface`, async ({ page }, info) => {
    await chooseRole(page, persona);
    await expect.poll(() => new URL(page.url()).pathname).toBe(landings[persona]);
    await expect(page.getByRole('main')).toBeVisible();
    await expect(page.locator('[data-demo-role-picker]')).toBeVisible();
    await expect(page.locator('.animate-spin')).toHaveCount(0);
    await expect(page.getByRole('alert')).toHaveCount(0);
    await info.attach('demo-role-navigation', { body: JSON.stringify({ persona, expected: landings[persona], actual: new URL(page.url()).pathname, channel: 'ui' }), contentType: 'application/json' });
  });
}

for (const route of inventory.routes) {
  test(`actual route module renders ${route.route}`, async ({ page }, info) => {
    if (route.kind !== 'public') await chooseRole(page, route.kind === 'portal' ? 'portal_project_manager' : route.route.startsWith('/my-') ? 'employee' : 'admin');
    await page.goto(actualPath(route.route));
    await expect(page.locator('#root')).not.toBeEmpty();
    await expect(page.locator('h1, h2').first()).toBeVisible();
    await expect(page.locator('.animate-spin')).toHaveCount(0);
    await expect(page.getByRole('alert')).toHaveCount(0);
    await expect(page.getByText('DEMO_UNSUPPORTED_OPERATION', { exact: false })).toHaveCount(0);
    await expect(page.getByText('DEMO_ROUTE_NOT_FOUND', { exact: false })).toHaveCount(0);
    if (route.route === '/pending-approval') {
      // A direct anonymous document must prepare the walkthrough once even
      // though selecting its local actor notifies the mounted route effect.
      await expect(page.getByRole('heading', { name: ar.registration.pendingTitle, exact: true })).toBeVisible();
      const prepared = await persistedSnapshot(page);
      expect(prepared.actorId).toBe('employee');
      expect(prepared.authScenario).toEqual({ actorId: 'employee', status: 'pending' });
      expect(prepared.tables.app_users.find(row => row.id === id(1, 2))).toMatchObject({ approval_status: 'approved', is_active: true });
      await page.reload();
      await expect(page.getByRole('heading', { name: ar.registration.pendingTitle, exact: true })).toBeVisible();
      await expect(page.getByRole('alert')).toHaveCount(0);
      const reloaded = await persistedSnapshot(page);
      expect(reloaded.actorId).toBe('employee');
      expect(reloaded.authScenario).toEqual(prepared.authScenario);
      expect(reloaded.tables.app_users).toEqual(prepared.tables.app_users);
      await info.attach('demo-anonymous-pending-preparation', { body: JSON.stringify({ directAnonymousDocument: true, simulatedActor: 'employee', status: 'pending', reloadPreserved: true, persistedProfilesUnchanged: true }), contentType: 'application/json' });
    }
    if (route.route === '/auth/mfa') {
      await expect(page.locator('#mfa-code')).toBeVisible();
      const prepared = await persistedSnapshot(page);
      expect(prepared.actorId).toBe('admin');
      expect(prepared.authScenario).toBeUndefined();
      expect(prepared.tables.app_users.find(row => row.id === id(1, 8))).toMatchObject({ approval_status: 'approved', is_active: true, role_key: 'admin' });
      await page.reload();
      await expect(page.locator('#mfa-code')).toBeVisible();
      await expect(page.getByRole('alert')).toHaveCount(0);
      const reloaded = await persistedSnapshot(page);
      expect(reloaded.actorId).toBe('admin');
      expect(reloaded.authScenario).toBeUndefined();
      expect(reloaded.tables.app_users).toEqual(prepared.tables.app_users);
      await info.attach('demo-anonymous-mfa-preparation', { body: JSON.stringify({ directAnonymousDocument: true, simulatedActor: 'admin', actualSdkEnrollmentUi: true, reloadPreserved: true, persistedProfilesUnchanged: true }), contentType: 'application/json' });
    }
    if (route.route === '/warehouse') {
      await expect.poll(() => new URL(page.url()).pathname).toBe('/requests');
      await expect.poll(() => new URL(page.url()).searchParams.get('view')).toBe('warehouse');
    }
    const tabs = detailTabs[route.route];
    if (tabs) {
      for (const language of ['en', 'ar'] as const) {
        await setLanguageThroughUi(page, language);
        for (const key of tabs.keys) {
          const tab = page.locator(`#${tabs.prefix}-tab-${key}`);
          await expect(tab).toBeVisible();
          await tab.click();
          await expect(tab).toHaveAttribute('aria-selected', 'true');
          await expect(tab).toHaveAttribute('aria-controls', `${tabs.prefix}-panel-${key}`);
          const panel = page.locator(`#${tabs.prefix}-panel-${key}`);
          await expect(panel).toBeVisible();
          await expect(panel).toHaveAttribute('role', 'tabpanel');
          await expect(panel).toHaveAttribute('aria-labelledby', `${tabs.prefix}-tab-${key}`);
          await expect(panel).not.toBeEmpty();
        }
        const first = page.locator(`#${tabs.prefix}-tab-${tabs.keys[0]}`);
        const last = page.locator(`#${tabs.prefix}-tab-${tabs.keys.at(-1)}`);
        await last.focus();
        await page.keyboard.press('Home');
        await expect(first).toBeFocused();
        await expect(first).toHaveAttribute('aria-selected', 'true');
        await page.keyboard.press(language === 'ar' ? 'ArrowLeft' : 'ArrowRight');
        const second = page.locator(`#${tabs.prefix}-tab-${tabs.keys[1]}`);
        await expect(second).toBeFocused();
        await expect(second).toHaveAttribute('aria-selected', 'true');
        await page.keyboard.press('End');
        await expect(last).toBeFocused();
        await expect(last).toHaveAttribute('aria-selected', 'true');
      }
      await info.attach('demo-detail-tabs-ui', { body: JSON.stringify({ route: route.route, tabs: tabs.keys, languages: ['en', 'ar'], pointerPanelsLinked: true, keyboardHomeArrowEnd: true }), contentType: 'application/json' });
    }
    if (route.route === '/client-portal/requests/[id]') {
      await setLanguageThroughUi(page, 'en');
      const before = await persistedSnapshot(page);
      const attachment = before.tables.request_attachments.find(row => row.request_id === id(16, 13) && row.file_name === 'demo-guide.pdf');
      expect(attachment).toMatchObject({ scan_status: 'clean', classification: 'customer_visible', uploaded_by_kind: 'staff', visible_to_customer: true });
      const open = page.getByRole('button', { name: `${en.portal.attachments.open} demo-guide.pdf`, exact: true });
      await expect(open).toBeEnabled();
      // The copied handler opens a blank popup before resolving the local URL.
      // Chromium may display a PDF or download it; require the actual Blob
      // target and bytes in either case, without replacing the UI handler.
      const popupWatch = page.waitForEvent('popup').then(popup => ({
        popup,
        result: Promise.any([
          popup.waitForURL(url => url.protocol === 'blob:', { waitUntil: 'commit', timeout: 12_000 }).then(() => ({ kind: 'popup' as const, url: popup.url() })),
          popup.waitForEvent('download', { timeout: 12_000 }).then(async download => {
            expect(await download.failure()).toBeNull();
            const path = await download.path();
            expect(path).not.toBeNull();
            const bytes = await readFile(path!);
            return { kind: 'download' as const, url: download.url(), bytes: bytes.length, text: bytes.toString('utf8') };
          }),
        ]),
      }));
      await open.click();
      const { popup, result } = await popupWatch;
      const opened = await result;
      const target = new URL(opened.url);
      expect(target.protocol).toBe('blob:');
      expect(target.origin).toBe(new URL(page.url()).origin);
      const pdf = opened.kind === 'download' ? opened : await page.evaluate(async url => {
        const response = await fetch(url);
        const blob = await response.blob();
        return { bytes: blob.size, text: await blob.text(), type: blob.type };
      }, opened.url);
      expect(pdf.bytes).toBe(attachment!.size_bytes);
      expect(pdf.text.startsWith('%PDF-1.4')).toBe(true);
      expect(pdf.text).toContain('ITAM local demo attachment');
      expect(pdf.text.trimEnd().endsWith('%%EOF')).toBe(true);
      if ('type' in pdf) expect(pdf.type).toBe('application/pdf');
      await popup.close();
      const after = await persistedSnapshot(page);
      expect(after.tables.request_attachments).toEqual(before.tables.request_attachments);
      expect(Object.keys(after.blobs).sort()).toEqual(Object.keys(before.blobs).sort());
      await expect(page.getByRole('alert')).toHaveCount(0);
      await info.attach('demo-clean-attachment-ui', { body: JSON.stringify({ requestId: id(16, 13), attachmentId: attachment!.id, channel: opened.kind, targetProtocol: target.protocol, sameOrigin: true, bytes: pdf.bytes, validSyntheticPdf: true, metadataUnchanged: true }), contentType: 'application/json' });
    }
    await info.attach('demo-route-render-only', { body: JSON.stringify({ source: route.sourceFile, expected: actualPath(route.route), actual: new URL(page.url()).pathname, channel: 'ui-render-only', mutationCoverage: false }), contentType: 'application/json' });
  });
}

test('direct history changes, back, forward and reload preserve report filters', async ({ page }) => {
  await chooseRole(page, 'it_manager');
  await page.goto('/reports?tab=inventory');
  await expect(page.locator('#reports-tab-inventory')).toHaveAttribute('aria-selected', 'true');
  await page.evaluate(() => window.history.pushState(null, '', '/reports?tab=maintenance'));
  await expect(page.locator('#reports-tab-maintenance')).toHaveAttribute('aria-selected', 'true');
  await page.goBack();
  await expect(page.locator('#reports-tab-inventory')).toHaveAttribute('aria-selected', 'true');
  await page.goForward();
  await expect(page.locator('#reports-tab-maintenance')).toHaveAttribute('aria-selected', 'true');
  await page.reload();
  await expect(page.locator('#reports-tab-maintenance')).toHaveAttribute('aria-selected', 'true');
});

test('settings tab keyboard links focus, selected state and active panel', async ({ page }, info) => {
  await chooseRole(page, 'admin');
  await page.goto('/settings');
  const first = page.locator('#settings-tab-general');
  await first.focus();
  await page.keyboard.press('ArrowDown');
  // Rendered groups are base → accounts → reference → notify; the admin's
  // Permissions tab is first in Accounts, before the notify-only rollout tab.
  const next = page.locator('#settings-tab-permissions');
  await expect(next).toBeFocused();
  await expect(next).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('tabpanel')).toHaveAttribute('aria-labelledby', 'settings-tab-permissions');
  await page.keyboard.press('Home');
  await expect(first).toBeFocused();
  await proveUiActions(info, ['src/app/(app)/settings/page.tsx::onSectionKeyDown#1'], { arrowDown: 'permissions', home: 'general', focusedSelectedPanelLinked: true });
});

for (const width of [320, 390, 768, 1024, 1440, 1600]) {
  test(`role picker and representative pages fit width ${width}`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto('/login');
    await expect(page.locator('[data-demo-role="it_manager"]')).toBeVisible();
    await expect(page.locator('[data-demo-role="portal_requester"]')).toBeVisible();
    const overflow = async () => page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1);
    expect(await overflow(), 'Login must not overflow the viewport.').toBe(false);
    await chooseRole(page, 'it_manager');
    if (width < 768) {
      // Exercise the real drawer at a shorter mobile height: the floating demo
      // toolbar must not obstruct its links in either writing direction.
      await page.setViewportSize({ width, height: 720 });
      for (const language of ['en', 'ar'] as const) {
        await page.goto('/dashboard');
        await setLanguageThroughUi(page, language);
        const copy = language === 'ar' ? ar : en;
        const menu = page.getByRole('button', { name: copy.nav.menu, exact: true }).and(page.locator('[aria-controls="app-navigation"][aria-expanded]'));
        await menu.click();
        await expect(menu).toHaveAttribute('aria-expanded', 'true');
        await page.locator('#app-navigation').getByRole('link', { name: copy.nav.settings, exact: true }).click();
        await expect(page).toHaveURL(/\/settings$/);
        await expect(menu).toHaveAttribute('aria-expanded', 'false');
      }
      await page.setViewportSize({ width, height: 900 });
    }
    for (const route of ['/dashboard', '/assets', '/reports?tab=inventory', '/requests', '/settings']) {
      await page.goto(route);
      await expect(page.getByRole('main')).toBeVisible();
      expect(await overflow(), `${route} must not create page-level horizontal overflow.`).toBe(false);
      await expect(page.locator('[data-demo-role-picker]')).toBeVisible();
    }
  });
}
