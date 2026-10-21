"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { LogOut, Moon, Sun, Box, Home, ClipboardList, PlusCircle, UserRound } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { getPortalContext, type PortalContext } from "@/lib/portal";
import { PortalSessionProvider } from "@/components/providers/portal-session";
import { useInitialPortalContext } from "@/components/providers/portal-initial";
import { useAppPreferences } from "@/components/providers/app-preferences-provider";
import { secureSignOut } from "@/lib/auth-security";
import { prefetchIntentProps, prefetchWhenIdle } from "@/components/shell/route-prefetch";

const TABS = [
  { href: "/client-portal", key: "home", icon: Home },
  { href: "/client-portal/requests", key: "requests", icon: ClipboardList },
  { href: "/client-portal/requests/new", key: "newRequest", icon: PlusCircle },
  { href: "/client-portal/profile", key: "account", icon: UserRound },
] as const;

function tabActive(href: string, pathname: string) {
  if (href === "/client-portal") return pathname === href;
  if (href === "/client-portal/requests") return pathname === href || (pathname.startsWith(href + "/") && pathname !== "/client-portal/requests/new");
  return pathname === href || pathname.startsWith(href + "/");
}

export default function ClientPortalLayout({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const { t, lang, theme, setLang, toggleTheme } = useAppPreferences();
  const tp = t.portal;
  const initialContext = useInitialPortalContext();
  const [ctx, setCtx] = useState<PortalContext | null>(initialContext);
  const [checked, setChecked] = useState(initialContext != null);
  const hasInitialContext = initialContext != null;

  useEffect(() => {
    if (hasInitialContext) return;
    // حارس: مستخدم بوابة نشط فقط. غير ذلك (موظف/معطّل) → لوحة النظام الداخلي (RLS يمنعه من رؤية أي بيانات).
    getPortalContext().then((c) => {
      if (!c) { router.replace("/dashboard"); return; }
      setCtx(c); setChecked(true);
    });
  }, [router, hasInitialContext]);

  useEffect(() => prefetchWhenIdle(TABS.map((tab) => tab.href)), [pathname]);

  async function signOut() {
    await secureSignOut(createClient());
    router.replace("/login");
  }

  if (!checked || !ctx) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-canvas">
        <div role="status" aria-live="polite">
          <span className="sr-only">{t.common.loading}</span>
          <div aria-hidden="true" className="h-8 w-8 animate-spin rounded-full border-2 border-brand border-t-transparent" />
        </div>
      </div>
    );
  }

  const langBtn = (active: boolean) =>
    `inline-flex h-8 min-w-9 items-center justify-center rounded-lg px-2 text-xs font-semibold transition-colors max-md:h-10 ${active ? "bg-white/15 text-white" : "text-nav-muted hover:text-white"}`;

  return (
    <PortalSessionProvider value={ctx}>
      <div className="min-h-screen bg-canvas">
        <header className="sticky top-0 z-30 border-b border-nav-line bg-nav text-nav-fg">
          <div className="mx-auto flex h-[72px] max-w-[1280px] items-center gap-3 px-4 sm:px-7 md:h-20">
            <Link href="/client-portal" className="flex min-w-0 items-center gap-2.5">
              <span className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-brand text-brand-on"><Box aria-hidden="true" className="h-[22px] w-[22px]" strokeWidth={1.6} /></span>
              <span className="min-w-0 leading-tight">
                <span className="block truncate font-display text-base font-semibold text-nav-fg">{ctx.customer_name}</span>
                <span className="mt-0.5 block text-xs text-nav-muted">{tp.appName}</span>
              </span>
            </Link>
            {/* تنقّل أفقي على الشاشات الكبيرة */}
            <nav aria-label={t.nav.primaryNavigation} className="ms-4 hidden items-center gap-1 md:flex">
              {TABS.map((tab) => {
                const active = tabActive(tab.href, pathname);
                return (
                  <Link key={tab.href} href={tab.href} prefetch {...prefetchIntentProps(tab.href)} aria-current={active ? "page" : undefined}
                    className={`inline-flex min-h-11 items-center gap-2 rounded-control px-3 text-sm font-medium transition-colors ${active ? "bg-white/10 text-white" : "text-nav-muted hover:bg-white/5 hover:text-white"}`}>
                    <tab.icon aria-hidden="true" className={`h-4 w-4 ${active ? "text-brand" : ""}`} />
                    {tp.tabs[tab.key]}
                  </Link>
                );
              })}
            </nav>
            <div className="ms-auto flex shrink-0 items-center gap-1">
              <div className="flex items-center gap-0.5 rounded-control border border-nav-line p-[3px]" role="group" aria-label={t.prefs.language}>
                <button type="button" onClick={() => setLang("ar")} aria-pressed={lang === "ar"} className={langBtn(lang === "ar")}>ع</button>
                <button type="button" onClick={() => setLang("en")} aria-pressed={lang === "en"} className={langBtn(lang === "en")}>EN</button>
              </div>
              <button type="button" onClick={toggleTheme} aria-label={theme === "dark" ? t.prefs.light : t.prefs.dark} className="inline-flex h-[38px] w-[38px] items-center justify-center rounded-control text-nav-muted hover:bg-white/10 hover:text-white max-md:h-11 max-md:w-11">
                {theme === "dark" ? <Sun aria-hidden="true" className="h-[18px] w-[18px]" /> : <Moon aria-hidden="true" className="h-[18px] w-[18px]" />}
              </button>
              <button type="button" onClick={signOut} aria-label={tp.signOut} title={tp.signOut} className="inline-flex h-[38px] w-[38px] items-center justify-center rounded-control text-nav-muted hover:bg-white/10 hover:text-brand max-md:h-11 max-md:w-11">
                <LogOut aria-hidden="true" className="h-[18px] w-[18px] rtl:rotate-180" />
              </button>
            </div>
          </div>
        </header>
        <main className="mx-auto max-w-[1280px] px-4 pb-28 pt-6 sm:px-7 md:pb-12 md:pt-8">
          {ctx.portal_enabled === false ? (
            <div className="rounded-card border border-warn/30 bg-warn-soft p-10 text-center">
              <p className="font-display text-base font-semibold text-warn">{tp.disabledTitle}</p>
              <p className="mt-2 text-sm text-fg-2">{tp.disabledDesc}</p>
            </div>
          ) : children}
        </main>
        {/* شريط تبويب سفلي على الجوال */}
        <nav aria-label={t.nav.primaryNavigation} className="app-bottom-tabs fixed inset-x-0 bottom-0 z-30 grid h-[calc(72px+env(safe-area-inset-bottom))] grid-cols-4 border-t border-line bg-surface pb-[env(safe-area-inset-bottom)] md:hidden">
          {TABS.map((tab) => {
            const active = tabActive(tab.href, pathname);
            return (
              <Link key={tab.href} href={tab.href} prefetch {...prefetchIntentProps(tab.href)} aria-current={active ? "page" : undefined}
                className={`flex flex-col items-center justify-center gap-0.5 text-[11.5px] ${active ? "font-semibold text-brand-ink" : "font-medium text-muted hover:text-fg"}`}>
                <span className="inline-flex h-7 items-center justify-center">
                  <tab.icon aria-hidden="true" className="h-5 w-5" strokeWidth={1.75} />
                </span>
                {tp.tabs[tab.key]}
              </Link>
            );
          })}
        </nav>
      </div>
    </PortalSessionProvider>
  );
}
