import { useState } from 'react';
import { BriefcaseBusiness, ClipboardList, Eye, HardDrive, ShieldCheck, Users, Wrench, Warehouse, UserRound, ArrowUpLeft } from 'lucide-react';
import { AuthBrand, AuthPrefs } from '@/components/auth/auth-chrome';
import { EquipmentPhoto } from '@/components/assets/equipment-photo';
import { useAppPreferences } from '@/components/providers/app-preferences-provider';
import Link from './adapters/link';
import { demoRouter } from './adapters/navigation';
import { getDemoStore, setDemoActor } from './data';
import { forgetPrefetchShapes } from './read-prefetch';
import { defaultInternalLanding } from '@/lib/user-facing-role';
import { demoCopy, type DemoPersonaId } from './translations';

const primary: DemoPersonaId[] = ['it_manager', 'employee', 'warehouse_manager', 'viewer', 'portal_project_manager', 'portal_requester', 'portal_receiver'];
const advanced: DemoPersonaId[] = ['admin', 'technician', 'auditor'];
const icons = { it_manager: HardDrive, employee: UserRound, warehouse_manager: Warehouse, viewer: Eye, portal_project_manager: BriefcaseBusiness, portal_requester: ClipboardList, portal_receiver: Users, admin: ShieldCheck, technician: Wrench, auditor: Eye };
export default function Login() {
  const { lang } = useAppPreferences();
  const copy = demoCopy[lang];
  const [busy, setBusy] = useState<DemoPersonaId | null>(null);
  const [error, setError] = useState(false);
  async function enter(id: DemoPersonaId) {
    setBusy(id); setError(false);
    try {
      await setDemoActor(id);
      forgetPrefetchShapes();
      demoRouter.push(id.startsWith('portal_') ? '/client-portal' : defaultInternalLanding(getDemoStore().getActor()?.role ?? null));
    } catch { setError(true); setBusy(null); }
  }
  const card = (id: DemoPersonaId) => {
    const Icon = icons[id]; const [title, description] = copy.roles[id];
    return <button key={id} data-demo-role={id} type="button" disabled={busy !== null} onClick={() => void enter(id)} className="demo-role-card group text-start">
      <span className="demo-role-icon"><Icon className="h-5 w-5" aria-hidden="true" /></span>
      <span className="min-w-0 flex-1"><span className="block text-sm font-semibold text-fg">{title}</span><span className="mt-1 block text-xs leading-relaxed text-muted">{description}</span></span>
      <span aria-hidden="true" className="shrink-0 text-brand-ink"><ArrowUpLeft className="h-4 w-4 rtl:rotate-0 ltr:rotate-180" /></span>
      <span className="sr-only">{copy.choose}</span>
    </button>;
  };
  return <main className="demo-login mx-auto min-h-dvh max-w-[1600px] px-4 py-5 sm:px-7 sm:py-8">
    <header className="mb-7 flex items-center justify-between gap-4"><AuthBrand /><AuthPrefs /></header>
    <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,.9fr)_minmax(0,1.1fr)]">
      <section className="demo-login-intro overflow-hidden rounded-[24px] bg-nav px-6 py-8 text-nav-fg sm:px-9 sm:py-10">
        <p className="text-xs font-semibold tracking-widest text-brand">{copy.eyebrow}</p>
        <h1 className="mt-4 max-w-[520px] font-display text-[34px] font-semibold leading-[1.3] sm:text-[44px]">{copy.title}</h1>
        <p className="mt-5 max-w-[520px] text-sm leading-7 text-nav-muted">{copy.intro}</p>
        <div className="demo-equipment-stage relative my-8 flex min-h-[180px] items-center justify-center rounded-[20px] border border-nav-line bg-white/5 p-5">
          <EquipmentPhoto templateId="laptop" size="stage" unframed className="h-[180px] w-full max-w-[330px]" />
        </div>
        <div className="rounded-card border border-nav-line bg-white/5 p-5"><p className="text-xs font-semibold text-brand">{copy.walkthrough}</p><p className="mt-2 text-sm leading-7 text-nav-muted">{copy.steps}</p></div>
        <p className="mt-5 text-xs leading-6 text-nav-muted">{copy.localOnly}</p>
      </section>
      <section className="space-y-5" aria-label={copy.choose}>
        <div><h2 className="mb-3 text-sm font-semibold text-muted">{copy.staff}</h2><div className="grid gap-2 sm:grid-cols-2">{primary.slice(0, 4).map(card)}</div></div>
        <div><h2 className="mb-3 text-sm font-semibold text-muted">{copy.portal}</h2><div className="grid gap-2">{primary.slice(4).map(card)}</div></div>
        <details className="ui-surface px-4 py-3"><summary data-demo-advanced className="cursor-pointer text-sm font-semibold text-fg">{copy.advanced}</summary><div className="mt-3 grid gap-2">{advanced.map(card)}</div></details>
        {error ? <div role="alert" className="ui-notice tone-bad">{copy.startupError}</div> : null}
        <div className="flex flex-wrap gap-x-4 gap-y-2 text-xs text-muted"><Link className="ui-link" href="/register">{copy.registration}</Link><Link className="ui-link" href="/client-portal-register">{copy.portalRegistration}</Link><Link className="ui-link" href="/auth/mfa">{copy.mfa}</Link></div>
      </section>
    </div>
  </main>;
}
