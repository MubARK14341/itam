import type { Page } from '@playwright/test';
import { test, expect, chooseRole, persistedSnapshot, id, proveUiActions } from '../demo-browser/helpers';
import { getDict } from '../../src/studio/lib/i18n';
import { exactFieldLabel, labeledSelect } from './fields';
const en = getDict('en');
const d = (page: Page) => page.getByRole('dialog');
async function property(page: Page, table: string, target: string, key: string, expected: unknown) { await expect.poll(async () => (await persistedSnapshot(page)).tables[table]?.find(r => r.id === target)?.[key]).toEqual(expected); }
test.beforeEach(async ({ page }) => { await page.goto('/login'); await page.getByRole('button', { name: 'EN', exact: true }).click(); });

test('staff request wizard submits a complete custom need and manager rejects with a persisted reason', async ({ page }, info) => {
  const tr = en.requests;
  await chooseRole(page, 'it_manager');
  await page.goto('/requests/new');
  await labeledSelect(page, tr.customer).selectOption(id(3, 1));
  await page.getByLabel(exactFieldLabel(tr.projectName)).fill('DEMO UI custom request');
  await page.getByRole('button', { name: tr.ledger.next, exact: true }).click();
  await page.getByRole('button', { name: tr.customNeed, exact: true }).click();
  await page.getByRole('textbox', { name: tr.customNeed, exact: true }).fill('DEMO synthetic setup service');
  await page.getByRole('spinbutton', { name: tr.quantity, exact: true }).fill('1');
  await page.getByRole('button', { name: tr.addItem, exact: true }).click();
  await page.getByRole('button', { name: tr.ledger.next, exact: true }).click();
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Riyadh' });
  const later = new Date(Date.now() + 7 * 86_400_000).toLocaleDateString('en-CA', { timeZone: 'Asia/Riyadh' });
  await page.getByLabel(exactFieldLabel(tr.pickupDate)).fill(today);
  await page.getByLabel(exactFieldLabel(tr.returnDate)).fill(later);
  await page.getByRole('button', { name: tr.ledger.next, exact: true }).click();
  await page.getByRole('button', { name: tr.submit, exact: true }).click();
  await expect(page).toHaveURL(/\/requests\/[a-f0-9-]{36}$/);
  const target = new URL(page.url()).pathname.split('/').at(-1)!;
  await property(page, 'requests', target, 'status', 'under_review');
  await page.getByRole('button', { name: tr.reject, exact: true }).click();
  await d(page).getByLabel(exactFieldLabel(tr.rejectReasonLabel)).fill('DEMO UI reason: scope needs revision');
  await d(page).getByRole('button', { name: tr.confirmReject, exact: true }).click();
  await property(page, 'requests', target, 'status', 'rejected');
  await page.reload();
  expect((await persistedSnapshot(page)).tables.requests.find(r => r.id === target)).toMatchObject({ rejection_reason: 'DEMO UI reason: scope needs revision' });
  // CSV visibility requires exposure 70; admin's real source display level is 100.
  await chooseRole(page, 'admin');
  await page.goto('/requests');
  const exportPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: tr.exportCsv, exact: true }).click();
  const exported = await exportPromise;
  expect(exported.suggestedFilename()).toBe('customer_requests.csv');
  expect(await exported.failure()).toBeNull();
  const stream = await exported.createReadStream();
  expect(stream).toBeTruthy();
  const chunks: Buffer[] = [];
  for await (const chunk of stream!) chunks.push(Buffer.from(chunk));
  expect(Buffer.concat(chunks).toString('utf8')).toContain('DEMO UI custom request');
  await proveUiActions(info, ['src/app/(app)/requests/new/page.tsx::submit#1', 'src/app/(app)/requests/[id]/page.tsx::submitReject#1', 'src/app/(app)/requests/page-client.tsx::loadPage#1', 'src/app/(app)/requests/page-client.tsx::exportCsv#1'], { requestId: target, status: 'rejected', rejectionReasonPersisted: true, csv: true });
});

