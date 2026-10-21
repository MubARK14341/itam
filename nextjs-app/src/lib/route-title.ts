import type { Dict } from "@/lib/i18n";

export const ROUTE_PATHNAME_HEADER = "x-itam-pathname";

function pageTitle(title: string, appTitle: string) {
  return title === appTitle ? appTitle : `${title} · ${appTitle}`;
}

/** Page title for a pathname without the app suffix (null when the route has no specific title). */
export function routePageTitle(pathname: string, t: Dict): string | null {
  const exact: Record<string, string> = {
    "/": t.app.title,
    "/login": t.auth.signIn,
    "/register": t.registration.title,
    "/client-portal-register": t.portal.register.title,
    "/pending-approval": t.registration.pendingTitle,
    "/dashboard": t.dashboard.commandCenter.title,
    "/overview": t.nav.overview,
    "/alerts": t.actionCenter.title,
    "/requests": t.requests.title,
    "/requests/new": t.requests.newTitle,
    "/purchase-requests": t.purchaseRequests.title,
    "/assets": t.assets.title,
    "/assets/new": t.assetForm.newTitle,
    "/assets/import": t.import.title,
    "/consumables": t.consumables.title,
    "/maintenance": t.maintenance.title,
    "/scan": t.scan.title,
    "/stocktakes": t.stocktakes.title,
    "/reports": t.reports.title,
    "/activity": t.activity.title,
    "/settings": t.settings.title,
    "/my-tasks": t.dailyTasks.title,
    "/my-requests": t.nav.myRequests,
    "/my-assets": t.nav.myAssets,
    "/client-portal": t.portal.home.title,
    "/client-portal/requests": t.portal.myRequests,
    "/client-portal/requests/new": t.portal.newRequest,
    "/client-portal/profile": t.portal.profile.title,
  };
  const exactTitle = exact[pathname];
  if (exactTitle) return exactTitle;

  if (pathname.startsWith("/a/")) return t.publicAsset.title;
  if (pathname.startsWith("/assets/")) return t.assetDetail.infoTitle;
  if (pathname.startsWith("/requests/")) return t.employeeSelfService.requestDetails;
  if (pathname.startsWith("/consumables/")) return t.consumables.title;
  if (pathname.startsWith("/client-portal/requests/")) return t.employeeSelfService.requestDetails;

  return null;
}

export function routeDocumentTitle(pathname: string, t: Dict): string {
  const title = routePageTitle(pathname, t);
  return title ? pageTitle(title, t.app.title) : t.app.title;
}
