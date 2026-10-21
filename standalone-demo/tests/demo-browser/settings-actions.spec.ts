import { type Locator, type Page } from '@playwright/test';
import { en } from '../../src/studio/lib/translations/en';
import { test, expect, chooseRole, persistedSnapshot, proveUiActions, id, row } from './helpers';

const key = (file: string, action: string) => `src/components/settings/${file}.tsx::${action}`;
async function section(page: Page, name: string) {
  await page.goto(`/settings?section=${name}`);
  await page.locator(`#settings-tab-${name}`).click();
  await expect(page.locator(`#settings-tab-${name}`)).toHaveAttribute('aria-selected', 'true');
}
// The source Select has its own placeholder aria-label. Scope by the actual
// visible Field rather than changing the product or inventing a test selector.
function fieldSelect(scope: Page | Locator, label: string) {
  return scope.locator('label').filter({ hasText: label }).first().locator('..').locator('select');
}
async function committed(page: Page, table: string, name: string, column = 'name') {
  await expect.poll(async () => (await persistedSnapshot(page)).tables[table]?.filter(item => item[column] === name).length).toBe(1);
  return (await persistedSnapshot(page)).tables[table].find(item => item[column] === name)!;
}
test.beforeEach(async ({ page }) => {
  await page.goto('/login');
  await page.locator('button[lang="en"]').click();
  await chooseRole(page, 'admin');
});

test('reference dialogs create, edit and persist brands, categories and models through UI', async ({ page }, info) => {
  await section(page, 'companies');
  await page.locator('#catalog-tab-brands').click();
  await expect(page.locator('tbody tr')).not.toHaveCount(0);
  await page.getByRole('button', { name: en.companies.add, exact: true }).click();
  let dialog = page.getByRole('dialog');
  await dialog.getByLabel(en.companies.name).fill('QA Browser Brand');
  await dialog.getByLabel(en.companies.notes).fill('Created with a real dialog');
  await dialog.getByRole('button', { name: en.companies.save, exact: true }).click();
  const brand = await committed(page, 'companies', 'QA Browser Brand');
  await page.getByRole('row').filter({ hasText: 'QA Browser Brand' }).getByRole('button', { name: en.common.edit, exact: true }).click();
  await page.getByRole('dialog').getByLabel(en.companies.name).fill('QA Browser Brand Edited');
  await page.getByRole('dialog').getByRole('button', { name: en.companies.save, exact: true }).click();
  await committed(page, 'companies', 'QA Browser Brand Edited');
  await page.locator('#catalog-tab-categories').click();
  await expect(page.locator('tbody tr')).not.toHaveCount(0);
  await page.getByRole('button', { name: en.catalog.catAdd, exact: true }).click();
  dialog = page.getByRole('dialog');
  await dialog.getByLabel(en.catalog.catName).fill('QA Browser Category');
  await dialog.getByLabel(en.catalog.catNameAr).fill('فئة اختبار المتصفح');
  await dialog.getByLabel(en.catalog.catPrefix).fill('QAB');
  await dialog.getByRole('button', { name: en.catalog.save, exact: true }).click();
  const category = await committed(page, 'categories', 'QA Browser Category');
  await page.locator('#catalog-tab-models').click();
  await expect(page.locator('tbody tr')).not.toHaveCount(0);
  await page.getByRole('button', { name: en.catalog.mdlAdd, exact: true }).click();
  dialog = page.getByRole('dialog');
  await fieldSelect(dialog, en.catalog.mdlCategory).selectOption(String(category.id));
  await fieldSelect(dialog, en.catalog.mdlCompany).selectOption(String(brand.id));
  await dialog.getByLabel(en.catalog.mdlName).fill('QA Browser Model');
  await dialog.getByRole('button', { name: en.catalog.save, exact: true }).click();
  const model = await committed(page, 'models', 'QA Browser Model', 'model_name');
  expect(model).toMatchObject({ category_id: category.id, company_id: brand.id });
  await page.reload();
  await page.locator('#settings-tab-companies').click();
  await page.locator('#catalog-tab-models').click();
  await expect(page.getByRole('row').filter({ hasText: 'QA Browser Model' })).toBeVisible();
  await proveUiActions(info, [key('companies-settings', 'load#1'), key('companies-settings', 'submit#1'), key('catalog-settings', 'load#1'), key('catalog-settings', 'submit#1'), key('catalog-settings', 'load#2'), key('catalog-settings', 'submit#2')], { brand: brand.id, category: category.id, model: model.id, reload: true });
});

