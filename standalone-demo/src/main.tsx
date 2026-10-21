import { createRoot } from 'react-dom/client';
import { useEffect, useState } from 'react';
import { DemoApp } from './demo/DemoApp';
import { getDemoStore } from './demo/data';
import { installDemoHistory } from './demo/adapters/navigation';
import { demoCopy } from './demo/translations';
import { LANG_COOKIE, normalizeLang } from './studio/lib/i18n';
import { installDemoResetLifecycle } from './demo/reset';
import { installDemoNavigationBoundary } from './demo/navigation-boundary';
import './studio/app/globals.css';
import './demo/demo.css';

installDemoHistory();
installDemoNavigationBoundary();
const element = document.getElementById('root');
if (!element) throw new Error('Demo root is missing');
const root = createRoot(element);
// Attach rejection handling immediately: blocked browser storage must show recovery, not a blank page.
const readiness = getDemoStore().ready.then(() => true, () => false);
let browserStateReady = true;
try { installDemoResetLifecycle(); } catch { browserStateReady = false; }
function Bootstrap() {
  const [ready, setReady] = useState<boolean | null>(null);
  let lang = 'ar' as 'ar' | 'en';
  try { lang = normalizeLang(localStorage.getItem(LANG_COOKIE)); } catch { /* Storage may be disabled. */ }
  const copy = demoCopy[lang];
  useEffect(() => { let active = true; void readiness.then((value) => { if (active) setReady(value && browserStateReady); }); return () => { active = false; }; }, []);
  if (ready) return <DemoApp />;
  return <main className="flex min-h-dvh items-center justify-center bg-canvas p-5" dir={lang === 'ar' ? 'rtl' : 'ltr'}>
    <section className="ui-surface w-full max-w-lg p-7">
      <h1 className="text-xl font-semibold text-fg" role={ready === false ? 'alert' : 'status'}>{ready === false ? copy.startupError : copy.loading}</h1>
      {ready === false ? <><p className="mt-3 text-sm leading-6 text-muted">{copy.storageRequired}</p><button type="button" className="mt-5 rounded-control bg-brand px-5 py-3 font-semibold text-brand-on" onClick={() => window.location.reload()}>{copy.retry}</button></> : null}
    </section>
  </main>;
}
root.render(<Bootstrap />);
