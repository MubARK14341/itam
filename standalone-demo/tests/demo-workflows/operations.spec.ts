import type { Page, Locator, Download } from '@playwright/test';
import { test, expect, chooseRole, persistedSnapshot, id, proveUiActions } from '../demo-browser/helpers';
import { getDict } from '../../src/studio/lib/i18n';
import { exactFieldLabel, labeledSelect } from './fields';
import { demoCopy } from '../../src/demo/translations';
import { parseCsv } from '../../src/studio/lib/csv-import';

const en = getDict('en');
async function english(page: Page) {
  await page.goto('/login');
  await page.getByRole('button', { name: 'EN', exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
}
async function downloadCsv(download: Download) {
  expect(await download.failure()).toBeNull();
  const stream = await download.createReadStream();
  expect(stream).toBeTruthy();
  const chunks: Buffer[] = [];
  for await (const chunk of stream!) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
}
const dialog = (page: Page) => page.getByRole('dialog');
async function selectField(scope: Page | Locator, label: string, value: string) {
  await labeledSelect(scope, label).selectOption(value);
}
async function committed(page: Page, table: string, target: string, property: string, value: unknown) {
  await expect.poll(async () => (await persistedSnapshot(page)).tables[table]?.find((row) => row.id === target)?.[property]).toEqual(value);
}
function futureDate(days: number) {
  return new Date(Date.now() + days * 86_400_000).toLocaleDateString('en-CA', { timeZone: 'Asia/Riyadh' });
}
test.beforeEach(async ({ page }) => english(page));

test('portal catalog + PDF → project approval → staff approval → warehouse delivery and sound return', async ({ page }, info) => {
  const tp = en.portal; const tr = en.requests;
  await chooseRole(page, 'portal_requester');
  await page.goto('/client-portal/requests/new');
  await selectField(page, tp.itemCategory, id(4, 1));
  await selectField(page, tp.itemBrand, id(2, 1));
  await selectField(page, tp.itemModel, id(9, 1));
  await page.getByLabel(exactFieldLabel(tp.itemQuantity)).fill('1');
  await page.getByRole('button', { name: tp.addItem, exact: true }).click();
  await page.getByRole('button', { name: tp.nextStep, exact: true }).click();
  const project = 'DEMO UI catalog lifecycle';
  await page.locator('#portal-project_name').fill(project);
  await page.locator('#portal-city').fill('Riyadh');
  await page.getByRole('button', { name: tp.nextStep, exact: true }).click();
  await page.locator('#portal-pickup_date').fill(futureDate(2));
  await page.locator('#portal-return_date').fill(futureDate(7));
  await page.getByRole('button', { name: tp.nextStep, exact: true }).click();
  await page.locator('input[type=file]').setInputFiles({ name: 'demo-order.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4\nDEMO synthetic order\n%%EOF') });
  await page.getByRole('button', { name: tp.submit, exact: true }).click();
  await expect(page).toHaveURL(/\/client-portal\/requests\/[0-9a-f-]{36}$/);
  const requestId = new URL(page.url()).pathname.split('/').at(-1)!;
  let state = await persistedSnapshot(page);
  expect(state.tables.requests.find((r) => r.id === requestId)).toMatchObject({ project_name: project, status: 'draft', portal_approval_status: 'pending_project_manager' });
  const uploaded = state.tables.request_attachments.filter((r) => r.request_id === requestId);
  expect(uploaded).toHaveLength(1);
  expect(uploaded[0]).toMatchObject({ file_name: 'demo-order.pdf', scan_status: 'pending' });
  await chooseRole(page, 'portal_project_manager');
  await page.goto(`/client-portal/requests/${requestId}`);
  await page.getByRole('button', { name: tp.pmApprove, exact: true }).click();
  await committed(page, 'requests', requestId, 'portal_approval_status', 'approved_by_project_manager');
  await chooseRole(page, 'it_manager');
  await page.goto(`/requests/${requestId}`);
  await page.getByRole('button', { name: tr.approve, exact: true }).click();
  await committed(page, 'requests', requestId, 'status', 'approved');
  await chooseRole(page, 'warehouse_manager');
  await page.goto(`/requests/${requestId}`);
  await page.getByRole('button', { name: tr.selectDevice, exact: true }).first().click();
  const allocation = (await persistedSnapshot(page)).tables.assets.find(asset => asset.status === 'available' && asset.category_id === id(4, 1) && asset.model_id === id(9, 1))!;
  expect(allocation).toBeDefined();
  await dialog(page).locator('select').selectOption(String(allocation.id));
  await dialog(page).getByRole('button', { name: tr.selectDevice, exact: true }).click();
  await expect(dialog(page)).toHaveCount(0);
  await page.getByRole('button', { name: tr.markReady, exact: true }).click();
  await committed(page, 'requests', requestId, 'status', 'ready_for_pickup');
  await page.getByRole('button', { name: tr.deliver, exact: true }).click();
  await dialog(page).getByLabel(exactFieldLabel(tr.recipientPersonName)).fill('Synthetic recipient');
  await dialog(page).getByRole('checkbox').check();
  await dialog(page).getByRole('button', { name: tr.confirmDelivery, exact: true }).click();
  await committed(page, 'requests', requestId, 'status', 'delivered');
  await page.getByRole('button', { name: tr.inspectAndReturn, exact: true }).click();
  await dialog(page).getByRole('textbox', { name: tr.returnScanLabel, exact: true }).fill(String(allocation.asset_tag));
  await dialog(page).getByRole('button', { name: tr.returnVerify, exact: true }).click();
  await dialog(page).getByRole('combobox', { name: tr.returnCondition, exact: true }).selectOption('sound');
  await dialog(page).getByRole('button', { name: tr.inspectSubmit, exact: true }).click();
  await committed(page, 'requests', requestId, 'status', 'returned');
  await page.reload();
  await expect(page.getByText(en.requestStatus.returned, { exact: true }).first()).toBeVisible();
  state = await persistedSnapshot(page);
  expect(state.tables.assets.find((r) => r.id === allocation.id)).toMatchObject({ status: 'available' });
  expect(state.tables.request_delivery_proofs.filter((r) => r.request_id === requestId)).toHaveLength(1);
  await proveUiActions(info, ['src/app/(app)/requests/[id]/page.tsx::load#1', 'src/app/(app)/requests/[id]/page.tsx::run#1', 'src/app/(app)/requests/[id]/page.tsx::submitDelivery#1', 'src/app/(app)/requests/[id]/page.tsx::submitInspect#1'], { requestId, status: 'returned', attachmentCount: 1, attachmentScanStatus: 'pending', deliveryProofCount: 1 });
});

test('consumable supply and issue buttons persist two balanced ledger movements', async ({ page }, info) => {
  await chooseRole(page, 'it_manager');
  await page.goto(`/consumables/${id(14, 3)}`);
  const before = await persistedSnapshot(page);
  const quantity = Number(before.tables.consumables.find((r) => r.id === id(14, 3))!.quantity_on_hand);
  await page.getByRole('button', { name: en.consumables.supply, exact: true }).click();
  await dialog(page).getByLabel(exactFieldLabel(en.consumables.replenish.quantity)).fill('3');
  await dialog(page).locator('input[type=file]').setInputFiles({ name: 'demo-invoice.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4\nDEMO invoice\n%%EOF') });
  await dialog(page).getByRole('button', { name: en.consumables.replenish.save, exact: true }).click();
  await committed(page, 'consumables', id(14, 3), 'quantity_on_hand', quantity + 3);
  await page.getByRole('button', { name: en.consumables.issue, exact: true }).click();
  await dialog(page).getByLabel(exactFieldLabel(en.consumables.issueForm.quantity)).fill('2');
  await dialog(page).getByLabel(exactFieldLabel(en.consumables.issueForm.reason)).fill('DEMO UI team supply');
  await dialog(page).getByRole('button', { name: en.consumables.issueForm.save, exact: true }).click();
  await committed(page, 'consumables', id(14, 3), 'quantity_on_hand', quantity + 1);
  await page.reload();
  const after = await persistedSnapshot(page);
  expect(after.tables.consumable_transactions.length - before.tables.consumable_transactions.length).toBe(2);
  expect(after.tables.consumable_transactions.filter((r) => r.consumable_id === id(14, 3)).slice(-2).map((r) => r.txn_type)).toEqual(['in', 'out']);
  expect(after.tables.attachments.filter(row => row.entity_type === 'consumable' && row.entity_id === id(14, 3) && row.kind === 'replenishment_invoice')).toHaveLength(1);
  await proveUiActions(info, ['src/components/consumables/consumable-dialogs.tsx::submit#1', 'src/components/consumables/consumable-dialogs.tsx::submit#2'], { quantityBefore: quantity, quantityAfter: quantity + 1, ledgerDelta: 2, invoice: true });
});

