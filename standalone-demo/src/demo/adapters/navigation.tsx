import { createContext, useContext, useMemo, useSyncExternalStore, type ReactNode } from 'react';

const EVENT = 'studio-demo:navigation';
let refreshVersion = 0;
let historyInstalled = false;
export function installDemoHistory() {
  if (historyInstalled) return;
  historyInstalled = true;
  const push = window.history.pushState.bind(window.history);
  const replace = window.history.replaceState.bind(window.history);
  window.history.pushState = (...args: Parameters<History['pushState']>) => {
    const result = push(...args);
    window.dispatchEvent(new Event(EVENT));
    return result;
  };
  window.history.replaceState = (...args: Parameters<History['replaceState']>) => {
    const result = replace(...args);
    window.dispatchEvent(new Event(EVENT));
    return result;
  };
}
const subscribe = (listener: () => void) => {
  window.addEventListener('popstate', listener);
  window.addEventListener(EVENT, listener);
  return () => { window.removeEventListener('popstate', listener); window.removeEventListener(EVENT, listener); };
};
const snapshot = () => `${window.location.pathname}${window.location.search}${window.location.hash}|${refreshVersion}`;
function navigate(href: string, replace: boolean, options?: { scroll?: boolean }) {
  const url = new URL(href, window.location.href);
  if (url.origin !== window.location.origin) throw new Error('The demo only supports local routes');
  const previous = window.location.pathname;
  window.history[replace ? 'replaceState' : 'pushState']({}, '', `${url.pathname}${url.search}${url.hash}`);
  if (options?.scroll !== false && previous !== url.pathname) {
    document.querySelector('.app-main')?.scrollTo({ top: 0 });
    window.scrollTo({ top: 0 });
  }
}
export const demoRouter = {
  push: (href: string, options?: { scroll?: boolean }) => navigate(href, false, options),
  replace: (href: string, options?: { scroll?: boolean }) => navigate(href, true, options),
  back: () => window.history.back(), forward: () => window.history.forward(),
  refresh: () => { refreshVersion += 1; window.dispatchEvent(new Event(EVENT)); },
  prefetch: async (_href: string) => {},
};
const Params = createContext<Record<string, string>>({});
export function RouteParamsProvider({ value, children }: { value: Record<string, string>; children: ReactNode }) {
  return <Params.Provider value={value}>{children}</Params.Provider>;
}
export function useRouteSnapshot() { return useSyncExternalStore(subscribe, snapshot, snapshot); }
export function useRouter() { return demoRouter; }
export function usePathname() { useRouteSnapshot(); return window.location.pathname; }
export function useSearchParams() {
  const value = useRouteSnapshot();
  return useMemo(() => new URLSearchParams(window.location.search), [value]);
}
export function useParams<T extends Record<string, string> = Record<string, string>>() { return useContext(Params) as T; }
export function redirect(href: string): never { demoRouter.replace(href); throw new Error('DEMO_ROUTE_REDIRECT'); }
export function notFound(): never { throw new Error('DEMO_ROUTE_NOT_FOUND'); }
export type ReadonlyURLSearchParams = URLSearchParams;
