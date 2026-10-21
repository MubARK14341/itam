import { forwardRef, type AnchorHTMLAttributes, type MouseEvent } from 'react';
import { demoRouter } from './navigation';
import { announceLocalNavigationScenario, isAllowedDemoNavigation, localNavigationScenarioHref } from '../navigation-boundary';
type Props = Omit<AnchorHTMLAttributes<HTMLAnchorElement>, 'href'> & {
  href: string | { pathname?: string; query?: Record<string, string | number>; hash?: string };
  prefetch?: boolean; replace?: boolean; scroll?: boolean;
};
const Link = forwardRef<HTMLAnchorElement, Props>(function Link({ href, prefetch: _prefetch, replace, scroll, onClick, ...props }, ref) {
  const resolved = typeof href === 'string' ? href : `${href.pathname ?? ''}${href.query ? `?${new URLSearchParams(Object.entries(href.query).map(([key, value]) => [key, String(value)]))}` : ''}${href.hash ?? ''}`;
  const blocked = !isAllowedDemoNavigation(resolved, window.location.href);
  const localHref = blocked ? localNavigationScenarioHref(window.location.href) : resolved;
  function click(event: MouseEvent<HTMLAnchorElement>) {
    onClick?.(event);
    if (blocked) { event.preventDefault(); announceLocalNavigationScenario(); return; }
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || props.target === '_blank' || props.download) return;
    const url = new URL(resolved, window.location.href);
    if (url.origin !== window.location.origin) return;
    event.preventDefault();
    demoRouter[replace ? 'replace' : 'push'](resolved, { scroll });
  }
  return <a {...props} ref={ref} href={localHref} onClick={click} />;
});
export default Link;
