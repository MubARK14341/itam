import { lazy, useEffect, useMemo, useState } from 'react';
import { DashboardCommandCenter } from '@/components/dashboard-v6/dashboard-command-center';
import type { DashboardCommandCenterData } from '@/lib/dashboard/dashboard-types';
import { useAppPreferences } from '@/components/providers/app-preferences-provider';
import { useFeatureExposure } from '@/components/providers/feature-exposure-provider';
import { useCan } from '@/lib/session';
import { resolveReportTab, visibleReportTabs } from '@/lib/report-load-plan';
import { Spinner } from '@/components/ui/spinner';
import { Button } from '@/components/ui/button';
import { getDemoDashboardData, subscribeDemoStore } from './data';
import { demoRouter, useRouteSnapshot, useSearchParams } from './adapters/navigation';
import { demoCopy } from './translations';
import Login from './Login';

const Assets = lazy(() => import('../studio/app/(app)/assets/page-client'));
const NewAsset = lazy(() => import('../studio/app/(app)/assets/new/page'));
const ImportAssets = lazy(() => import('../studio/app/(app)/assets/import/page'));
const AssetDetail = lazy(() => import('../studio/app/(app)/assets/[id]/page'));
const Consumables = lazy(() => import('../studio/app/(app)/consumables/page'));
const ConsumableDetail = lazy(() => import('../studio/app/(app)/consumables/[id]/page'));
const Overview = lazy(() => import('../studio/app/(app)/overview/page'));
const Maintenance = lazy(() => import('../studio/app/(app)/maintenance/page-client'));
const Reports = lazy(() => import('../studio/app/(app)/reports/page-client'));
const Requests = lazy(() => import('../studio/app/(app)/requests/page-client'));
const NewRequest = lazy(() => import('../studio/app/(app)/requests/new/page'));
const RequestDetail = lazy(() => import('../studio/app/(app)/requests/[id]/page'));
const PurchaseRequests = lazy(() => import('../studio/app/(app)/purchase-requests/page'));
const Stocktakes = lazy(() => import('../studio/app/(app)/stocktakes/page'));
const Alerts = lazy(() => import('../studio/app/(app)/alerts/page-client'));
const Scan = lazy(() => import('../studio/app/(app)/scan/page'));
const Activity = lazy(() => import('../studio/app/(app)/activity/page-client'));
const Settings = lazy(() => import('../studio/app/(app)/settings/page'));
const MyTasks = lazy(() => import('../studio/app/(app)/my-tasks/page-client'));
const MyRequests = lazy(() => import('../studio/app/(app)/my-requests/page-client'));
const MyAssets = lazy(() => import('../studio/app/(app)/my-assets/page-client'));
const PortalHome = lazy(() => import('../studio/app/(portal)/client-portal/page-client'));
const PortalProfile = lazy(() => import('../studio/app/(portal)/client-portal/profile/page-client'));
const PortalRequests = lazy(() => import('../studio/app/(portal)/client-portal/requests/page-client'));
const PortalNewRequest = lazy(() => import('../studio/app/(portal)/client-portal/requests/new/page-client'));
const PortalRequestDetail = lazy(() => import('../studio/app/(portal)/client-portal/requests/[id]/page'));
const Register = lazy(() => import('../studio/app/register/page'));
const PortalRegister = lazy(() => import('../studio/app/client-portal-register/page'));
const PendingApproval = lazy(() => import('../studio/app/pending-approval/page'));
const Mfa = lazy(() => import('../studio/app/auth/mfa/page'));
const PublicQr = lazy(() => import('../studio/app/a/[token]/page'));

function DashboardPage() {
  const { lang, t } = useAppPreferences();
  const route = useRouteSnapshot();
  const [data, setData] = useState<DashboardCommandCenterData | null>(null);
  const [error, setError] = useState(false);
  useEffect(() => {
    let active = true;
    const load = () => { void getDemoDashboardData().then((value) => { if (active) { setData(value); setError(false); } }, () => { if (active) setError(true); }); };
    load(); const unsubscribe = subscribeDemoStore(load);
    return () => { active = false; unsubscribe(); };
  }, [route]);
  if (error) return <div role="alert" className="ui-notice tone-bad">{demoCopy[lang].startupError}<Button variant="outline" onClick={() => demoRouter.refresh()}>{demoCopy[lang].retry}</Button></div>;
  return data ? <DashboardCommandCenter data={data} /> : <Spinner label={t.common.loading} />;
}
function ReportsPage() {
  const params = useSearchParams();
  const { isVisible } = useFeatureExposure();
  const can = useCan();
  const initialTab = resolveReportTab(params.get('tab'), visibleReportTabs(isVisible, can('report.customer_requests')));
  return <Reports initialTab={initialTab} />;
}
function WarehouseRedirect() { useEffect(() => demoRouter.replace('/requests?view=warehouse'), []); const { t } = useAppPreferences(); return <Spinner label={t.common.loading} />; }
export function DemoPage({ route, params }: { route: string; params: Record<string, string> }) {
  const id = params.id ?? '';
  const token = params.token ?? '';
  const idParams = useMemo(() => Promise.resolve({ id }), [id]);
  const tokenParams = useMemo(() => Promise.resolve({ token }), [token]);
  const initialNowMs = useMemo(() => Date.now(), [route]);
  switch (route) {
    case '/': case '/login': return <Login />;
    case '/dashboard': return <DashboardPage />;
    case '/overview': return <Overview />;
    case '/warehouse': return <WarehouseRedirect />;
    case '/assets': return <Assets />;
    case '/assets/new': return <NewAsset />;
    case '/assets/import': return <ImportAssets />;
    case '/assets/:id': return <AssetDetail params={idParams} />;
    case '/consumables': return <Consumables />;
    case '/consumables/:id': return <ConsumableDetail params={idParams} />;
    case '/maintenance': return <Maintenance initialNowMs={initialNowMs} />;
    case '/reports': return <ReportsPage />;
    case '/requests': return <Requests />;
    case '/requests/new': return <NewRequest />;
    case '/requests/:id': return <RequestDetail params={idParams} />;
    case '/purchase-requests': return <PurchaseRequests />;
    case '/stocktakes': return <Stocktakes />;
    case '/alerts': return <Alerts />;
    case '/scan': return <Scan />;
    case '/activity': return <Activity />;
    case '/settings': return <Settings />;
    case '/my-tasks': return <MyTasks />;
    case '/my-requests': return <MyRequests />;
    case '/my-assets': return <MyAssets />;
    case '/client-portal': return <PortalHome />;
    case '/client-portal/profile': return <PortalProfile />;
    case '/client-portal/requests': return <PortalRequests />;
    case '/client-portal/requests/new': return <PortalNewRequest />;
    case '/client-portal/requests/:id': return <PortalRequestDetail params={idParams} />;
    case '/register': return <Register />;
    case '/client-portal-register': return <PortalRegister />;
    case '/pending-approval': return <PendingApproval />;
    case '/auth/mfa': return <Mfa />;
    case '/a/:token': return <PublicQr params={tokenParams} />;
    default: return null;
  }
}