test('blind partial stocktake scans actual fixture tags and receives an independent manager review', async ({ page }, info) => {
  test.setTimeout(180_000);
  await chooseRole(page, 'warehouse_manager');
  const before = await persistedSnapshot(page);
  const tags = before.tables.assets.filter((r) => r.location_id === id(5, 1) && r.category_id === id(4, 5) && !r.archived_at).map((r) => String(r.asset_tag));
  expect(tags.length).toBeGreaterThan(0);
  await page.goto('/stocktakes');
  await page.getByRole('button', { name: en.stocktakes.startNew, exact: true }).click();
  await dialog(page).getByRole('button', { name: new RegExp(en.stocktakes.fieldCount) }).click();
  const scopeDialog = page.getByRole('dialog', { name: en.stocktakes.fieldCount, exact: true });
  await scopeDialog.getByRole('combobox', { name: en.stocktakes.partialInventory, exact: true }).selectOption(id(4, 5));
  await scopeDialog.getByRole('button', { name: en.stocktakes.start, exact: true }).click();
  await expect(page.locator('#stocktake-scan')).toBeVisible();
  const active = (await persistedSnapshot(page)).tables.stocktakes.find((r) => !before.tables.stocktakes.some((old) => old.id === r.id))!;
  expect(active).toBeDefined();
  for (const tag of tags) {
    await page.locator('#stocktake-scan').fill(tag);
    await page.getByRole('button', { name: en.stocktakes.scan, exact: true }).click();
    await expect(page.locator('#stocktake-scan')).toHaveValue('');
  }
  await page.getByRole('button', { name: en.stocktakes.submit, exact: true }).click();
  await committed(page, 'stocktakes', String(active.id), 'review_state', 'submitted');
  await chooseRole(page, 'it_manager');
  await page.goto('/stocktakes');
  await page.getByRole('row').filter({ hasText: String(active.code) }).getByRole('button', { name: en.activity.viewDetails, exact: true }).click();
  await page.getByRole('button', { name: en.stocktakes.applyAndComplete, exact: true }).click();
  await committed(page, 'stocktakes', String(active.id), 'status', 'completed');
  await page.reload();
  await page.getByRole('row').filter({ hasText: String(active.code) }).getByRole('button', { name: en.activity.viewDetails, exact: true }).click();
  await expect(page.getByRole('button', { name: en.stocktakes.printPhysicalReport, exact: true })).toBeVisible();
  expect((await persistedSnapshot(page)).tables.stocktakes.find((r) => r.id === active.id)).toMatchObject({ observed_count: tags.length, variance_count: 0 });
  const exportDownload = page.waitForEvent('download');
  await page.getByRole('button', { name: en.stocktakes.export, exact: true }).click();
  const stocktakeCsv = await exportDownload;
  expect(stocktakeCsv.suggestedFilename()).toContain(String(active.code));
  const stocktakeBody = await downloadCsv(stocktakeCsv);
  for (const tag of tags) expect(stocktakeBody).toContain(tag);
  await proveUiActions(info, ['src/app/(app)/stocktakes/page.tsx::run#1', 'src/app/(app)/stocktakes/page.tsx::exportRows#1'], { status: 'completed', observed: tags.length, variance: 0, exported: true });
});