test('reserved device change replaces exactly one device and releases the former reservation', async ({ page }, info) => {
  await chooseRole(page, 'warehouse_manager');
  const before = await persistedSnapshot(page);
  const request = before.tables.requests.find(r => ['approved', 'provisioned', 'preparing'].includes(String(r.status)) && before.tables.request_items.some(i => i.request_id === r.id && i.asset_id && before.tables.assets.some(asset => asset.id === i.asset_id && asset.status === 'reserved'))) !;
  expect(request).toBeDefined();
  await page.goto(`/requests/${request.id}`);
  await page.getByRole('button', { name: en.requests.changeReservedDevices, exact: true }).click();
  const replacement = labeledSelect(d(page), en.requests.replacementDevice);
  await expect(replacement).toBeVisible();
  await expect.poll(() => replacement.locator('option').count()).toBeGreaterThan(1);
  const firstAvailable = await replacement.locator('option').evaluateAll(options => options.map(option => ({ value: (option as HTMLOptionElement).value, disabled: (option as HTMLOptionElement).disabled })).find(option => option.value && !option.disabled)?.value);
  expect(firstAvailable).toBeTruthy();
  const itemId = await labeledSelect(d(page), en.requests.currentReservedDevice).inputValue();
  const former = before.tables.request_items.find(r => r.id === itemId)!.asset_id;
  await replacement.selectOption(firstAvailable!);
  await d(page).getByRole('button', { name: en.requests.confirmDeviceChange, exact: true }).click();
  await property(page, 'request_items', itemId, 'asset_id', firstAvailable);
  await property(page, 'assets', String(former), 'status', 'available');
  await page.reload();
  await property(page, 'assets', firstAvailable!, 'status', 'reserved');
  await proveUiActions(info, ['src/app/(app)/requests/[id]/page.tsx::submitReservedChange#1'], { itemId, oldReleased: true, replacementReserved: true, afterReload: true });
});

test('high-value device requires independent approval and unsupported strong delivery proof stays blocked', async ({ page }, info) => {
  const tr = en.requests; const af = en.assetForm;
  await chooseRole(page, 'it_manager');
  const original = await persistedSnapshot(page);
  const request = original.tables.requests.find(r => r.status === 'ready_for_pickup' && original.tables.request_items.some(item => item.request_id === r.id && item.asset_id))!;
  expect(request).toBeDefined();
  const assetId = String(original.tables.request_items.find(item => item.request_id === request.id && item.asset_id)!.asset_id);
  await page.goto(`/assets/${assetId}`);
  await page.getByRole('button', { name: en.assetDetail.editData, exact: true }).click();
  await d(page).getByLabel(exactFieldLabel(af.fields.purchaseCost)).fill('12000');
  await d(page).getByRole('button', { name: af.saveEdit, exact: true }).click();
  await property(page, 'assets', assetId, 'purchase_cost', 12000);
  await chooseRole(page, 'admin');
  await page.goto(`/requests/${request.id}`);
  await expect(page.getByText(tr.highRiskDeliveryHint, { exact: true })).toBeVisible();
  await page.getByRole('button', { name: tr.secondaryApproval, exact: true }).click();
  await d(page).getByRole('textbox', { name: tr.secondaryApprovalReason, exact: true }).fill('DEMO independent high-value review');
  await d(page).getByRole('button', { name: tr.secondaryApproval, exact: true }).click();
  await property(page, 'requests', String(request.id), 'second_approved_by', id(1, 8));
  await chooseRole(page, 'technician');
  await page.goto(`/requests/${request.id}`);
  const beforeDelivery = await persistedSnapshot(page);
  // The source deliberately offers no simplified delivery form for high risk,
  // even after secondary approval; its server denial is verified separately.
  await expect(page.getByText(tr.highRiskDeliveryHint, { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: tr.deliver, exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: tr.confirmDelivery, exact: true })).toHaveCount(0);
  const denied = await persistedSnapshot(page);
  expect(denied.tables.requests.find(r => r.id === request.id)).toMatchObject({ status: 'ready_for_pickup', risk_level_snapshot: 'high', second_approved_by: id(1, 8), delivery_proof_id: null });
  expect(denied.tables.assets.find(r => r.id === assetId)?.status).toBe('reserved');
  expect(denied.tables.request_delivery_proofs).toEqual(beforeDelivery.tables.request_delivery_proofs);
  expect(denied.tables.consumable_transactions).toEqual(beforeDelivery.tables.consumable_transactions);
  expect(denied.tables.request_items.filter(item => item.request_id === request.id)).toEqual(beforeDelivery.tables.request_items.filter(item => item.request_id === request.id));
  await page.reload();
  await property(page, 'requests', String(request.id), 'status', 'ready_for_pickup');
  await proveUiActions(info, ['src/app/(app)/requests/[id]/page.tsx::run#1'], { requestId: request.id, secondApproval: 'independent', deliveryFormUnavailable: 'unsupported_strong_proof', stockAndProofUnchanged: true });
});

