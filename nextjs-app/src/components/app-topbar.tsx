"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { BellRing, Box, ChevronLeft, LogOut, ScanLine } from "lucide-react";
import { useSession } from "@/lib/session";
import { useAppPreferences } from "@/components/providers/app-preferences-provider";
import { useFeatureExposure } from "@/components/providers/feature-exposure-provider";
import { PreferencesToggle } from "@/components/preferences-toggle";
import { interpolate, type Dict } from "@/lib/i18n";
import { routePageTitle } from "@/lib/route-title";
import { userFacingRole } from "@/lib/user-facing-role";
import { initialsFromEmail, isNavActive, visibleNav } from "@/components/shell/nav-config";
import { useShellCounts } from "@/components/shell/use-shell-counts";
import { prefetchIntentProps } from "@/components/shell/route-prefetch";
import { SearchInput } from "@/components/ui/form";
import { createClient } from "@/lib/supabase/client";
import { secureSignOut } from "@/lib/auth-security";

// أبٌ منطقي لصفحات التفاصيل/الفرعية كي يظهر مسار الصفحة (عرض فقط).
function parentCrumb(pathname: string, t: Dict): { href: string; label: string } | null {
  if (pathname.startsWith("/assets/") || pathname.startsWith("/consumables")) return { href: "/assets", label: t.nav.assets };
  if (pathname.startsWith("/requests/")) return { href: "/requests", label: t.nav.requests };
  if (pathname === "/purchase-requests") return { href: "/alerts", label: t.nav.actionCenter };
  if (pathname === "/maintenance" || pathname === "/activity") return { href: "/reports", label: t.nav.reports };
  return null;
}

/** Studio toolbar; navigation stays in the role-aware rail/mobile drawer. */
export function AppTopbar() {
  const pathname = usePathname();
  const router = useRouter();
  const { role, email } = useSession();
  const { t } = useAppPreferences();
  const { isVisible } = useFeatureExposure();
  const [q, setQ] = useState("");
  const searchFormRef = useRef<HTMLFormElement>(null);
  const presentationRole = userFacingRole(role);
  const nav = visibleNav(role, isVisible);
  const hasActions = nav.some((i) => i.count === "actions");
  const counts = useShellCounts(pathname, hasActions, nav.some((i) => i.count === "requests"));
  const canScan = presentationRole !== "office_employee" && presentationRole !== "viewer" && isVisible("scan.search");
  useEffect(() => { document.querySelector(".app-main")?.scrollTo({ top: 0 }); }, [pathname]);

  const parent = parentCrumb(pathname, t);
  const current = routePageTitle(pathname, t)
    ?? (nav.find((i) => isNavActive(i, pathname)) ? t.nav[nav.find((i) => isNavActive(i, pathname))!.labelKey] : t.app.title);

  function submit(e: FormEvent) {
    e.preventDefault();
    const value = q.trim();
    router.push(value ? `/scan?q=${encodeURIComponent(value)}` : "/scan");
  }

  async function signOut() {
    await secureSignOut(createClient());
    router.push("/login");
    router.refresh();
  }

  return (
    <header className="app-topbar sticky top-0 z-30 shrink-0 border-b border-line bg-surface/95 backdrop-blur">
      <div className={`mx-auto flex min-h-16 max-w-[1600px] items-center gap-3 px-4 sm:px-6 md:min-h-20 lg:px-8 ${presentationRole === "office_employee" ? "" : "max-md:ps-14"}`}>
        <Link href={nav[0]?.href ?? "/dashboard"} prefetch={false}
          {...prefetchIntentProps(nav[0]?.href ?? "/dashboard", (href) => router.prefetch(href))}
          aria-label={t.nav.brand} className="hidden h-9 w-9 shrink-0 items-center justify-center text-fg sm:inline-flex md:hidden">
          <Box aria-hidden="true" className="h-7 w-7" strokeWidth={1.6} />
        </Link>
        <nav aria-label={t.nav.breadcrumb} className="hidden min-w-0 flex-1 md:block">
          <ol className="flex min-w-0 items-center gap-2 text-[13px]">
            {parent && <>
              <li className="min-w-0"><Link href={parent.href} prefetch={false}
                {...prefetchIntentProps(parent.href, (href) => router.prefetch(href))}
                className="truncate text-muted hover:text-fg">{parent.label}</Link></li>
              <li aria-hidden="true" className="text-muted"><ChevronLeft className="h-3.5 w-3.5 ltr:rotate-180" /></li>
            </>}
            <li className="min-w-0 truncate font-medium text-fg" aria-current="page">{current}</li>
          </ol>
        </nav>
        {canScan && <form ref={searchFormRef} role="search" noValidate onSubmit={submit} className="hidden w-[min(280px,30vw)] md:block">
          <SearchInput label={t.nav.quickSearch} clearLabel={t.common.clearSearch}
            onClear={() => { setQ(""); searchFormRef.current?.querySelector("input")?.focus(); }}
            value={q} onChange={(e) => setQ(e.target.value)} placeholder={t.nav.quickSearchPlaceholder}
            className="bg-surface-2 text-[13px]" />
        </form>}
        <div className="ms-auto flex shrink-0 items-center gap-1">
          {canScan && <Link href="/scan" prefetch={false}
            {...prefetchIntentProps("/scan", (href) => router.prefetch(href))}
            aria-label={t.nav.scanShort} title={t.nav.scanShort}
            className="inline-flex h-11 w-11 items-center justify-center rounded-control text-muted hover:bg-sunk hover:text-fg md:hidden">
            <ScanLine aria-hidden="true" className="h-[18px] w-[18px]" />
          </Link>}
          {hasActions && (
            <Link href="/alerts" prefetch={false}
              {...prefetchIntentProps("/alerts", (href) => router.prefetch(href))}
              aria-label={counts.actions ? interpolate(t.nav.actionCenterCount, { count: counts.actions }) : t.nav.actionCenter}
              title={t.nav.actionCenter} className="relative hidden h-11 w-11 items-center justify-center rounded-control text-fg-2 hover:bg-sunk hover:text-brand-ink sm:inline-flex">
              <BellRing aria-hidden="true" className="h-[18px] w-[18px]" />
              {counts.actions ? <span aria-hidden="true" className="absolute end-1 top-1 inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-bad px-1 text-[10px] font-bold tabular-nums text-white dark:text-canvas">{counts.actions > 99 ? "99+" : counts.actions}</span> : null}
            </Link>
          )}
          <PreferencesToggle />
          {email && <>
            <span className="ui-avatar ms-2 hidden h-9 w-9 bg-brand-soft text-brand-ink sm:inline-flex" title={email}>{initialsFromEmail(email)}</span>
            <button type="button" onClick={signOut} aria-label={t.nav.signOut} title={t.nav.signOut}
              className="inline-flex h-11 w-11 items-center justify-center rounded-control text-muted hover:bg-bad-soft hover:text-bad md:hidden">
              <LogOut aria-hidden="true" className="h-[18px] w-[18px] rtl:rotate-180" />
            </button>
          </>}
        </div>
      </div>
    </header>
  );
}
