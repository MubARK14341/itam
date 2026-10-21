import { test, expect, chooseRole, persistedSnapshot, proveUiActions, waitForUiAnimations, id, personas } from './helpers';
import { en } from '../../src/studio/lib/translations/en';
import { demoCopy } from '../../src/demo/translations';

async function english(page: Parameters<typeof chooseRole>[0]) {
  await page.goto('/login');
  await page.locator('button[lang="en"]').click();
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
}

test('blocked IndexedDB shows local-storage recovery and retry initializes an anonymous baseline', async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('itam_lang', 'en');
    const open = indexedDB.open.bind(indexedDB);
    Object.defineProperty(indexedDB, 'open', { configurable: true, value: (...args: Parameters<IDBFactory['open']>) => {
      if (sessionStorage.getItem('demo-qa:allow-storage') !== 'yes') throw new DOMException('Synthetic QA storage denial', 'SecurityError');
      return open(...args);
    } });
  });
  await page.goto('/login');
  await expect(page.getByRole('alert')).toHaveText(demoCopy.en.startupError);
  await expect(page.getByText(demoCopy.en.storageRequired, { exact: true })).toBeVisible();
  await expect(page.locator('[data-demo-role]')).toHaveCount(0);
  expect(await page.evaluate(() => indexedDB.databases())).toEqual([]);
  await page.evaluate(() => sessionStorage.setItem('demo-qa:allow-storage', 'yes'));
  await page.getByRole('button', { name: demoCopy.en.retry, exact: true }).click();
  await expect(page.locator('[data-demo-role="it_manager"]')).toBeVisible();
  const initialized = await persistedSnapshot(page);
  expect(initialized.actorId).toBeNull(); expect(initialized.tables.assets.length).toBeGreaterThan(0);
  expect(Object.keys(initialized.operations)).toHaveLength(0);
});

for (const scenario of [
  { lang: 'ar', theme: 'dark', width: 320 },
  { lang: 'en', theme: 'light', width: 390 },
  { lang: 'ar', theme: 'light', width: 1440 },
  { lang: 'en', theme: 'dark', width: 1600 },
] as const) {
  test(`language, theme, keyboard and screenshots ${scenario.lang}/${scenario.theme}/${scenario.width}`, async ({ page }, info) => {
    await page.setViewportSize({ width: scenario.width, height: 1000 });
    await page.goto('/login');
    await page.locator(`button[lang="${scenario.lang}"]`).click();
    await expect(page.locator('html')).toHaveAttribute('lang', scenario.lang);
    await expect(page.locator('html')).toHaveAttribute('dir', scenario.lang === 'ar' ? 'rtl' : 'ltr');
    if (scenario.theme === 'dark') await page.getByRole('button', { name: scenario.lang === 'ar' ? 'داكن' : 'Dark', exact: true }).click();
    await expect.poll(() => page.locator('html').evaluate(element => element.classList.contains('dark'))).toBe(scenario.theme === 'dark');
    const card = page.locator('[data-demo-role="it_manager"]');
    await card.focus(); await expect(card).toBeFocused();
    await waitForUiAnimations(page);
    await page.screenshot({ path: info.outputPath(`login-${scenario.lang}-${scenario.theme}-${scenario.width}.png`), fullPage: true });
    await card.press('Enter');
    await expect(page).toHaveURL(/\/dashboard$/);
    await expect(page.getByRole('main')).toBeVisible();
    for (const route of ['/dashboard', '/assets', '/reports']) {
      await page.goto(route);
      await expect(page.getByRole('main')).toBeVisible();
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
      await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1);
      await waitForUiAnimations(page);
      await page.screenshot({ path: info.outputPath(`${route.slice(1)}-${scenario.lang}-${scenario.theme}-${scenario.width}.png`), fullPage: true });
    }
    await page.reload();
    await expect(page.locator('html')).toHaveAttribute('lang', scenario.lang);
    expect(await page.locator('html').evaluate(element => element.classList.contains('dark'))).toBe(scenario.theme === 'dark');
  });
}

