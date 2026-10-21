import type { Locator, Page } from '@playwright/test';

export function exactFieldLabel(label: string): RegExp {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^\\s*${escaped}\\s*\\*?\\s*$`);
}

// Studio's Select intentionally exposes its placeholder as aria-label. Locate
// the visible Field label and its adjacent control, including the decorative
// required marker, rather than assuming that label overrides aria-label.
export function labeledSelect(scope: Page | Locator, label: string): Locator {
  return scope.locator('label').filter({ hasText: exactFieldLabel(label) }).locator('..').locator('select');
}
