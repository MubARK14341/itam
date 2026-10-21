export const LOCAL_NAVIGATION_EVENT = 'studio-demo:local-navigation';
const SCENARIO_KEY = 'demo_local_scenario';
const SCENARIO_VALUE = 'external-navigation';
let installed = false;

export function isAllowedDemoNavigation(raw: string | URL | undefined, currentHref: string): boolean {
  if (raw == null || String(raw) === '') return true;
  try {
    const current = new URL(currentHref);
    const target = new URL(String(raw), current);
    return target.origin === current.origin && ['http:', 'https:', 'blob:'].includes(target.protocol);
  } catch { return false; }
}
export function localNavigationScenarioHref(currentHref: string): string {
  const url = new URL(currentHref);
  url.searchParams.set(SCENARIO_KEY, SCENARIO_VALUE);
  return url.href;
}
export function hasLocalNavigationScenario(href: string): boolean {
  return new URL(href).searchParams.get(SCENARIO_KEY) === SCENARIO_VALUE;
}
export function clearLocalNavigationScenario(href: string): string {
  const url = new URL(href);
  url.searchParams.delete(SCENARIO_KEY);
  return `${url.pathname}${url.search}${url.hash}`;
}
export function announceLocalNavigationScenario() {
  window.dispatchEvent(new Event(LOCAL_NAVIGATION_EVENT));
}
export function guardDemoWindowOpen(open: typeof window.open, currentHref: () => string, announce: () => void): typeof window.open {
  return (...args: Parameters<typeof window.open>) => {
    if (!isAllowedDemoNavigation(args[0], currentHref())) { announce(); return null; }
    return open(...args);
  };
}
export function installDemoNavigationBoundary() {
  if (installed) return;
  installed = true;
  window.open = guardDemoWindowOpen(window.open.bind(window), () => window.location.href, announceLocalNavigationScenario);
  const intercept = (event: MouseEvent) => {
    const anchor = event.composedPath().find((element): element is HTMLAnchorElement => element instanceof HTMLAnchorElement);
    if (!anchor || !anchor.hasAttribute('href')) return;
    if (!isAllowedDemoNavigation(anchor.href, window.location.href) || hasLocalNavigationScenario(anchor.href)) {
      event.preventDefault();
      announceLocalNavigationScenario();
    }
  };
  document.addEventListener('click', intercept, true);
  document.addEventListener('auxclick', intercept, true);
}
