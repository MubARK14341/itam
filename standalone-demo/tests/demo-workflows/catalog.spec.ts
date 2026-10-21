import type { Page, Locator } from '@playwright/test';
import { test, expect, chooseRole, persistedSnapshot, id, proveUiActions } from '../demo-browser/helpers';
import { getDict } from '../../src/studio/lib/i18n';
import { exactFieldLabel, labeledSelect } from './fields';
const en = getDict('en');
const png = { name: 'demo-device.png', mimeType: 'image/png', buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==', 'base64') };
const pdf = { name: 'demo-document.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4\nDEMO synthetic document\n%%EOF') };
const dialog = (page: Page) => page.getByRole('dialog');
async function choose(scope: Page | Locator, label: string, value: string) { await labeledSelect(scope, label).selectOption(value); }
async function value(page: Page, table: string, target: string, key: string, expected: unknown) { await expect.poll(async () => (await persistedSnapshot(page)).tables[table]?.find(r => r.id === target)?.[key]).toEqual(expected); }
test.beforeEach(async ({ page }) => { await page.goto('/login'); await page.getByRole('button', { name: 'EN', exact: true }).click(); });

test('actual asset form, custody dialogs, move-created location, edit, state and document slots persist', async ({ page }, info) => {
  await chooseRole(page, 'it_manager');
  await page.goto('/assets/new');
  const af = en.assetForm; const ad = en.assetDialogs;
  await page.getByLabel(exactFieldLabel(af.fields.descriptiveName)).fill('DEMO UI asset lifecycle');
  await page.getByLabel(exactFieldLabel(af.fields.serial)).fill('DEMO-UI-ASSET-SERIAL');
  await choose(page, af.fields.category, id(4, 1));
  await choose(page, af.fields.company, id(2, 1));
  await choose(page, af.fields.location, id(5, 1));
  await page.getByRole('button', { name: af.save, exact: true }).click();
  await expect(page).toHaveURL(/\/assets\/[a-f0-9-]{36}$/);
  const assetId = new URL(page.url()).pathname.split('/').at(-1)!;
  await value(page, 'assets', assetId, 'name', 'DEMO UI asset lifecycle');
  await page.getByRole('button', { name: en.assetDetail.assign, exact: true }).click();
  await choose(dialog(page), ad.employee, id(8, 2));
  await dialog(page).getByRole('button', { name: ad.assignBtn, exact: true }).click();
  await value(page, 'assets', assetId, 'assigned_to_employee_id', id(8, 2));
  await page.getByRole('button', { name: en.assetDetail.return, exact: true }).click();
  await choose(dialog(page), ad.conditionOnReturn, 'good');
  await dialog(page).getByRole('button', { name: ad.returnBtn, exact: true }).click();
  await value(page, 'assets', assetId, 'assigned_to_employee_id', null);
  await page.getByRole('button', { name: en.assetDetail.move, exact: true }).click();
  const move = page.getByRole('dialog', { name: ad.moveTitle, exact: true });
  await choose(move, ad.newLocation, '__add_new__');
  const addLocation = page.getByRole('dialog', { name: af.addLocation, exact: true });
  await addLocation.getByLabel(exactFieldLabel(af.locationName)).fill('DEMO UI created location');
  await addLocation.getByRole('button', { name: en.common.save, exact: true }).click();
  await expect(addLocation).toHaveCount(0);
  const location = (await persistedSnapshot(page)).tables.locations.find(r => r.name === 'DEMO UI created location')!;
  expect(location).toBeDefined();
  await move.getByRole('button', { name: ad.moveBtn, exact: true }).click();
  await value(page, 'assets', assetId, 'location_id', location.id);
  await page.getByRole('button', { name: en.assetDetail.editData, exact: true }).click();
  await dialog(page).getByLabel(exactFieldLabel(af.fields.name)).fill('DEMO UI asset edited');
  await dialog(page).getByRole('button', { name: af.saveEdit, exact: true }).click();
  await value(page, 'assets', assetId, 'name', 'DEMO UI asset edited');
  await page.getByRole('button', { name: en.assetDetail.changeStatus, exact: true }).click();
  await choose(dialog(page), ad.newStatus, 'in_maintenance');
  await dialog(page).getByRole('button', { name: ad.changeBtn, exact: true }).click();
  await value(page, 'assets', assetId, 'status', 'in_maintenance');
  await page.getByRole('button', { name: en.assetDetail.changeStatus, exact: true }).click();
  await choose(dialog(page), ad.newStatus, 'available');
  await dialog(page).getByRole('button', { name: ad.changeBtn, exact: true }).click();
  await value(page, 'assets', assetId, 'status', 'available');
  await page.locator('#asset-sections-tab-documents').click();
  const files = page.locator('input[type=file]');
  await expect(files).toHaveCount(4);
  for (const [index, kind] of ['asset_photo', 'warranty_invoice', 'purchase_invoice', 'other'].entries()) {
    await files.nth(index).setInputFiles(index === 0 ? png : { ...pdf, name: `demo-${kind}.pdf` });
    await expect.poll(async () => (await persistedSnapshot(page)).tables.attachments.filter(r => r.entity_type === 'asset' && r.entity_id === assetId && r.kind === kind).length).toBe(1);
    expect((await persistedSnapshot(page)).tables.attachments.find(r => r.entity_type === 'asset' && r.entity_id === assetId && r.kind === kind)?.scan_status).toBe('pending');
  }
  await page.reload();
  await page.locator('#asset-sections-tab-documents').click();
  await expect(page.getByText('demo-other.pdf', { exact: true })).toBeVisible();
  const final = await persistedSnapshot(page);
  expect(final.tables.assets.find(r => r.id === assetId)).toMatchObject({ name: 'DEMO UI asset edited', status: 'available', location_id: location.id, assigned_to_employee_id: null });
  expect(final.tables.asset_assignments.filter(r => r.asset_id === assetId)).toHaveLength(1);
  await proveUiActions(info, [
    'src/app/(app)/assets/[id]/page.tsx::refresh#1',
    ...[1, 2, 3, 5, 6].map(n => `src/components/assets/asset-detail-dialogs.tsx::submit#${n}`),
    'src/components/assets/asset-documents.tsx::upload#1', 'src/components/assets/asset-detail-sections.tsx::upload#1',
    'src/components/ui/creatable-select.tsx::handleChange#1', 'src/components/ui/creatable-select.tsx::submit#1',
  ], { assetId, custodyReturned: true, movedToCreatedLocation: true, edited: true, stateTransitions: 2, attachmentKinds: 4 });
});