test('maintenance create, technician assignment and evidence-based closure persist after reload', async ({ page }, info) => {
  const assetId = id(11, 22); const problem = 'DEMO UI keyboard repair';
  // The source defaults IT manager to exposure 50, while maintenance write controls require 60.
  // Configure the real display policy as admin; retain every authorization permission unchanged.
  await chooseRole(page, 'admin');
  const authorization = await persistedSnapshot(page);
  await page.goto('/settings');
  await page.locator('#settings-tab-featureRollout').click();
  await page.getByRole('button', { name: /^80%/ }).click();
  await page.getByRole('button', { name: en.settings.featureRollout.save, exact: true }).first().click();
  await committed(page, 'feature_exposure_settings', 'main', 'level', 80);
  const configured = await persistedSnapshot(page);
  expect(configured.tables.role_permissions).toEqual(authorization.tables.role_permissions);
  expect(configured.tables.user_permissions).toEqual(authorization.tables.user_permissions);
  await chooseRole(page, 'it_manager');
  await page.goto(`/assets/${assetId}`);
  await page.getByRole('button', { name: en.assetDetail.maintenance, exact: true }).click();
  await dialog(page).getByLabel(exactFieldLabel(en.maintenance.dialog.problem)).fill(problem);
  await dialog(page).getByRole('button', { name: en.maintenance.dialog.save, exact: true }).click();
  await expect(dialog(page)).toHaveCount(0);
  const record = (await persistedSnapshot(page)).tables.maintenance_records.find((row) => row.problem_description === problem)!;
  expect(record).toBeDefined();
  await committed(page, 'assets', assetId, 'status', 'in_maintenance');
  await chooseRole(page, 'technician');
  expect(String(record.id)).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
  await page.goto(`/maintenance?m=${record.id}`);
  const assetTag = String(configured.tables.assets.find((row) => row.id === assetId)!.asset_tag);
  const manage = page.getByRole('dialog', { name: assetTag, exact: true });
  await expect(manage).toBeVisible();
  await expect(manage).toContainText(problem);
  await manage.getByRole('button', { name: en.maintenance.modal.assignToMe, exact: true }).click();
  await committed(page, 'maintenance_records', String(record.id), 'technician_id', id(1, 9));
  await page.reload();
  await expect(manage).toBeVisible();
  await manage.locator('summary').filter({ hasText: en.maintenance.modal.sections.uploadEvidence }).click();
  await manage.locator('input[type=file]').first().setInputFiles({ name: 'demo-repair.png', mimeType: 'image/png', buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==', 'base64') });
  await expect.poll(async () => (await persistedSnapshot(page)).tables.attachments.filter(row => row.entity_type === 'maintenance' && row.entity_id === record.id).length).toBe(1);
  await manage.locator('summary').filter({ hasText: en.maintenance.modal.sections.timeAndParts }).click();
  await manage.getByLabel(exactFieldLabel(en.maintenance.modal.advanced.start)).fill('2026-10-11T09:00');
  await manage.getByLabel(exactFieldLabel(en.maintenance.modal.advanced.end)).fill('2026-10-11T09:30');
  await manage.getByRole('button', { name: en.maintenance.modal.advanced.addTime, exact: true }).click();
  await expect.poll(async () => (await persistedSnapshot(page)).tables.maintenance_time_entries.filter(row => row.maintenance_id === record.id).length).toBe(1);
  const mapValue = 'https://maps.google.com/?q=synthetic-demo-location';
  await manage.locator('summary').filter({ hasText: en.maintenance.modal.sections.optionalVendor }).click();
  await manage.getByLabel(exactFieldLabel(en.maintenance.vendor.mapLink)).fill(mapValue);
  await manage.getByRole('button', { name: en.maintenance.modal.saveUpdate, exact: true }).click();
  await committed(page, 'maintenance_records', String(record.id), 'vendor_map_link', mapValue);
  await page.reload();
  await expect(manage).toBeVisible();
  await manage.locator('summary').filter({ hasText: en.maintenance.vendor.section }).click();
  const openMap = manage.getByRole('link', { name: en.maintenance.vendor.openMap, exact: true });
  expect(new URL((await openMap.getAttribute('href'))!, page.url()).origin).toBe(new URL(page.url()).origin);
  const localPageCount = page.context().pages().length;
  await openMap.click();
  await expect(page.locator('[data-demo-local-navigation-notice]')).toContainText(demoCopy.en.externalNavigation);
  expect(page.context().pages()).toHaveLength(localPageCount);
  await page.getByRole('button', { name: demoCopy.en.dismiss, exact: true }).click();
  await selectField(manage, en.maintenance.modal.form.stage, 'completed');
  const advanced = en.maintenance.modal.advanced;
  await manage.getByLabel(exactFieldLabel(advanced.diagnosis)).fill('Synthetic keyboard contact issue');
  await manage.getByLabel(exactFieldLabel(advanced.causeCode)).fill('DEMO-CONTACT');
  await manage.getByLabel(exactFieldLabel(advanced.resolutionCode)).fill('DEMO-RESEAT');
  for (const label of [advanced.safetyChecked, advanced.functionChecked, advanced.dataChecked, advanced.functionalPassed]) await manage.getByRole('checkbox', { name: label, exact: true }).check();
  await manage.getByRole('button', { name: en.maintenance.modal.saveUpdate, exact: true }).click();
  await committed(page, 'maintenance_records', String(record.id), 'status', 'completed');
  await page.goto(`/assets/${assetId}`);
  await committed(page, 'assets', assetId, 'status', 'available');
  await proveUiActions(info, ['src/components/assets/asset-detail-dialogs.tsx::submit#4', 'src/components/maintenance-modal.tsx::submit#1', 'src/components/maintenance-modal.tsx::uploadFile#1', 'src/components/maintenance-modal.tsx::refreshExtras#1'], { maintenanceId: record.id, technicianId: id(1, 9), status: 'completed', assetStatus: 'available', displayLevel: 80, authorizationUnchanged: true, externalMapPersistedLocally: true, externalNavigationDenied: true });
});

test('mapped CSV blocks fatal errors, then imports a corrected valid file with current catalog template', async ({ page }, info) => {
  await chooseRole(page, 'it_manager');
  await page.goto('/assets/import');
  const before = await persistedSnapshot(page);
  const templatePromise = page.waitForEvent('download');
  await page.getByRole('button', { name: en.import.downloadTemplate, exact: true }).click();
  const template = await templatePromise;
  expect(template.suggestedFilename()).toMatch(/\.csv$/);
  const templateCsv = await downloadCsv(template);
  expect(templateCsv).toContain('serial_number');
  const templateRows = parseCsv(templateCsv);
  const exampleRows = templateRows.slice(1).filter((row) => row.some(Boolean));
  expect(exampleRows).toHaveLength(2);
  for (const row of exampleRows) {
    expect(before.tables.categories.some((entry) => entry.name === row[2] && entry.kind === row[0])).toBe(true);
    expect(before.tables.companies.some((entry) => entry.name === row[3] && entry.is_active)).toBe(true);
    expect(before.tables.suppliers.some((entry) => entry.name === row[4] && entry.is_active)).toBe(true);
    expect(before.tables.locations.some((entry) => entry.name === row[5])).toBe(true);
  }
  const name = 'DEMO UI mapped asset';
  const headers = ['Type label', 'Asset label', 'Group label', 'Maker label', 'Site label', 'Tracking label'];
  const csv = [headers, ['asset', name, 'Laptop', 'Dell', 'المستودع الرئيسي', 'DEMO-MAPPED-SN'], ['asset', 'DEMO invalid missing serial', 'Laptop', 'Dell', 'المستودع الرئيسي', '']].map((row) => row.join(',')).join('\n');
  await expect(page.locator('input[type=file]')).toBeEnabled();
  await page.locator('input[type=file]').setInputFiles({ name: 'demo-mapped.csv', mimeType: 'text/csv', buffer: Buffer.from(csv) });
  const fields = ['item_type', 'name', 'category', 'company', 'location', 'serial_number'];
  for (const [index, header] of headers.entries()) {
    await page.getByRole('combobox', { name: en.importTools.mapColumn.replace('{column}', header), exact: true }).selectOption(fields[index]);
  }
  const errorsPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: en.import.downloadErrors, exact: true }).click();
  const errors = await errorsPromise;
  expect(errors.suggestedFilename()).toMatch(/\.csv$/);
  expect(await downloadCsv(errors)).toContain('DEMO invalid missing serial');
  await expect(page.getByRole('button', { name: en.import.confirm.replace('{n}', '1'), exact: true })).toHaveCount(0);
  expect((await persistedSnapshot(page)).tables.assets).toEqual(before.tables.assets);
  await page.getByRole('button', { name: en.import.back, exact: true }).click();
  await expect(page.locator('input[type=file]')).toBeEnabled();
  const corrected = [headers, ['asset', name, 'Laptop', 'Dell', 'المستودع الرئيسي', 'DEMO-MAPPED-SN']].map((row) => row.join(',')).join('\n');
  await page.locator('input[type=file]').setInputFiles({ name: 'demo-mapped-corrected.csv', mimeType: 'text/csv', buffer: Buffer.from(corrected) });
  for (const [index, header] of headers.entries()) {
    await page.getByRole('combobox', { name: en.importTools.mapColumn.replace('{column}', header), exact: true }).selectOption(fields[index]);
  }
  await page.getByRole('button', { name: en.import.confirm.replace('{n}', '1'), exact: true }).click();
  await expect.poll(async () => (await persistedSnapshot(page)).tables.assets.filter((row) => row.name === name).length).toBe(1);
  const after = await persistedSnapshot(page);
  expect(after.tables.assets.length).toBe(before.tables.assets.length + 1);
  expect(after.tables.assets.some((row) => row.name === 'DEMO invalid missing serial')).toBe(false);
  await page.getByRole('button', { name: en.import.importAnother, exact: true }).click();
  await expect(page.locator('input[type=file]')).toBeEnabled();
  await page.goto('/assets');
  await page.getByRole('searchbox', { name: en.assets.searchPlaceholder, exact: true }).fill(name);
  await expect(page.getByRole('link', { name, exact: false }).first()).toBeVisible();
  await proveUiActions(info, ['src/app/(app)/assets/import/page.tsx::downloadTemplate#1', 'src/app/(app)/assets/import/page.tsx::downloadErrors#1', 'src/app/(app)/assets/import/page.tsx::confirm#1', 'src/app/(app)/assets/import/page.tsx::reset#1'], { fatalErrorsBlockWholeFile: true, correctedValidRowsCommitted: 1, invalidRowsCommitted: 0, csvDownloads: 2, reset: true });
});