test('supplier dialog persists contact details and depreciation preserves its source read-only financial view', async ({ page }, info) => {
  await section(page, 'suppliers');
  await expect(page.locator('tbody tr')).not.toHaveCount(0);
  await page.getByRole('button', { name: en.suppliers.add, exact: true }).click();
  let dialog = page.getByRole('dialog');
  await dialog.getByLabel(en.suppliers.name).fill('QA Browser Supplier');
  await dialog.getByLabel(en.suppliers.phone).fill('0555550123');
  await dialog.getByLabel(en.suppliers.email).fill('qa-supplier@demo.invalid');
  await dialog.getByRole('button', { name: en.suppliers.save, exact: true }).click();
  const supplier = await committed(page, 'suppliers', 'QA Browser Supplier');
  expect(supplier).toMatchObject({ phone: '0555550123', email: 'qa-supplier@demo.invalid' });
  await section(page, 'depreciation');
  await expect(page.locator('tbody tr')).not.toHaveCount(0);
  const rules = (await persistedSnapshot(page)).tables.depreciation_rules;
  // listDepreciationRules always returns lifecycleAvailable:false; the source
  // intentionally pauses mutations while its lifecycle projection is unavailable.
  await expect(page.getByRole('heading', { name: en.depreciation.projectionUnavailableTitle, exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: en.depreciation.add, exact: true })).toHaveCount(0);
  await expect(page.locator('tbody tr')).toHaveCount(rules.length);
  await expect(page.getByRole('cell', { name: '33.33%', exact: true })).toHaveCount(rules.length);
  await expect(page.getByRole('cell', { name: en.depreciation.readOnly, exact: true })).toHaveCount(rules.length);
  await page.reload();
  await page.locator('#settings-tab-depreciation').click();
  await expect(page.getByRole('heading', { name: en.depreciation.projectionUnavailableTitle, exact: true })).toBeVisible();
  expect((await persistedSnapshot(page)).tables.depreciation_rules).toEqual(rules);
  await proveUiActions(info, [key('suppliers-settings', 'load#1'), key('suppliers-settings', 'submit#1'), key('depreciation-settings', 'load#1')], { supplier: supplier.id, unchangedFinancialRules: true, sourceReadOnly: true, displayedRuleCount: rules.length });
});

test('inventory defaults and notification thresholds save without modifying existing inventory', async ({ page }, info) => {
  const before = await persistedSnapshot(page);
  await section(page, 'inventory');
  await page.getByLabel(en.settings.inventory.defaultReorder).fill('17');
  await fieldSelect(page, en.settings.inventory.defaultWarehouse).selectOption(id(5, 6));
  await page.getByRole('button', { name: en.settings.inventory.save, exact: true }).first().click();
  await expect.poll(async () => (await persistedSnapshot(page)).tables.inventory_settings[0].default_reorder_level).toBe(17);
  expect((await persistedSnapshot(page)).tables.inventory_settings[0].default_location_id).toBe(id(5, 6));
  await section(page, 'notifications');
  await page.getByLabel(en.notifications.settings.overdueGraceDays).fill('4');
  await page.getByLabel(en.notifications.settings.maintenanceWindow).fill('21');
  await page.getByRole('button', { name: en.notifications.settings.save, exact: true }).first().click();
  await expect.poll(async () => (await persistedSnapshot(page)).tables.notification_settings[0].overdue_grace_days).toBe(4);
  const after = await persistedSnapshot(page);
  expect(after.tables.notification_settings[0].maintenance_due_window_days).toBe(21);
  expect(after.tables.assets).toEqual(before.tables.assets);
  expect(after.tables.consumables).toEqual(before.tables.consumables);
  await page.reload();
  await page.locator('#settings-tab-notifications').click();
  await expect(page.getByLabel(en.notifications.settings.overdueGraceDays)).toHaveValue('4');
  await proveUiActions(info, [key('inventory-settings', 'save#1'), key('notification-settings', 'save#1')], { defaultReorder: 17, graceDays: 4, existingInventoryUnchanged: true });
});

