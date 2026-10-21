/**
 * Routes whose server page sends the page's first-screen reads with the page (lib/read-seeds/*).
 * Next's full Link prefetch already carries them, so the shell does not warm them again from the
 * browser (components/shell/route-prefetch.ts).
 */
export const SERVER_SEEDED_ROUTES: ReadonlySet<string> = new Set([
  "/activity",
  "/alerts",
  "/assets",
  "/maintenance",
  "/my-assets",
  "/my-requests",
  "/my-tasks",
  "/reports",
  "/requests",
  "/client-portal",
  "/client-portal/profile",
  "/client-portal/requests",
  "/client-portal/requests/new",
]);