for (const persona of ['portal_project_manager', 'portal_requester', 'portal_receiver'] as const) {
  test(`portal profile saves own contact for ${persona} and exposes city editing only to project manager`, async ({ page }, info) => {
    await english(page); await chooseRole(page, persona); await page.goto('/client-portal/profile');
    const before = await persistedSnapshot(page);
    const actorUser = before.tables.customer_portal_users.find(user => user.id === id(1, personas.indexOf(persona) + 1));
    expect(actorUser, 'The actual selected portal user must exist.').toBeDefined();
    const name = page.getByLabel('Contact name');
    await expect(name).not.toHaveValue('');
    const original = await name.inputValue();
    await name.fill(`QA ${persona}`);
    await page.getByLabel('Phone').fill('0501234567');
    const city = page.getByLabel('City');
    if (persona === 'portal_project_manager') { await expect(city).toBeEditable(); await city.fill('QA Riyadh'); }
    else await expect(city).toHaveAttribute('readonly', '');
    await page.getByRole('button', { name: 'Save changes', exact: true }).click();
    await expect(page.getByText('Profile updated.', { exact: true })).toBeVisible();
    await page.reload();
    await expect(name).toHaveValue(`QA ${persona}`);
    await expect(page.getByLabel('Phone')).toHaveValue('0501234567');
    const after = await persistedSnapshot(page);
    const changed = after.tables.customer_portal_users.filter((user, index) => JSON.stringify(user) !== JSON.stringify(before.tables.customer_portal_users[index]));
    expect(changed).toHaveLength(1);
    expect(changed[0]).toMatchObject({ contact_name: `QA ${persona}`, phone: '0501234567' });
    expect(changed[0].id).toBe(actorUser!.id);
    expect(original).not.toBe(`QA ${persona}`);
    if (persona === 'portal_project_manager') await expect(city).toHaveValue('QA Riyadh');
    else expect(after.tables.customers).toEqual(before.tables.customers);
    await proveUiActions(info, ['src/app/(portal)/client-portal/profile/page-client.tsx::save#1'], { ownUser: actorUser!.id, contactAndPhonePersisted: true, cityEditable: persona === 'portal_project_manager' });
  });
}

test('anonymous login, registration and public QR never create an employee session', async ({ page }) => {
  for (const route of ['/login', '/register', '/client-portal-register', '/a/0000006f-0000-4000-8000-000000000001']) {
    await page.goto(route);
    await expect(page.getByRole('main')).toBeVisible();
    await expect.poll(async () => (await persistedSnapshot(page)).actorId).toBeNull();
  }
});

test('staff registration validates confirmation and persists a pending local request without a session', async ({ page }, info) => {
  await english(page); await page.goto('/register');
  const copy = en.registration, before = await persistedSnapshot(page);
  await page.getByLabel(copy.fullName).fill('Demo QA new staff');
  await page.getByLabel(copy.email).fill('qa-new-staff@demo.invalid');
  await page.locator('#register-password').fill('DemoOnly!12345');
  await page.getByLabel(copy.confirmPassword).fill('DifferentDemo!12345');
  await page.getByLabel(copy.phone).fill('+966501234567');
  await page.getByRole('combobox', { name: copy.chooseDepartment, exact: true }).selectOption(id(6, 1));
  await page.getByLabel(copy.note).fill('Synthetic local signup request');
  await page.getByRole('button', { name: copy.submit, exact: true }).click();
  await expect(page.getByRole('alert')).toContainText(copy.errPasswordMatch);
  expect((await persistedSnapshot(page)).tables.app_users).toEqual(before.tables.app_users);
  await page.getByLabel(copy.confirmPassword).fill('DemoOnly!12345');
  await page.getByRole('button', { name: en.auth.showPassword, exact: true }).click();
  await expect(page.locator('#register-password')).toHaveAttribute('type', 'text');
  await page.getByRole('button', { name: en.auth.hidePassword, exact: true }).click();
  await page.getByRole('button', { name: copy.submit, exact: true }).click();
  await expect(page.getByText(copy.successApproval, { exact: true })).toBeVisible();
  const after = await persistedSnapshot(page), created = after.tables.app_users.filter(user => !before.tables.app_users.some(prior => prior.id === user.id));
  expect(created).toHaveLength(1);
  expect(created[0]).toMatchObject({ email: 'qa-new-staff@demo.invalid', full_name: 'Demo QA new staff', phone: '+966501234567', department_id: id(6, 1), registration_note: 'Synthetic local signup request', approval_status: 'pending', is_active: true });
  expect(after.actorId).toBeNull(); expect(after.tables.customer_portal_users).toEqual(before.tables.customer_portal_users);
  expect(after.tables.automation_deliveries.every(delivery => delivery.sent_at == null)).toBe(true);
  await info.attach('demo-public-registration-ui', { body: JSON.stringify({ kind: 'staff', channel: 'ui', pendingUser: created[0].id, validationRejectedPartial: true, noSessionOrEmail: true }), contentType: 'application/json' });
});

