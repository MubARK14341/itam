import { readFile } from 'node:fs/promises';
import { en } from '../../src/studio/lib/translations/en';
import { ar } from '../../src/studio/lib/translations/ar';
import { test, expect, chooseRole, setLanguageThroughUi, persistedSnapshot, proveUiActions, id, row } from './helpers';

async function english(page: Parameters<typeof chooseRole>[0]) {
  await page.goto('/login'); await page.locator('button[lang="en"]').click();
}
test.beforeEach(async ({ page }) => { await english(page); });

test('employee issue dialog creates own maintenance without transferring custody', async ({ page }, info) => {
  await chooseRole(page, 'employee'); await page.goto('/my-assets');
  const before = await persistedSnapshot(page);
  const card = page.locator('article').filter({ has: page.locator(`#asset-${id(11, 2)}`) });
  await expect(card).toBeVisible();
  await card.getByRole('button', { name: en.employeeSelfService.reportIssue, exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel(en.employeeSelfService.issueDescription).fill('QA keyboard intermittently fails');
  await dialog.getByRole('button', { name: en.employeeSelfService.reportIssue, exact: true }).click();
  await expect.poll(async () => (await persistedSnapshot(page)).tables.maintenance_records.filter(item => item.asset_id === id(11, 2) && item.problem_description === 'QA keyboard intermittently fails').length).toBe(1);
  const after = await persistedSnapshot(page);
  expect(row(after, 'assets', id(11, 2)).assigned_to_employee_id).toBe(id(8, 2));
  expect(after.tables.asset_assignments).toEqual(before.tables.asset_assignments);
  const issue = after.tables.maintenance_records.find(item => item.problem_description === 'QA keyboard intermittently fails')!;
  expect(issue.reported_by_employee_id).toBe(id(8, 2));
  await page.reload();
  await expect(card).toBeVisible();
  await proveUiActions(info, ['src/app/(app)/my-assets/page-client.tsx::submitIssue#1'], { asset: id(11, 2), employee: id(8, 2), maintenance: issue.id, custodyUnchanged: true });
});

test('employee return dialog leaves custody pending until warehouse receipt', async ({ page }, info) => {
  await chooseRole(page, 'employee'); await page.goto('/my-assets');
  const before = await persistedSnapshot(page);
  const card = page.locator('article').filter({ has: page.locator(`#asset-${id(11, 2)}`) });
  await card.getByRole('button', { name: en.employeeSelfService.requestReturn, exact: true }).click();
  await page.getByRole('dialog').getByLabel(en.employeeSelfService.returnReason).fill('QA project finished');
  await page.getByRole('dialog').getByRole('button', { name: en.employeeSelfService.requestReturn, exact: true }).click();
  await expect.poll(async () => (await persistedSnapshot(page)).tables.employee_return_requests.filter(item => item.asset_id === id(11, 2) && item.reason === 'QA project finished').length).toBe(1);
  const after = await persistedSnapshot(page);
  expect(row(after, 'assets', id(11, 2)).assigned_to_employee_id).toBe(id(8, 2));
  expect(after.tables.asset_assignments).toEqual(before.tables.asset_assignments);
  expect(after.tables.asset_movements).toEqual(before.tables.asset_movements);
  await expect(card.getByRole('button', { name: en.employeeSelfService.returnAlreadyRequested, exact: true })).toBeDisabled();
  await page.reload();
  await expect(card.getByRole('button', { name: en.employeeSelfService.returnAlreadyRequested, exact: true })).toBeDisabled();
  await proveUiActions(info, ['src/app/(app)/my-assets/page-client.tsx::submitReturn#1'], { pendingOnly: true, custodyAndMovementUnchanged: true, duplicateDisabled: true });
});

test('employee creates an equipment request and replies to own clarification through UI', async ({ page }, info) => {
  await chooseRole(page, 'employee'); await page.goto('/my-requests');
  await page.getByRole('button', { name: en.employeeSelfService.newRequest, exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel(en.employeeSelfService.description).fill('QA Browser ergonomic keyboard');
  await dialog.getByLabel(en.employeeSelfService.quantity).fill('2');
  await dialog.getByLabel(en.employeeSelfService.projectName).fill('QA Browser project');
  await dialog.getByRole('button', { name: en.employeeSelfService.submitRequest, exact: true }).click();
  await expect.poll(async () => (await persistedSnapshot(page)).tables.requests.filter(item => item.project_name === 'QA Browser project').length).toBe(1);
  let state = await persistedSnapshot(page);
  const request = state.tables.requests.find(item => item.project_name === 'QA Browser project')!;
  expect(request).toMatchObject({ submitted_by: id(1, 2), beneficiary_employee_id: id(8, 2), request_type: 'internal', status: 'under_review' });
  expect(state.tables.request_items.filter(item => item.request_id === request.id)).toMatchObject([{ quantity: 2, requested_description: 'QA Browser ergonomic keyboard' }]);
  const clarification = row(state, 'requests', id(16, 3));
  await page.getByRole('article', { name: String(clarification.request_number), exact: true })
    .getByRole('button', { name: en.employeeSelfService.showDetails, exact: true }).click();
  await page.getByLabel(en.employeeSelfService.clarification).fill('QA provide standard keyboard with Arabic layout');
  await page.getByRole('button', { name: en.employeeSelfService.sendReply, exact: true }).click();
  await expect.poll(async () => row(await persistedSnapshot(page), 'requests', id(16, 3)).status).toBe('under_review');
  state = await persistedSnapshot(page);
  expect(state.tables.request_events.filter(item => item.request_id === id(16, 3) && item.message === 'QA provide standard keyboard with Arabic layout')).toHaveLength(1);
  await page.reload();
  await expect(page.getByText('QA Browser project', { exact: true })).toBeVisible();
  await proveUiActions(info, ['src/app/(app)/my-requests/page-client.tsx::submit#1'], { request: request.id, ownEmployee: id(8, 2), quantity: 2, clarificationReplyPersisted: true });
});

test('my tasks loads actual own requests and custody rather than a placeholder', async ({ page }, info) => {
  await chooseRole(page, 'employee'); await page.goto('/my-tasks');
  const state = await persistedSnapshot(page);
  const request = row(state, 'requests', id(16, 2));
  await expect(page.getByText(String(request.request_number), { exact: false }).first()).toBeVisible();
  await expect(page.getByRole('link', { name: /My Assets|custody/i }).first()).toBeVisible();
  expect(state.tables.requests.some(item => item.submitted_by === id(1, 2))).toBe(true);
  await proveUiActions(info, ['src/app/(app)/my-tasks/page-client.tsx::load#1'], { ownRequestRendered: request.id, employee: id(8, 2) });
});

test('action center sync, assign, note, start and export have persisted or downloaded evidence', async ({ page }, info) => {
  await chooseRole(page, 'it_manager'); await page.goto('/alerts');
  const copy = en.actionCenter;
  await page.getByRole('button', { name: copy.syncNow, exact: true }).click();
  await expect(page.getByRole('button', { name: copy.syncNow, exact: true })).toHaveAttribute('aria-busy', 'false');
  await expect(page.getByRole('tabpanel').locator('li button').first()).toBeVisible();
  await page.getByRole('tabpanel').locator('li button').first().click();
  const prior = await persistedSnapshot(page);
  // Managers use the real assignee dialog. "Assign to me" is the distinct
  // operator branch in AlertDetail and is not mounted for this persona.
  await page.getByRole('button', { name: copy.assign, exact: true }).click();
  const assignmentDialog = page.getByRole('dialog');
  await expect(assignmentDialog.locator(`option[value="${id(1, 1)}"]`)).toHaveCount(1);
  await assignmentDialog.locator('select').selectOption(id(1, 1));
  await assignmentDialog.getByRole('button', { name: en.common.save, exact: true }).click();
  await expect.poll(async () => (await persistedSnapshot(page)).tables.action_alert_instances.filter(item => item.assigned_to === id(1, 1)).length).toBeGreaterThan(0);
  const assigned = (await persistedSnapshot(page)).tables.action_alert_instances.find(item => item.assigned_to === id(1, 1))!;
  await page.getByRole('button', { name: copy.note, exact: true }).click();
  await page.getByRole('dialog').getByLabel(copy.noteLabel).fill('QA Browser follow-up note');
  await page.getByRole('dialog').getByRole('button', { name: en.common.save, exact: true }).click();
  await expect.poll(async () => (await persistedSnapshot(page)).tables.action_alert_events.filter(item => item.note === 'QA Browser follow-up note').length).toBe(1);
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: copy.exportCsv, exact: true }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe('action-center.csv');
  const csv = await readFile((await download.path())!, 'utf8');
  expect(csv).toContain(copy.csvStatus); expect(csv.split('\n').length).toBeGreaterThan(2);
  await page.getByRole('button', { name: copy.start, exact: true }).click();
  await expect.poll(async () => row(await persistedSnapshot(page), 'action_alert_instances', String(assigned.id)).status).toBe('in_progress');
  expect(prior.tables.action_alert_instances.length).toBeGreaterThan(0);
  await proveUiActions(info, ['src/app/(app)/alerts/page-client.tsx::refresh#1', 'src/app/(app)/alerts/page-client.tsx::exportCsv#1', 'src/app/(app)/alerts/page-client.tsx::act#1'], { alert: assigned.id, assignNoteStartPersisted: true, downloadRows: csv.split('\n').length });
});

test('topbar search remains read-only and manual smart move commits only after confirmation', async ({ page }, info) => {
  // Scan CSV is visible from exposure 70; admin uses the actual full UI (100).
  await chooseRole(page, 'admin');
  const before = await persistedSnapshot(page);
  await page.getByRole('search').getByRole('searchbox').fill('LAP-0101');
  await page.getByRole('search').getByRole('searchbox').press('Enter');
  await expect(page).toHaveURL(/\/scan$/);
  await expect(page.getByText('LAP-0101', { exact: true }).first()).toBeVisible();
  await expect.poll(async () => (await persistedSnapshot(page)).tables.scan_logs.length).toBeGreaterThan(before.tables.scan_logs.length);
  expect((await persistedSnapshot(page)).tables.asset_movements).toEqual(before.tables.asset_movements);
  await page.getByRole('button', { name: en.scan.modes.smart, exact: true }).click();
  await page.getByRole('textbox', { name: en.scan.manualPlaceholder, exact: true }).fill('LAP-0101');
  await page.getByRole('button', { name: en.scan.searchBtn, exact: true }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  expect((await persistedSnapshot(page)).tables.asset_movements).toEqual(before.tables.asset_movements);
  await dialog.getByRole('combobox', { name: en.scan.destination, exact: true }).selectOption(id(5, 2));
  await dialog.getByRole('button', { name: en.scan.smartConfirmExit, exact: true }).click();
  await expect.poll(async () => row(await persistedSnapshot(page), 'assets', id(11, 101)).location_id).toBe(id(5, 2));
  const after = await persistedSnapshot(page);
  expect(after.tables.asset_movements.length).toBe(before.tables.asset_movements.length + 1);
  await expect(page.getByRole('button', { name: en.scan.exportBtn, exact: true })).toBeEnabled();
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: en.scan.exportBtn, exact: true }).click();
  const download = await downloadPromise;
  expect(await download.failure()).toBeNull();
  const csv = await readFile((await download.path())!, 'utf8');
  expect(csv).toContain('LAP-0101'); expect(csv.split('\n').length).toBeGreaterThan(2);
  await page.reload();
  expect(row(await persistedSnapshot(page), 'assets', id(11, 101)).location_id).toBe(id(5, 2));
  await proveUiActions(info, ['src/components/app-topbar.tsx::submit#1', 'src/components/scan/scan-console.tsx::submitManual#1', 'src/components/scan/scan-console.tsx::confirmSmartMove#1', 'src/components/scan/scan-history.tsx::exportCsv#1'], { searchMovementUnchanged: true, confirmedMovementCount: 1, asset: id(11, 101), scanHistoryContainsAsset: true });
});

for (const surface of ['sidebar', 'topbar', 'portal', 'pending'] as const) {
  const languages: readonly ('en' | 'ar')[] = surface === 'sidebar' || surface === 'topbar' ? ['en', 'ar'] : ['en'];
  for (const language of languages) test(`${surface} sign out clears the actual browser session (${language})`, async ({ page }, info) => {
    await chooseRole(page, surface === 'portal' ? 'portal_project_manager' : 'it_manager');
    const copy = language === 'ar' ? ar : en;
    if (language === 'ar') await setLanguageThroughUi(page, language);
    await expect(page.locator('html')).toHaveAttribute('dir', language === 'ar' ? 'rtl' : 'ltr');
    if (surface === 'sidebar') await page.setViewportSize({ width: 1280, height: 720 });
    if (surface === 'topbar') await page.setViewportSize({ width: 390, height: 900 });
    if (surface === 'pending') await page.goto('/pending-approval');
    const source = surface === 'portal' ? 'src/app/(portal)/client-portal/layout.tsx' : surface === 'pending' ? 'src/app/pending-approval/page.tsx' : `src/components/${surface === 'topbar' ? 'app-topbar' : 'sidebar'}.tsx`;
    const button = surface === 'sidebar' ? page.locator('.app-sidebar').getByRole('button', { name: copy.nav.signOut, exact: true })
      : surface === 'topbar' ? page.locator('.app-topbar').getByRole('button', { name: copy.nav.signOut, exact: true })
      : page.getByRole('button', { name: surface === 'pending' ? copy.registration.signOut : copy.portal.signOut, exact: true });
    await button.click();
    await expect(page).toHaveURL(/\/login$/);
    await expect.poll(async () => (await persistedSnapshot(page)).actorId).toBeNull();
    await page.reload();
    expect((await persistedSnapshot(page)).actorId).toBeNull();
    await proveUiActions(info, [`${source}::signOut#1`], { surface, language, viewport: page.viewportSize(), unforcedPointerClick: true, anonymousAfterReload: true });
  });
}
