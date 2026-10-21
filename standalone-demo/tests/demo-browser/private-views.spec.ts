import { en } from '../../src/studio/lib/translations/en';
import { DEMO_PERSONAS } from '../../src/demo/data/seed';
import { test, expect, chooseRole, persistedSnapshot, id, type personas } from './helpers';

type Persona = typeof personas[number];
type SavedView = { id: string; name: string; filters: Record<string, string> };
type SavedEnvelope = { version: number; views: SavedView[] };

const cases: {
  surface: 'reports' | 'portal-requests'; path: string; owner: Persona; other: Persona;
  initial: Record<string, string>; updated: Record<string, string>; filterKeys: string[];
}[] = [
  {
    surface: 'reports', path: '/reports', owner: 'admin', other: 'it_manager',
    initial: { tab: 'inventory', kind: 'asset', status: 'available', location: id(5, 1) },
    updated: { tab: 'inventory', kind: 'consumable', status: 'reserved', location: id(5, 1) },
    filterKeys: ['tab', 'category', 'status', 'location', 'department', 'company', 'from', 'to', 'kind', 'source', 'low'],
  },
  {
    surface: 'portal-requests', path: '/client-portal/requests', owner: 'portal_requester', other: 'portal_project_manager',
    initial: { q: 'EXPO', status: 'preparing', view: 'open' },
    updated: { q: 'EXPO-004', status: 'completed', view: 'done' },
    filterKeys: ['q', 'status', 'from', 'to', 'bucket', 'view'],
  },
];

async function readEnvelope(page: Parameters<typeof chooseRole>[0], storageKey: string): Promise<SavedEnvelope | null> {
  return page.evaluate(key => {
    const value = localStorage.getItem(key);
    return value === null ? null : JSON.parse(value);
  }, storageKey);
}

function authUserId(persona: Persona) {
  const actor = DEMO_PERSONAS.find(actor => actor.id === persona);
  if (!actor) throw new Error('The source-defined demo persona must exist.');
  return actor.userId;
}

for (const scenario of cases) test(`${scenario.surface} private views save, replace, apply and delete filters only for their actor`, async ({ page }, info) => {
  await page.goto('/login');
  await page.locator('button[lang="en"]').click();
  await chooseRole(page, scenario.owner);
  const ownerId = (await persistedSnapshot(page)).actorId;
  expect(ownerId).toBe(scenario.owner);
  // The database stores a persona key; the copied component scopes views by
  // the authenticated user's UUID, as returned by the actual demo SDK.
  const storageKey = `itam.private-views.v1:${scenario.surface}:${encodeURIComponent(authUserId(scenario.owner))}`;
  const name = `QA ${scenario.surface} filters`;
  const panel = page.getByRole('region', { name: en.privateViews.title, exact: true });
  const select = panel.getByRole('combobox', { name: en.privateViews.select, exact: true });

  await page.goto(`${scenario.path}?${new URLSearchParams(scenario.initial)}`);
  await expect(panel).toBeVisible();
  await panel.getByRole('textbox', { name: en.privateViews.name, exact: true }).fill(name);
  await panel.getByRole('button', { name: en.privateViews.save, exact: true }).click();
  await expect(panel.getByRole('status')).toHaveText(en.privateViews.saved);
  const viewId = await select.inputValue();
  expect(viewId).toMatch(/^[a-f0-9-]{36}$/i);
  const initial = await readEnvelope(page, storageKey);
  expect(initial?.views).toHaveLength(1);
  expect(initial?.views[0]).toMatchObject({ id: viewId, name, filters: scenario.initial });

  // Same-name save replaces the payload while preserving one view ID.
  await page.goto(`${scenario.path}?${new URLSearchParams(scenario.updated)}`);
  await expect(panel).toBeVisible();
  await panel.getByRole('textbox', { name: en.privateViews.name, exact: true }).fill(name);
  await panel.getByRole('button', { name: en.privateViews.save, exact: true }).click();
  await expect(panel.getByRole('status')).toHaveText(en.privateViews.saved);
  const updated = await readEnvelope(page, storageKey);
  expect(updated).not.toBeNull();
  expect(Object.keys(updated!).sort()).toEqual(['version', 'views']);
  expect(updated!.version).toBe(1);
  expect(updated!.views).toHaveLength(1);
  const saved = updated!.views[0];
  expect(Object.keys(saved).sort()).toEqual(['filters', 'id', 'name']);
  expect(saved).toMatchObject({ id: viewId, name, filters: scenario.updated });
  expect(Object.keys(saved.filters).sort()).toEqual([...scenario.filterKeys].sort());
  expect(Object.values(saved.filters).every(value => typeof value === 'string')).toBe(true);

  await page.goto(scenario.path);
  await select.selectOption(viewId);
  await panel.getByRole('button', { name: en.privateViews.apply, exact: true }).click();
  await expect(panel.getByRole('status')).toHaveText(en.privateViews.applied);
  await expect.poll(() => Object.fromEntries(new URL(page.url()).searchParams)).toMatchObject(scenario.updated);
  if (scenario.surface === 'reports') {
    await expect(page.locator('#reports-tab-inventory')).toHaveAttribute('aria-selected', 'true');
  } else {
    await expect(page.getByLabel(en.portal.filters.search, { exact: true })).toHaveValue(scenario.updated.q);
    await expect(page.getByRole('group', { name: en.portal.ledger.viewLabel, exact: true })
      .getByRole('button', { name: en.portal.ledger.viewDone })).toHaveAttribute('aria-pressed', 'true');
  }
  await page.reload();
  await expect(panel).toBeVisible();
  expect(Object.fromEntries(new URL(page.url()).searchParams)).toMatchObject(scenario.updated);
  await expect(select.locator(`option[value="${viewId}"]`)).toHaveText(name);

  // An absent panel would not prove isolation: both actors use this surface.
  await page.locator('[data-demo-role-picker]').click();
  await chooseRole(page, scenario.other);
  const otherId = (await persistedSnapshot(page)).actorId;
  expect(otherId).toBe(scenario.other);
  expect(otherId).not.toBe(ownerId);
  await page.goto(scenario.path);
  await expect(panel).toBeVisible();
  await expect(select.locator(`option[value="${viewId}"]`)).toHaveCount(0);
  const otherStorageKey = `itam.private-views.v1:${scenario.surface}:${encodeURIComponent(authUserId(scenario.other))}`;
  expect(await readEnvelope(page, otherStorageKey)).toBeNull();
  expect(await readEnvelope(page, storageKey)).toEqual(updated);

  await page.locator('[data-demo-role-picker]').click();
  await chooseRole(page, scenario.owner);
  await page.goto(scenario.path);
  await select.selectOption(viewId);
  await panel.getByRole('button', { name: en.privateViews.delete, exact: true }).click();
  await expect(panel.getByRole('status')).toHaveText(en.privateViews.deleted);
  expect(await readEnvelope(page, storageKey)).toEqual({ version: 1, views: [] });
  await page.reload();
  await expect(panel).toBeVisible();
  await expect(select.locator(`option[value="${viewId}"]`)).toHaveCount(0);
  await info.attach('demo-private-views-ui', {
    body: JSON.stringify({ channel: 'ui', surface: scenario.surface, saveReplaceApplyDelete: true, filtersOnly: true, actorIsolation: true, sameIdOnReplace: true, reloadConfirmed: true }, null, 2),
    contentType: 'application/json',
  });
});