test('report CSV and selected-only QR preview operate through the actual UI', async ({ page }, info) => {
  await chooseRole(page, 'it_manager');
  await page.goto('/reports?tab=inventory');
  await expect(page.locator('#reports-tab-inventory')).toHaveAttribute('aria-selected', 'true');
  const csvPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: en.reports.exportInventory, exact: true }).click();
  const inventoryDownload = await csvPromise;
  expect(inventoryDownload.suggestedFilename()).toMatch(/\.csv$/);
  expect((await downloadCsv(inventoryDownload)).trim().split(/\r?\n/).length).toBeGreaterThan(1);
  await page.goto('/assets');
  const assetRows = page.locator('tbody tr').filter({ has: page.locator('a[href^="/assets/"]') });
  const checkboxes = assetRows.locator('input[type=checkbox]');
  await expect(checkboxes.first()).toBeVisible();
  const tags = await Promise.all([0, 1].map(async (index) => (await checkboxes.nth(index).getAttribute('aria-label'))!.replace(en.assets.listUx.selectRow.replace('{tag}', ''), '')));
  await checkboxes.nth(0).check();
  await checkboxes.nth(1).check();
  await page.getByRole('button', { name: en.assets.listUx.printSelected.replace('{count}', '2'), exact: true }).click();
  const preview = page.getByRole('dialog', { name: en.assets.listUx.printTitle, exact: true });
  await expect(preview).toBeVisible();
  await expect(preview.locator('article[data-asset-label] svg')).toHaveCount(2);
  for (const tag of tags) await expect(preview.getByText(tag, { exact: true })).toBeVisible();
  await preview.getByRole('button', { name: en.common.close, exact: true }).click();
  await expect(preview).toHaveCount(0);
  const selectedCsv = page.waitForEvent('download');
  await page.getByRole('button', { name: en.assets.listUx.exportSelected, exact: true }).click();
  const selectedDownload = await selectedCsv;
  expect(selectedDownload.suggestedFilename()).toMatch(/\.csv$/);
  const selectedBody = await downloadCsv(selectedDownload);
  expect(selectedBody.trim().split(/\r?\n/)).toHaveLength(3);
  for (const tag of tags) expect(selectedBody).toContain(tag);
  await page.getByRole('button', { name: en.assets.listUx.clearSelection, exact: true }).click();
  const viewCsv = page.waitForEvent('download');
  await page.goto('/assets?type=assets&view=maintenance_attention');
  await page.getByRole('button', { name: en.workQueue.csv, exact: true }).click();
  const viewDownload = await viewCsv;
  expect(viewDownload.suggestedFilename()).toMatch(/\.csv$/);
  expect((await downloadCsv(viewDownload)).trim().length).toBeGreaterThan(0);
  await proveUiActions(info, ['src/app/(app)/reports/page-client.tsx::exportInventory#1', 'src/app/(app)/assets/page-client.tsx::loadInventory#1', 'src/app/(app)/assets/page-client.tsx::exportSelected#1', 'src/app/(app)/assets/page-client.tsx::exportView#1'], { qrLabels: tags, selectedCount: 2, selectedCsv: true, filteredViewCsv: true });
});

