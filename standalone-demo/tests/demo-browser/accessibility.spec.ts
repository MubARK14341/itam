import { readFile } from 'node:fs/promises';
import type { AxeResults } from '../../../item/itam-app/node_modules/axe-core';
import { test, expect, waitForUiAnimations } from './helpers';

declare global { interface Window { axe: { run(context: Document, options: { runOnly: { type: 'tag'; values: string[] } }): Promise<AxeResults> }; } }
// Reuse the installed local test tool; nothing is added to the shipped demo.
const axeSource = await readFile(new URL('../../../item/itam-app/node_modules/axe-core/axe.min.js', import.meta.url), 'utf8');
for (const scenario of [
  { lang: 'ar', theme: 'dark', width: 320 }, { lang: 'en', theme: 'light', width: 390 },
  { lang: 'ar', theme: 'light', width: 1440 }, { lang: 'en', theme: 'dark', width: 1600 },
] as const) {
  test(`WCAG audit of login, demo controls and representative pages ${scenario.lang}/${scenario.width}`, async ({ page }, info) => {
    test.setTimeout(120_000);
    await page.setViewportSize({ width: scenario.width, height: 1000 });
    await page.goto('/login'); await page.locator(`button[lang="${scenario.lang}"]`).click();
    if (scenario.theme === 'dark') await page.getByRole('button', { name: scenario.lang === 'ar' ? 'داكن' : 'Dark', exact: true }).click();
    await expect.poll(() => page.locator('html').evaluate(element => element.classList.contains('dark'))).toBe(scenario.theme === 'dark');
    const audits: { route: string; violations: AxeResults['violations']; incomplete: AxeResults['incomplete'] }[] = [];
    async function audit(route: string) {
      await waitForUiAnimations(page);
      await page.evaluate(axeSource);
      const result = await page.evaluate(() => window.axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] } }));
      audits.push({ route, violations: result.violations, incomplete: result.incomplete });
      if (['/login', '/dashboard', '/assets'].includes(route)) {
        await page.screenshot({ path: info.outputPath(`${route.slice(1)}-${scenario.lang}-${scenario.theme}-${scenario.width}.png`), fullPage: true });
      }
    }
    await expect(page.locator('[data-demo-role="it_manager"]')).toBeVisible();
    await audit('/login');
    await page.locator('[data-demo-role="it_manager"]').click();
    await expect(page).toHaveURL(/\/dashboard$/);
    for (const route of ['/dashboard', '/assets', '/reports?tab=inventory', '/requests', '/settings']) {
      await page.goto(route); await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
      await audit(route);
    }
    await page.locator('[data-demo-reset]').focus();
    await page.locator('[data-demo-reset]').press('Enter');
    await expect(page.getByRole('dialog')).toBeVisible();
    await audit('/settings#demo-reset-dialog');
    await page.screenshot({ path: info.outputPath(`reset-dialog-${scenario.lang}-${scenario.theme}-${scenario.width}.png`), fullPage: true });
    await expect.poll(() => page.getByRole('dialog').evaluate(dialog => dialog.contains(document.activeElement))).toBe(true);
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(page.locator('[data-demo-reset]')).toBeFocused();
    await info.attach('demo-accessibility-audit', { body: JSON.stringify({ ...scenario, tool: 'existing local axe-core', audits }, null, 2), contentType: 'application/json' });
    const failures = audits.flatMap(audit => audit.violations.map(violation => ({ route: audit.route, id: violation.id, impact: violation.impact, nodes: violation.nodes.map(node => node.target) })));
    expect(failures, 'Every automatic WCAG violation is retained and needs a source-backed resolution. Incomplete rules remain manual review gaps.').toEqual([]);
  });
}