test('customer create, edit, portal allowlist and invite panel persist through actual request UI', async ({ page }, info) => {
  const tc = en.customers;
  await chooseRole(page, 'it_manager');
  await page.goto('/requests');
  await page.getByRole('button', { name: tc.manage, exact: true }).first().click();
  await d(page).getByRole('button', { name: tc.add, exact: true }).click();
  const form = page.getByRole('dialog', { name: tc.add, exact: true });
  await form.getByLabel(exactFieldLabel(tc.name)).fill('DEMO UI customer');
  await form.getByLabel(exactFieldLabel(tc.phone)).fill('0500000000');
  await form.getByRole('button', { name: tc.save, exact: true }).click();
  await expect(form).toHaveCount(0);
  const target = (await persistedSnapshot(page)).tables.customers.find(r => r.name === 'DEMO UI customer')!;
  expect(target).toBeDefined();
  const row = d(page).getByRole('row').filter({ hasText: 'DEMO UI customer' });
  await row.getByRole('button', { name: en.common.edit, exact: true }).click();
  const edit = page.getByRole('dialog', { name: tc.edit, exact: true });
  await edit.getByLabel(exactFieldLabel(tc.city)).fill('Riyadh');
  await edit.getByRole('button', { name: tc.save, exact: true }).click();
  await property(page, 'customers', String(target.id), 'city', 'Riyadh');
  await row.getByRole('button', { name: en.portal.invite.manageTitle, exact: true }).click();
  const portal = page.getByRole('dialog', { name: `${en.portal.invite.manageTitle} — DEMO UI customer`, exact: true });
  const customItems = portal.getByRole('checkbox', { name: en.portalSettings.flags.allow_custom_item_requests, exact: true });
  await expect(customItems).toBeChecked();
  await customItems.uncheck();
  await portal.getByRole('button', { name: en.portalSettings.save, exact: true }).click();
  await expect.poll(async () => (await persistedSnapshot(page)).tables.customer_portal_settings.find(r => r.customer_id === target.id)?.allow_custom_item_requests).toBe(false);
  await portal.getByRole('button', { name: en.portal.invite.generate, exact: true }).click();
  await expect.poll(async () => (await persistedSnapshot(page)).tables.customer_portal_invites.filter(r => r.customer_id === target.id).length).toBe(1);
  await proveUiActions(info, ['src/components/requests/customers-manager.tsx::load#1', 'src/components/requests/customers-manager.tsx::submit#1', 'src/components/requests/customers-manager.tsx::load#2', 'src/components/requests/portal-settings-section.tsx::saveAll#1'], { customerId: target.id, city: 'Riyadh', customItemsAllowed: false, inviteCount: 1 });
});

for (const report of [
  { tab: 'executive', label: en.reports.exportExecutive, key: 'exportExecutive' },
  { tab: 'requests', label: en.reports.requestsTab.exportRequests, key: 'exportRequests' },
  { tab: 'maintenance', label: en.reports.maintTab.exportMaintenance, key: 'exportMaintenance' },
  { tab: 'custody', label: en.reports.custodyTab.exportCustody, key: 'exportCustody' },
  { tab: 'inventory', label: en.reports.exportCategory, key: 'exportCategory' },
]) test(`actual ${report.tab} report ${report.key} exports nonempty CSV`, async ({ page }, info) => {
  await chooseRole(page, 'it_manager');
  await page.goto(`/reports?tab=${report.tab}${report.key === 'exportCategory' ? '&kind=asset' : ''}`);
  const exportButton = page.getByRole('button', { name: report.label, exact: true });
  await expect(exportButton).toBeEnabled();
  const download = page.waitForEvent('download');
  await exportButton.click();
  const result = await download;
  expect(result.suggestedFilename()).toMatch(/\.csv$/);
  expect(await result.failure()).toBeNull();
  const stream = await result.createReadStream();
  expect(stream).toBeTruthy();
  const chunks: Buffer[] = [];
  for await (const chunk of stream!) chunks.push(Buffer.from(chunk));
  const csv = Buffer.concat(chunks).toString('utf8');
  expect(csv.trim().split(/\r?\n/).length).toBeGreaterThan(1);
  await proveUiActions(info, [`src/app/(app)/reports/page-client.tsx::${report.key}#1`], { tab: report.tab, csvRows: csv.trim().split(/\r?\n/).length - 1, downloadCompleted: true });
});