test('full and quick consumable create, edit, document and ledger export work with stock unchanged by edits', async ({ page }, info) => {
  const cf = en.consumables.form;
  await chooseRole(page, 'it_manager');
  await page.goto('/assets/new');
  await page.getByRole('button', { name: en.assetForm.typeConsumable, exact: true }).click();
  await choose(page, cf.category, id(4, 6));
  await page.getByLabel(exactFieldLabel(cf.name)).fill('DEMO UI full consumable');
  await page.getByLabel(exactFieldLabel(cf.quantity)).fill('12');
  await choose(page, cf.company, id(2, 1));
  await choose(page, cf.location, id(5, 1));
  await page.locator('input[type=file]').setInputFiles(png);
  await page.getByRole('button', { name: en.assetForm.saveConsumable, exact: true }).click();
  await expect(page).toHaveURL(/\/consumables\/[a-f0-9-]{36}$/);
  const target = new URL(page.url()).pathname.split('/').at(-1)!;
  await value(page, 'consumables', target, 'quantity_on_hand', 12);
  await page.getByRole('button', { name: en.common.edit, exact: true }).click();
  await dialog(page).getByLabel(exactFieldLabel(cf.name)).fill('DEMO UI full consumable edited');
  await dialog(page).getByLabel(exactFieldLabel(cf.reorderLevel)).fill('5');
  await dialog(page).getByRole('button', { name: en.common.save, exact: true }).click();
  await value(page, 'consumables', target, 'name', 'DEMO UI full consumable edited');
  await page.locator('#att-title').locator('..').locator('input[type=file]').setInputFiles(pdf);
  await expect.poll(async () => (await persistedSnapshot(page)).tables.attachments.filter(r => r.entity_type === 'consumable' && r.entity_id === target).length).toBe(2);
  const ledger = page.waitForEvent('download');
  await page.getByRole('button', { name: en.consumables.ledgerUx.exportLedger, exact: true }).click();
  expect((await ledger).suggestedFilename()).toMatch(/\.csv$/);
  await page.goto('/consumables');
  await page.getByRole('button', { name: en.consumables.add, exact: true }).first().click();
  const quick = page.getByRole('dialog', { name: cf.addTitle, exact: true });
  await choose(quick, cf.category, id(4, 6));
  await quick.getByLabel(exactFieldLabel(cf.name)).fill('DEMO UI quick consumable');
  await quick.getByLabel(exactFieldLabel(cf.quantity)).fill('7');
  await quick.getByRole('button', { name: en.common.save, exact: true }).click();
  await expect(quick).toHaveCount(0);
  const state = await persistedSnapshot(page);
  expect(state.tables.consumables.find(r => r.id === target)).toMatchObject({ quantity_on_hand: 12, reorder_level: 5 });
  expect(state.tables.consumables.filter(r => r.name === 'DEMO UI quick consumable' && r.quantity_on_hand === 7)).toHaveLength(1);
  await proveUiActions(info, ['src/components/consumables/consumable-new-form.tsx::submit#1', 'src/components/consumables/consumable-dialogs.tsx::submit#3', 'src/components/consumables/consumables-panel.tsx::load#1', 'src/components/consumables/consumables-panel.tsx::submit#1', 'src/app/(app)/consumables/[id]/page.tsx::uploadAtt#1', 'src/app/(app)/consumables/[id]/page.tsx::exportLedger#1'], { fullCreated: true, quickCreated: true, editStockUnchanged: true, attachmentCount: 2, exported: true });
});
