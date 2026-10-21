import { safeHttpUrl as sourceSafeHttpUrl } from '../../studio/lib/safe-url';
import { isAllowedDemoNavigation, localNavigationScenarioHref } from '../navigation-boundary';

// Keep the actual map control, but its href never contains an external destination.
// Context-menu and modified-click navigation therefore stay local too.
export function safeHttpUrl(raw: string | null | undefined): string | null {
  const url = sourceSafeHttpUrl(raw);
  if (!url) return null;
  return isAllowedDemoNavigation(url, window.location.href) ? url : localNavigationScenarioHref(window.location.href);
}