test('seeded purchase draft uses independent approval/order actors and goods receipt leaves inventory unchanged', async ({ page }, info) => {
  const tp = en.purchaseRequests;
  await chooseRole(page, 'it_manager');
  const before = await persistedSnapshot(page);
  const created = before.tables.purchase_requests.find(row => row.status === 'draft')!;
  expect(created).toMatchObject({ status: 'draft', requested_by: id(1, 1) });
  const item = before.tables.purchase_request_items.find(row => row.purchase_request_id === created.id)!;
  expect(item).toBeDefined();
  async function openPurchase() {
    await page.goto('/purchase-requests');
    await page.getByRole('button', { name: String(created.request_number), exact: true }).click();
    return page.locator(`#purchase-details-${created.id}`);
  }
  let detail = await openPurchase();
  await detail.getByRole('button', { name: tp.actions.submit, exact: true }).click();
  await committed(page, 'purchase_requests', String(created.id), 'status', 'submitted');
  await chooseRole(page, 'admin');
  detail = await openPurchase();
  await detail.getByRole('button', { name: tp.actions.approve, exact: true }).click();
  await committed(page, 'purchase_requests', String(created.id), 'approved_by', id(1, 8));
  // The real admin dialog grants a separate local actor the current manager role.
  await page.goto('/settings');
  await page.locator('#settings-tab-users').click();
  await page.getByRole('row').filter({ hasText: 'viewer@demo.invalid' }).getByRole('button', { name: en.usersAdmin.changeRole, exact: true }).click();
  await dialog(page).locator('select').selectOption('it_manager');
  await dialog(page).getByRole('button', { name: en.usersAdmin.confirmChangeRole, exact: true }).click();
  await committed(page, 'app_users', id(1, 4), 'role_key', 'it_manager');
  await chooseRole(page, 'viewer');
  detail = await openPurchase();
  await detail.getByRole('button', { name: tp.actions.secondApprove, exact: true }).click();
  await committed(page, 'purchase_requests', String(created.id), 'second_approved_by', id(1, 4));
  // Only manager roles may enter this source route; grant the fourth independent
  // actor that role through the same real admin control before ordering/receiving.
  await chooseRole(page, 'admin');
  await page.goto('/settings');
  await page.locator('#settings-tab-users').click();
  await page.getByRole('row').filter({ hasText: 'technician@demo.invalid' }).getByRole('button', { name: en.usersAdmin.changeRole, exact: true }).click();
  await dialog(page).locator('select').selectOption('it_manager');
  await dialog(page).getByRole('button', { name: en.usersAdmin.confirmChangeRole, exact: true }).click();
  await committed(page, 'app_users', id(1, 9), 'role_key', 'it_manager');
  await chooseRole(page, 'technician');
  detail = await openPurchase();
  await detail.getByRole('button', { name: tp.actions.markOrdered, exact: true }).click();
  await committed(page, 'purchase_requests', String(created.id), 'status', 'ordered');
  await detail.getByRole('textbox', { name: `${tp.qtyPlaceholder} — ${item.description}`, exact: true }).fill(String(item.requested_quantity));
  await detail.getByRole('button', { name: tp.receiveBtn, exact: true }).click();
  await committed(page, 'purchase_requests', String(created.id), 'status', 'received');
  await page.reload();
  const after = await persistedSnapshot(page);
  expect(after.tables.assets).toEqual(before.tables.assets);
  expect(after.tables.consumables).toEqual(before.tables.consumables);
  expect(after.tables.consumable_transactions).toEqual(before.tables.consumable_transactions);
  detail = await openPurchase();
  const purchaseCsv = page.waitForEvent('download');
  await detail.getByRole('button', { name: tp.exportCsv, exact: true }).click();
  const purchaseDownload = await purchaseCsv;
  expect(purchaseDownload.suggestedFilename()).toMatch(/\.csv$/);
  expect((await downloadCsv(purchaseDownload)).trim().split(/\r?\n/).length).toBeGreaterThan(1);
  await proveUiActions(info, ['src/app/(app)/purchase-requests/page.tsx::load#1', 'src/app/(app)/purchase-requests/page.tsx::loadItems#1', 'src/app/(app)/purchase-requests/page.tsx::toggleOpen#1', 'src/app/(app)/purchase-requests/page.tsx::changeStatus#1', 'src/app/(app)/purchase-requests/page.tsx::receive#1', 'src/app/(app)/purchase-requests/page.tsx::exportPr#1', 'src/components/settings/users-settings.tsx::submit#1'], { purchaseId: created.id, status: 'received', inventoryUnchanged: true, separateActors: true, exported: true });
});