for (const invited of [false, true]) {
  test(`portal registration ${invited ? 'claims a local invite for the existing customer' : 'creates a pending local customer'} without a staff profile`, async ({ page }, info) => {
    await english(page); await page.goto('/client-portal-register');
    const copy = en.portal.register, before = await persistedSnapshot(page), email = invited ? 'qa-invited-customer@demo.invalid' : 'qa-new-customer@demo.invalid';
    await page.getByLabel(copy.fullName).fill('Demo QA portal contact');
    await page.getByLabel(copy.phone).fill('+966501234568');
    await page.getByLabel(copy.companyName).fill('Demo QA local company');
    await page.getByLabel(copy.city).fill('QA Riyadh');
    await page.getByLabel(copy.email).fill(email);
    await page.getByLabel(copy.password).fill('DemoOnly!12345');
    if (invited) { await page.getByRole('button', { name: copy.haveCode, exact: true }).click(); await page.getByLabel(copy.code).fill('DEMO-PORTAL'); }
    await page.getByRole('button', { name: copy.createAccount, exact: true }).click();
    await expect(page.getByText(invited ? copy.doneVerify : copy.donePending, { exact: true })).toBeVisible();
    const after = await persistedSnapshot(page), created = after.tables.customer_portal_users.filter(user => !before.tables.customer_portal_users.some(prior => prior.id === user.id));
    expect(created).toHaveLength(1); expect(created[0]).toMatchObject({ contact_name: 'Demo QA portal contact', phone: '+966501234568', portal_role: invited ? 'authorized_requester' : 'project_manager' });
    expect(after.tables.app_users).toEqual(before.tables.app_users); expect(after.actorId).toBeNull();
    if (invited) {
      expect(created[0].customer_id).toBe(id(3, 1)); expect(after.tables.customers).toEqual(before.tables.customers);
      const beforeInvite = before.tables.customer_portal_invites.find(invite => invite.code === 'DEMO-PORTAL'), afterInvite = after.tables.customer_portal_invites.find(invite => invite.code === 'DEMO-PORTAL');
      expect(beforeInvite).toBeDefined(); expect(afterInvite).toBeDefined(); expect(afterInvite!.used_count).toBe(Number(beforeInvite!.used_count) + 1);
    } else {
      const customer = after.tables.customers.find(customer => customer.id === created[0].customer_id);
      expect(customer).toMatchObject({ name: 'Demo QA local company', email, city: 'QA Riyadh', approval_status: 'pending', is_active: true });
      expect(after.tables.customers.length).toBe(before.tables.customers.length + 1);
    }
    expect(after.tables.automation_deliveries.every(delivery => delivery.sent_at == null)).toBe(true);
    await info.attach('demo-public-registration-ui', { body: JSON.stringify({ kind: 'portal', invited, channel: 'ui', portalUser: created[0].id, customer: created[0].customer_id, noStaffProfileOrSessionOrEmail: true }), contentType: 'application/json' });
  });
}