test('email controls persist local simulation and never mark an email as sent', async ({ page }, info) => {
  await section(page, 'notifications');
  const copy = en.notifications.emailAutomation;
  const before = await persistedSnapshot(page);
  const enabled = page.getByRole('checkbox', { name: copy.enabled, exact: true });
  await enabled.focus();
  if (!(await enabled.isChecked())) await enabled.press('Space');
  await expect(enabled).toBeChecked();
  await page.getByRole('button', { name: copy.save, exact: true }).first().click();
  await expect.poll(async () => (await persistedSnapshot(page)).tables.demo_email_settings[0]?.email_enabled).toBe(true);
  await page.getByRole('button', { name: copy.sendTest, exact: true }).click();
  await expect.poll(async () => (await persistedSnapshot(page)).tables.automation_deliveries.length).toBe(before.tables.automation_deliveries.length + 1);
  const state = await persistedSnapshot(page);
  expect(state.tables.automation_deliveries.at(-1)).toMatchObject({ status: 'suppressed', sent_at: null, safe_error: 'demo_no_email_sent' });
  const failed = before.tables.automation_deliveries.find(item => item.status === 'failed')!;
  const pending = before.tables.automation_deliveries.find(item => item.status === 'pending')!;
  expect(failed, 'Seeded failed delivery is required for actual retry proof').toBeTruthy();
  expect(pending, 'Seeded pending delivery is required for actual cancel proof').toBeTruthy();
  await page.getByRole('listitem').filter({ hasText: String(failed.recipient_email) }).getByRole('button', { name: copy.retry, exact: true }).click();
  await expect.poll(async () => row(await persistedSnapshot(page), 'automation_deliveries', String(failed.id)).status).toBe('suppressed');
  await page.getByRole('listitem').filter({ hasText: String(pending.recipient_email) }).getByRole('button', { name: copy.cancel, exact: true }).click();
  await expect.poll(async () => row(await persistedSnapshot(page), 'automation_deliveries', String(pending.id)).status).toBe('suppressed');
  expect((await persistedSnapshot(page)).tables.automation_deliveries.every(item => item.sent_at === null || item.sent_at === undefined)).toBe(true);
  await proveUiActions(info, [key('email-automation-settings', 'save#1'), key('email-automation-settings', 'sendStagingTest#1'), key('email-automation-settings', 'act#1')], { simulated: true, retryAndCancelPersisted: true, noEmailSent: true });
});

test('role matrix and per-user override change effective UI access after reload', async ({ page }, info) => {
  await section(page, 'permissions');
  const check = page.getByRole('checkbox', { name: `${en.roles.viewer} — asset.edit`, exact: true });
  await expect(check).toBeVisible();
  const before = await check.isChecked();
  await check.setChecked(!before);
  await expect.poll(async () => (await persistedSnapshot(page)).tables.role_permissions.some(item => item.role_key === 'viewer' && item.permission_key === 'asset.edit' && item.allowed !== false)).toBe(!before);
  await page.getByRole('combobox', { name: en.permissions.pickUser, exact: true }).selectOption(id(1, 4));
  const override = page.locator('div.flex.flex-wrap').filter({ has: page.locator('div.font-mono').filter({ hasText: /^asset\.edit$/ }) }).last();
  await override.getByRole('button', { name: en.permissions.deny, exact: true }).click();
  await expect.poll(async () => (await persistedSnapshot(page)).tables.user_permissions.find(item => item.user_id === id(1, 4) && item.permission_key === 'asset.edit')?.allow).toBe(false);
  await page.reload();
  await page.locator('#settings-tab-permissions').click();
  await page.getByRole('combobox', { name: en.permissions.pickUser, exact: true }).selectOption(id(1, 4));
  await expect(override.getByRole('button', { name: en.permissions.deny, exact: true })).toHaveAttribute('aria-pressed', 'true');
  await proveUiActions(info, [key('permissions-settings', 'loadMatrix#1'), key('permissions-settings', 'toggleRole#1'), key('permissions-settings', 'loadOverrides#1')], { roleTogglePersisted: true, userOverride: 'deny', user: id(1, 4) });
});

