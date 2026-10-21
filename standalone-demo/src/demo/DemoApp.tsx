import { Component, Suspense, useEffect, useState, type ReactNode } from 'react';
import { RotateCcw, UsersRound } from 'lucide-react';
import { AppPreferencesProvider, useAppPreferences } from '@/components/providers/app-preferences-provider';
import { RouteDocumentTitle } from '@/components/route-document-title';
import { Dialog } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import { LANG_COOKIE, THEME_COOKIE, normalizeLang, normalizeTheme } from '@/lib/i18n';
import { getDemoStore, prepareDemoAuthRoute, type DemoPreparedAuthPath } from './data';
import { useDemoActor } from './DemoSession';
import { DemoShell } from './DemoShell';
import { DemoPage } from './pages';
import { matchDemoRoute } from './route-manifest';
import { demoRouter, RouteParamsProvider, useRouteSnapshot } from './adapters/navigation';
import { demoCopy } from './translations';
import { clearReadPrefetch } from './read-prefetch';
import { finishDemoReset } from './reset';
import { clearLocalNavigationScenario, hasLocalNavigationScenario, LOCAL_NAVIGATION_EVENT } from './navigation-boundary';

class DemoBoundary extends Component<{ children: ReactNode; fallback: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() { return this.state.failed ? this.props.fallback : this.props.children; }
}
function DemoControls() {
  const { lang } = useAppPreferences(); const copy = demoCopy[lang];
  const [resetOpen, setResetOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  async function reset() {
    setBusy(true); setError(false);
    try {
      await getDemoStore().reset();
      clearReadPrefetch(); setResetOpen(false); finishDemoReset(getDemoStore().getGeneration());
    } catch { setError(true); } finally { setBusy(false); }
  }
  return <>
    <aside className="demo-controls" aria-label={copy.badge}>
      <span role="status" className="demo-disclosure">{copy.badge}</span>
      <button type="button" data-demo-role-picker className="demo-tool" onClick={() => demoRouter.push('/login')}><UsersRound aria-hidden="true" className="h-4 w-4" /><span>{copy.rolePicker}</span></button>
      <button type="button" data-demo-reset className="demo-tool" onClick={() => setResetOpen(true)}><RotateCcw aria-hidden="true" className="h-4 w-4" /><span className="hidden sm:inline">{copy.reset}</span><span className="sr-only sm:hidden">{copy.reset}</span></button>
    </aside>
    <Dialog open={resetOpen} onClose={() => { if (!busy) setResetOpen(false); }} title={copy.resetTitle} description={copy.resetBody} footer={<><Button variant="outline" disabled={busy} onClick={() => setResetOpen(false)}>{copy.cancel}</Button><Button disabled={busy} onClick={() => void reset()}>{copy.confirm}</Button></>}>
      <p className="text-sm text-muted">{copy.localOnly}</p>{error ? <p role="alert" className="mt-3 text-bad">{copy.startupError}</p> : null}
    </Dialog>
  </>;
}
function LocalNavigationNotice() {
  const { lang } = useAppPreferences(); const copy = demoCopy[lang];
  const route = useRouteSnapshot();
  const [open, setOpen] = useState(() => hasLocalNavigationScenario(window.location.href));
  useEffect(() => {
    const show = () => setOpen(true);
    window.addEventListener(LOCAL_NAVIGATION_EVENT, show);
    return () => window.removeEventListener(LOCAL_NAVIGATION_EVENT, show);
  }, []);
  useEffect(() => { if (hasLocalNavigationScenario(window.location.href)) setOpen(true); }, [route]);
  if (!open) return null;
  return <aside data-demo-local-navigation-notice role="status" className="fixed inset-x-4 top-4 z-[80] mx-auto flex max-w-xl items-center gap-4 rounded-card border border-line bg-surface p-4 text-sm text-fg shadow-lg">
    <span className="flex-1">{copy.externalNavigation}</span>
    <Button variant="outline" size="sm" onClick={() => { setOpen(false); window.history.replaceState(window.history.state, '', clearLocalNavigationScenario(window.location.href)); }}>{copy.dismiss}</Button>
  </aside>;
}
function isPreparedAuthPath(path: string): path is DemoPreparedAuthPath {
  return path === '/register' || path === '/client-portal-register' || path === '/pending-approval' || path === '/auth/mfa';
}
function RouteView() {
  const snapshot = useRouteSnapshot();
  const pathname = window.location.pathname;
  const match = matchDemoRoute(pathname);
  const actor = useDemoActor();
  const { lang, t } = useAppPreferences(); const copy = demoCopy[lang];
  const authRoute = isPreparedAuthPath(pathname);
  const preparationKey = `${pathname}:${actor?.id ?? 'anonymous'}`;
  const [preparedKey, setPreparedKey] = useState(authRoute ? null : preparationKey);
  const [preparationError, setPreparationError] = useState(false);
  useEffect(() => {
    let active = true;
    setPreparationError(false);
    const prepare = async () => {
      if (!authRoute) return;
      const result = await prepareDemoAuthRoute(pathname, actor?.id ?? null, getDemoStore().getGeneration(), () => active && window.location.pathname === pathname);
      if (active && result.prepared) setPreparedKey(`${pathname}:${result.actorId ?? 'anonymous'}`);
    };
    void prepare().catch(() => { if (active) setPreparationError(true); });
    return () => { active = false; };
  }, [pathname, actor?.id]);
  useEffect(() => {
    if (match?.entry.surface === 'staff' && !actor) demoRouter.replace('/login');
    else if (match?.entry.surface === 'staff' && actor?.portalRole) demoRouter.replace('/client-portal');
    else if (match?.entry.surface === 'portal' && !actor) demoRouter.replace('/login');
  }, [match?.entry.surface, actor]);
  if (!match) return <main className="mx-auto max-w-xl px-5 py-24"><h1 className="text-2xl font-semibold">{copy.unknown}</h1><Button className="mt-5" onClick={() => demoRouter.replace('/login')}>{copy.back}</Button></main>;
  if (preparationError) return <main className="mx-auto max-w-xl px-5 py-24"><h1 role="alert" className="text-2xl font-semibold">{copy.startupError}</h1><Button className="mt-5" onClick={() => window.location.reload()}>{copy.retry}</Button></main>;
  if ((authRoute && preparedKey !== preparationKey) || (match.entry.surface !== 'public' && !actor)) return <Spinner label={t.common.loading} />;
  const page = <Suspense fallback={<div className="flex min-h-[40vh] items-center justify-center"><Spinner label={t.common.loading} /></div>}><DemoPage route={match.entry.path} params={match.params} /></Suspense>;
  const content = match.entry.surface === 'public' ? page : <DemoShell key={`${match.entry.surface}:${actor?.id}`} surface={match.entry.surface}>{page}</DemoShell>;
  const fallback = <main className="mx-auto max-w-xl px-5 py-24"><h1 className="text-2xl font-semibold">{copy.startupError}</h1><p className="mt-3 text-muted">{copy.localOnly}</p><Button className="mt-5" onClick={() => window.location.reload()}>{copy.retry}</Button></main>;
  return <RouteParamsProvider value={match.params}><DemoBoundary key={`${pathname}:${actor?.id}`} fallback={fallback}>{content}</DemoBoundary>
    {['/register', '/client-portal-register', '/pending-approval', '/auth/mfa'].includes(pathname) ? <p className="demo-auth-simulation" role="note">{copy.authSimulation}</p> : null}
    <span className="sr-only" data-demo-current-path={snapshot.split('|')[0]} />
  </RouteParamsProvider>;
}
export function DemoApp() {
  const readPreference = (key: string) => { try { return localStorage.getItem(key); } catch { return null; } };
  const lang = normalizeLang(readPreference(LANG_COOKIE));
  const theme = normalizeTheme(readPreference(THEME_COOKIE));
  useEffect(() => { document.documentElement.lang = lang; document.documentElement.dir = lang === 'ar' ? 'rtl' : 'ltr'; document.documentElement.classList.toggle('dark', theme === 'dark'); document.documentElement.style.colorScheme = theme; }, [lang, theme]);
  return <AppPreferencesProvider initialLang={lang} initialTheme={theme}><div data-demo-runtime="browser-only"><RouteDocumentTitle /><RouteView /><DemoControls /><LocalNavigationNotice /></div></AppPreferencesProvider>;
}