test('MFA enrollment rejects a wrong code, accepts demo code and persists verified local factor', async ({ page }) => {
  await english(page); await chooseRole(page, 'admin'); await page.goto('/auth/mfa');
  const input = page.locator('input[name="code"]');
  await expect(input).toBeVisible();
  await expect(page.getByAltText('TOTP QR')).toBeVisible();
  await input.fill('000000'); await page.getByRole('button', { name: 'تحقق / Verify', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Invalid or expired code.');
  await input.press('ControlOrMeta+A'); await input.pressSequentially('123456');
  await expect(input).toHaveValue('123456');
  await page.getByRole('button', { name: 'تحقق / Verify', exact: true }).click();
  await expect(page).toHaveURL(/\/dashboard$/);
  const state = await persistedSnapshot(page);
  const factors = Object.values(state.mfa).flat();
  expect(factors.filter(factor => factor.status === 'verified')).toHaveLength(1);
  await page.reload(); await page.goto('/auth/mfa');
  await expect(input).toBeVisible(); await expect(page.getByAltText('TOTP QR')).toHaveCount(0);
});

test('UI reset clears all demo data/session/markers in sibling tabs, preserves preferences and unrelated storage', async ({ page }) => {
  await english(page); await page.getByRole('button', { name: 'Dark', exact: true }).click();
  await chooseRole(page, 'portal_project_manager'); await page.goto('/client-portal/profile');
  const name = page.getByLabel('Contact name');
  await expect(name).not.toHaveValue(''); const original = await name.inputValue();
  await name.fill('QA RESET CONTACT'); await page.getByLabel('Phone').fill('0501234567');
  await page.getByRole('button', { name: 'Save changes', exact: true }).click();
  await expect(page.getByText('Profile updated.', { exact: true })).toBeVisible();
  const before = await persistedSnapshot(page);
  const sibling = await page.context().newPage(); await sibling.goto('/client-portal/profile');
  await expect(sibling.getByLabel('Contact name')).toHaveValue('QA RESET CONTACT');
  for (const current of [page, sibling]) await current.evaluate(() => {
    sessionStorage.setItem('itam:pending-operation:v1:qa', 'pending');
    sessionStorage.setItem('itam:portal-create:v1:qa', 'draft');
    sessionStorage.setItem('itam_exposure_preview', 'qa');
    localStorage.setItem('itam.private-views.v1:qa', 'private');
    localStorage.setItem('demo-qa:unrelated', 'keep');
  });
  await page.locator('[data-demo-reset]').click();
  const dialog = page.getByRole('dialog'); await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'Reset', exact: true }).click();
  for (const current of [page, sibling]) {
    await expect(current).toHaveURL(/\/login$/);
    await expect(current.locator('[data-demo-role="it_manager"]')).toBeVisible();
    const storage = await current.evaluate(() => ({ pending: Object.keys(sessionStorage).filter(key => key.startsWith('itam:pending-operation:v1:') || key.startsWith('itam:portal-create:v1:') || key === 'itam_exposure_preview'), views: Object.keys(localStorage).filter(key => key.startsWith('itam.private-views.v1:')), unrelated: localStorage.getItem('demo-qa:unrelated'), lang: localStorage.getItem('itam_lang'), theme: localStorage.getItem('itam_theme') }));
    expect(storage).toEqual({ pending: [], views: [], unrelated: 'keep', lang: 'en', theme: 'dark' });
    expect(await current.locator('html').evaluate(element => element.classList.contains('dark'))).toBe(true);
    const state = await persistedSnapshot(current); expect(state.actorId).toBeNull();
    expect(state.generation).toBeGreaterThan(before.generation); expect(Object.keys(state.operations)).toHaveLength(0); expect(Object.keys(state.blobs).sort()).toEqual(Object.keys(before.blobs).sort());
  }
  await chooseRole(page, 'portal_project_manager'); await page.goto('/client-portal/profile');
  await expect(name).toHaveValue(original);
  await sibling.close();
});