test('registration settings and pending approval/rejection dialogs preserve real account decisions', async ({ page }, info) => {
  await section(page, 'registration');
  await fieldSelect(page, en.usersAdmin.mode).selectOption('invite_only');
  await page.getByRole('button', { name: en.usersAdmin.saveSettings, exact: true }).first().click();
  await expect.poll(async () => (await persistedSnapshot(page)).tables.registration_settings[0].mode).toBe('invite_only');
  // Create a pending request through the existing reset control, not an SDK write.
  await page.getByRole('combobox', { name: en.usersAdmin.allStatuses, exact: true }).selectOption('');
  const viewer = (await persistedSnapshot(page)).tables.app_users.find(item => item.id === id(1, 4))!;
  let userRow = page.getByRole('row').filter({ hasText: String(viewer.email) });
  await userRow.getByRole('button', { name: en.usersAdmin.resetPending, exact: true }).click();
  await expect.poll(async () => row(await persistedSnapshot(page), 'app_users', id(1, 4)).approval_status).toBe('pending');
  await userRow.getByRole('button', { name: en.usersAdmin.approve, exact: true }).click();
  await fieldSelect(page.getByRole('dialog'), en.usersAdmin.assignRole).selectOption('viewer');
  await page.getByRole('dialog').getByRole('button', { name: en.usersAdmin.confirmApprove, exact: true }).click();
  await expect.poll(async () => row(await persistedSnapshot(page), 'app_users', id(1, 4)).approval_status).toBe('approved');
  userRow = page.getByRole('row').filter({ hasText: String(viewer.email) });
  await userRow.getByRole('button', { name: en.usersAdmin.resetPending, exact: true }).click();
  await userRow.getByRole('button', { name: en.usersAdmin.reject, exact: true }).click();
  await page.getByRole('dialog').getByLabel(en.usersAdmin.rejectReason).fill('QA request rejected by reviewer');
  await page.getByRole('dialog').getByRole('button', { name: en.usersAdmin.confirmReject, exact: true }).click();
  await expect.poll(async () => row(await persistedSnapshot(page), 'app_users', id(1, 4)).approval_status).toBe('rejected');
  expect(row(await persistedSnapshot(page), 'app_users', id(1, 4))).toMatchObject({ is_active: false, rejection_reason: 'QA request rejected by reviewer' });
  await page.reload();
  expect(row(await persistedSnapshot(page), 'app_users', id(1, 4)).approval_status).toBe('rejected');
  await proveUiActions(info, [key('registration-settings', 'loadSettings#1'), key('registration-settings', 'saveSettings#1'), key('registration-settings', 'loadRequests#1'), key('registration-settings', 'submit#1'), key('registration-settings', 'submit#2')], { approvedThenRejected: id(1, 4), reloadPreservedDecision: true });
});

test('user change-role and deactivation dialogs commit ownership and active state', async ({ page }, info) => {
  await section(page, 'users');
  const before = await persistedSnapshot(page);
  const target = row(before, 'app_users', id(1, 4));
  let userRow = page.getByRole('row').filter({ hasText: String(target.email) });
  await userRow.getByRole('button', { name: en.usersAdmin.changeRole, exact: true }).click();
  await fieldSelect(page.getByRole('dialog'), en.usersAdmin.assignRole).selectOption('warehouse_manager');
  await page.getByRole('dialog').getByRole('button', { name: en.usersAdmin.confirmChangeRole, exact: true }).click();
  await expect.poll(async () => row(await persistedSnapshot(page), 'app_users', id(1, 4)).role_key).toBe('warehouse_manager');
  userRow = page.getByRole('row').filter({ hasText: String(target.email) });
  await userRow.getByRole('button', { name: en.usersAdmin.deactivate, exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: en.usersAdmin.confirmDeactivate, exact: true }).click();
  await expect.poll(async () => row(await persistedSnapshot(page), 'app_users', id(1, 4)).is_active).toBe(false);
  await page.goto('/assets');
  expect(row(await persistedSnapshot(page), 'app_users', id(1, 4)).is_active, 'Ordinary navigation must never reapprove or reactivate edited accounts').toBe(false);
  expect((await persistedSnapshot(page)).tables.asset_assignments).toEqual(before.tables.asset_assignments);
  await proveUiActions(info, [key('users-settings', 'load#1'), key('users-settings', 'submit#1'), key('users-settings', 'submit#2')], { role: 'warehouse_manager', inactive: id(1, 4), custodyUnchanged: true });
});

test('progressive rollout saves a display policy and leaves authorization unchanged', async ({ page }, info) => {
  await section(page, 'featureRollout');
  const before = await persistedSnapshot(page);
  // The native wrapping label includes the visible hint in its accessible name.
  const toggle = page.getByRole('checkbox', { name: en.settings.featureRollout.enabledLabel });
  await toggle.focus();
  if (!(await toggle.isChecked())) await toggle.press('Space');
  await expect(toggle).toBeChecked();
  await page.getByRole('button', { name: /^80%/ }).click();
  await page.getByRole('button', { name: en.settings.featureRollout.save, exact: true }).first().click();
  await expect.poll(async () => (await persistedSnapshot(page)).tables.feature_exposure_settings[0].level).toBe(80);
  const after = await persistedSnapshot(page);
  expect(after.tables.feature_exposure_settings[0].enabled).toBe(true);
  expect(after.tables.role_permissions).toEqual(before.tables.role_permissions);
  expect(after.tables.user_permissions).toEqual(before.tables.user_permissions);
  await page.reload();
  await page.locator('#settings-tab-featureRollout').click();
  await expect(toggle).toBeChecked();
  await proveUiActions(info, [key('feature-rollout-settings', 'save#1')], { level: 80, authorizationUnchanged: true });
});
