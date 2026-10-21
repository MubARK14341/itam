export type DemoRoute = {
  path: string; surface: 'public' | 'staff' | 'portal'; source: string;
  roles: readonly string[]; actions: readonly string[];
};
const managers = ['admin', 'it_manager'];
const operations = [...managers, 'technician', 'warehouse_manager'];
const readers = [...operations, 'auditor', 'viewer'];
const portal = ['portal_project_manager', 'portal_requester', 'portal_receiver'];
const route = (path: string, surface: DemoRoute['surface'], source: string, roles: readonly string[], actions: readonly string[]): DemoRoute => ({ path, surface, source, roles, actions });
export const DEMO_ROUTES: readonly DemoRoute[] = [
  route('/', 'public', 'src/app/page.tsx', [], ['role selection']),
  route('/login', 'public', 'src/app/login/page.tsx', [], ['select persona', 'language', 'theme']),
  route('/register', 'public', 'src/app/register/page.tsx', [], ['validate form', 'local registration']),
  route('/client-portal-register', 'public', 'src/app/client-portal-register/page.tsx', [], ['validate form', 'local portal registration']),
  route('/pending-approval', 'public', 'src/app/pending-approval/page.tsx', [], ['refresh local approval', 'sign out']),
  route('/auth/mfa', 'public', 'src/app/auth/mfa/page.tsx', managers, ['local enrollment', 'validate demo code']),
  route('/a/:token', 'public', 'src/app/a/[token]/page.tsx', [], ['five-field public QR']),
  route('/dashboard', 'staff', 'src/components/dashboard-v6/dashboard-command-center.tsx', managers, ['refresh', 'priority links', 'chart filters']),
  route('/overview', 'staff', 'src/app/(app)/overview/page.tsx', readers, ['operational overview']),
  route('/warehouse', 'staff', 'src/app/(app)/warehouse/page.tsx', operations, ['redirect to request work queue']),
  route('/assets', 'staff', 'src/app/(app)/assets/page-client.tsx', readers, ['search', 'filters', 'quick view', 'selection', 'CSV', 'selected QR']),
  route('/assets/new', 'staff', 'src/app/(app)/assets/new/page.tsx', managers, ['create asset', 'reference validation']),
  route('/assets/import', 'staff', 'src/app/(app)/assets/import/page.tsx', managers, ['template', 'column mapping', 'all row errors', 'import']),
  route('/assets/:id', 'staff', 'src/app/(app)/assets/[id]/page.tsx', readers, ['tabs', 'edit', 'assign', 'return', 'transfer', 'maintenance', 'attachments', 'QR']),
  route('/consumables', 'staff', 'src/app/(app)/consumables/page.tsx', operations, ['search', 'stock movement', 'create consumable']),
  route('/consumables/:id', 'staff', 'src/app/(app)/consumables/[id]/page.tsx', operations, ['tabs', 'stock movement', 'edit', 'purchase request']),
  route('/maintenance', 'staff', 'src/app/(app)/maintenance/page-client.tsx', operations, ['filters', 'create', 'assign', 'close', 'CSV']),
  route('/reports', 'staff', 'src/app/(app)/reports/page-client.tsx', [...managers, 'auditor', 'viewer'], ['tabs', 'filters', 'private views', 'CSV']),
  route('/requests', 'staff', 'src/app/(app)/requests/page-client.tsx', operations, ['search', 'filters', 'board', 'approval', 'fulfillment', 'CSV']),
  route('/requests/new', 'staff', 'src/app/(app)/requests/new/page.tsx', operations, ['create request with items']),
  route('/requests/:id', 'staff', 'src/app/(app)/requests/[id]/page.tsx', operations, ['tabs', 'approve', 'clarify', 'reject', 'prepare', 'deliver', 'return', 'attachments']),
  route('/purchase-requests', 'staff', 'src/app/(app)/purchase-requests/page.tsx', managers, ['create', 'approve', 'receive', 'cancel', 'CSV']),
  route('/stocktakes', 'staff', 'src/app/(app)/stocktakes/page.tsx', operations, ['create', 'scan', 'reconcile', 'close', 'print']),
  route('/alerts', 'staff', 'src/app/(app)/alerts/page-client.tsx', managers, ['filters', 'acknowledge', 'snooze', 'resolve']),
  route('/scan', 'staff', 'src/app/(app)/scan/page.tsx', readers, ['manual synthetic QR', 'scan history', 'actions']),
  route('/activity', 'staff', 'src/app/(app)/activity/page-client.tsx', [...managers, 'auditor', 'viewer'], ['filters', 'private views', 'CSV']),
  route('/settings', 'staff', 'src/app/(app)/settings/page.tsx', managers, ['tabs', 'references', 'users', 'policies', 'portal settings']),
  route('/my-tasks', 'staff', 'src/app/(app)/my-tasks/page-client.tsx', ['employee', ...operations], ['task actions', 'request links']),
  route('/my-requests', 'staff', 'src/app/(app)/my-requests/page-client.tsx', ['employee'], ['create', 'track', 'retry']),
  route('/my-assets', 'staff', 'src/app/(app)/my-assets/page-client.tsx', ['employee'], ['report issue', 'request return']),
  route('/client-portal', 'portal', 'src/app/(portal)/client-portal/page-client.tsx', portal, ['dashboard', 'request links']),
  route('/client-portal/profile', 'portal', 'src/app/(portal)/client-portal/profile/page-client.tsx', portal, ['profile', 'password policy']),
  route('/client-portal/requests', 'portal', 'src/app/(portal)/client-portal/requests/page-client.tsx', portal, ['filters', 'own customer requests']),
  route('/client-portal/requests/new', 'portal', 'src/app/(portal)/client-portal/requests/new/page-client.tsx', portal.slice(0, 2), ['create bundle', 'upload', 'submit same draft', 'recovery']),
  route('/client-portal/requests/:id', 'portal', 'src/app/(portal)/client-portal/requests/[id]/page.tsx', portal, ['status', 'clarification', 'PM approval', 'draft recovery', 'attachments']),
];
export function matchDemoRoute(pathname: string) {
  const sorted = [...DEMO_ROUTES].sort((a, b) => Number(a.path.includes(':')) - Number(b.path.includes(':')));
  for (const entry of sorted) {
    const names: string[] = [];
    const pattern = entry.path.split('/').map((part) => {
      if (!part.startsWith(':')) return part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      names.push(part.slice(1)); return '([^/]+)';
    }).join('/');
    const match = pathname.match(new RegExp(`^${pattern}/?$`));
    if (match) {
      try { return { entry, params: Object.fromEntries(names.map((name, index) => [name, decodeURIComponent(match[index + 1])])) }; }
      catch (error) { if (error instanceof URIError) return null; throw error; }
    }
  }
  return null;
}
