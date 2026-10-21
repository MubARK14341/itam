import { afterEach, expect, it, vi } from 'vitest';
import { clearLocalNavigationScenario, guardDemoWindowOpen, hasLocalNavigationScenario, isAllowedDemoNavigation, localNavigationScenarioHref } from '../../src/demo/navigation-boundary';
import { safeHttpUrl } from '../../src/demo/adapters/safe-url';

const current = 'http://127.0.0.1:4173/maintenance?m=local-record#details';
afterEach(() => vi.unstubAllGlobals());

it('preserves local history, same-origin new tabs and local blob files', () => {
  for (const target of [undefined, '', '/assets?view=maintenance_attention', '#label', current, 'blob:http://127.0.0.1:4173/local-file']) {
    expect(isAllowedDemoNavigation(target, current)).toBe(true);
  }
});
it('denies explicit external destinations and executable navigation schemes', () => {
  for (const target of ['https://maps.google.com', '//maps.google.com', 'http://127.0.0.1:4174', 'blob:https://maps.google.com/file', 'javascript:alert(1)', 'data:text/html,example', 'mailto:person@example.com']) {
    expect(isAllowedDemoNavigation(target, current)).toBe(false);
  }
});
it('keeps a copied external map href local without including the destination', () => {
  vi.stubGlobal('window', { location: { href: current } });
  const protectedHref = safeHttpUrl('https://maps.google.com/?q=demo-location')!;
  expect(new URL(protectedHref).origin).toBe(new URL(current).origin);
  expect(protectedHref).not.toContain('google');
  expect(hasLocalNavigationScenario(protectedHref)).toBe(true);
  expect(clearLocalNavigationScenario(protectedHref)).toBe('/maintenance?m=local-record#details');
  expect(safeHttpUrl(current)).toBe(current);
  expect(safeHttpUrl('javascript:alert(1)')).toBeNull();
});
it('window.open forwards the original local arguments and never calls native open for external URLs', () => {
  const native = vi.fn(() => null); const announce = vi.fn();
  const guarded = guardDemoWindowOpen(native, () => current, announce);
  guarded('/a/local-token', '_blank', 'noopener');
  guarded('blob:http://127.0.0.1:4173/local-file', '_blank');
  guarded('', '_blank');
  expect(native.mock.calls).toEqual([['/a/local-token', '_blank', 'noopener'], ['blob:http://127.0.0.1:4173/local-file', '_blank'], ['', '_blank']]);
  expect(guarded(new URL('https://maps.google.com'), '_blank')).toBeNull();
  expect(guarded('//maps.google.com', '_blank')).toBeNull();
  expect(native).toHaveBeenCalledTimes(3);
  expect(announce).toHaveBeenCalledTimes(2);
  expect(localNavigationScenarioHref(current)).toBe('http://127.0.0.1:4173/maintenance?m=local-record&demo_local_scenario=external-navigation#details');
});
