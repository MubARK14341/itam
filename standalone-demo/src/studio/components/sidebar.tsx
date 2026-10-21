"use client";

import { useState, useEffect, useRef } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { Box, LogOut, Menu, X } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { useSession } from "@/lib/session";
import { useAppPreferences } from "@/components/providers/app-preferences-provider";
import { useFeatureExposure } from "@/components/providers/feature-exposure-provider";
import { secureSignOut } from "@/lib/auth-security";
import { userFacingRole } from "@/lib/user-facing-role";
import {
  SECTION_ORDER, initialsFromEmail, isNavActive, visibleNav, type NavItem,
} from "@/components/shell/nav-config";
import { useShellCounts } from "@/components/shell/use-shell-counts";
import { prefetchIntentProps } from "@/components/shell/route-prefetch";

export function Sidebar() {
  const pathname = usePathname();
  const router = useRouter();
  const { email, role } = useSession();
  const { t } = useAppPreferences();
  const { isVisible } = useFeatureExposure();
  // The same role-aware navigation is a desktop rail and a modal mobile drawer.
  const [open, setOpen] = useState(false);
  const sidebarRef = useRef<HTMLElement>(null);
  const menuRef = useRef<HTMLButtonElement>(null);
  const presentationRole = userFacingRole(role);
  // الموظف المكتبي على الجوال يستخدم شريط التبويب السفلي بدل الدرج.
  const usesBottomTabs = presentationRole === "office_employee";
  useEffect(() => {
    const sidebar = sidebarRef.current;
    const media = window.matchMedia("(max-width: 767px)");
    const main = document.querySelector<HTMLElement>(".app-main");
    function sync() {
      if (sidebar) sidebar.inert = media.matches && !open;
      if (main) main.inert = media.matches && open;
    }
    sync();
    media.addEventListener("change", sync);
    if (open && media.matches) sidebar?.querySelector<HTMLButtonElement>("button")?.focus();
    function onKey(event: KeyboardEvent) {
      if (!open || !media.matches) return;
      if (event.key === "Escape") { setOpen(false); menuRef.current?.focus(); }
      if (event.key !== "Tab") return;
      const nodes = Array.from(sidebar?.querySelectorAll<HTMLElement>('a[href], button:not(:disabled)') ?? [])
        .filter((element) => element.getClientRects().length > 0);
      const first = nodes[0];
      const last = nodes[nodes.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    }
    document.addEventListener("keydown", onKey);
    return () => {
      media.removeEventListener("change", sync);
      document.removeEventListener("keydown", onKey);
      if (main) main.inert = false;
      if (sidebar) sidebar.inert = false;
    };
  }, [open]);
  useEffect(() => { setOpen(false); }, [pathname]); // أغلق الدرج عند التنقّل

  // نفس منطق الفلترة القائم (أدوار + إظهار تدريجي) — بلا أي تغيير في الصلاحيات.
  const visible = visibleNav(role, isVisible);
  const counts = useShellCounts(
    pathname,
    visible.some((i) => i.count === "actions"),
    visible.some((i) => i.count === "requests"),
  );
  const topLevel = visible.filter((i) => !i.section);
  const sections = SECTION_ORDER
    .map((key) => ({ key, items: visible.filter((i) => i.section === key) }))
    .filter((s) => s.items.length > 0);

  const renderItem = (item: NavItem) => {
    const active = isNavActive(item, pathname);
    const count = item.count === "actions" ? counts.actions : item.count === "requests" ? counts.requests : null;
    return (
      <Link
        key={item.href}
        href={item.href}
        // Seeded staff pages perform database reads: warm them only on navigation intent.
        prefetch={false}
        {...prefetchIntentProps(item.href, (href) => router.prefetch(href))}
        onClick={() => setOpen(false)}
        aria-current={active ? "page" : undefined}
        className="app-nav-item"
      >
        <item.icon aria-hidden="true" strokeWidth={1.75} />
        <span className="min-w-0 flex-1 truncate">{t.nav[item.labelKey]}</span>
        {count != null && count > 0 && (
          <span className={`ui-count ${item.count === "actions" ? "ui-count-hot" : ""}`}>{count}</span>
        )}
      </Link>
    );
  };

  async function signOut() {
    const supabase = createClient();
    await secureSignOut(supabase);
    router.push("/login");
    router.refresh();
  }

  return (
    <>
      {/* (RESP-1) زر القائمة — يظهر تحت md فقط داخل الشريط العلوي، في زاوية البداية */}
      {!usesBottomTabs && (
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-label={t.nav.menu}
          aria-expanded={open}
          aria-controls="app-navigation"
          ref={menuRef}
          className="app-mobile-menu-toggle fixed start-2 top-2.5 z-40 flex h-11 w-11 items-center justify-center rounded-control text-fg-2 hover:bg-sunk hover:text-fg md:hidden"
        >
          {open ? <X aria-hidden="true" className="h-5 w-5" /> : <Menu aria-hidden="true" className="h-5 w-5" />}
        </button>
      )}
      {/* خلفية تعتيم عند فتح الدرج على الجوال — النقر يُغلق */}
      {open && (
        <div onClick={() => setOpen(false)} aria-hidden className="app-sidebar-overlay fixed inset-0 z-40 bg-[rgb(var(--scrim)/0.34)] md:hidden" />
      )}
    <aside
      id="app-navigation"
      ref={sidebarRef}
      className={`app-sidebar fixed inset-y-0 start-0 z-50 flex h-dvh w-[min(300px,calc(100vw-2rem))] shrink-0 flex-col transition-transform duration-200 md:w-[210px] xl:w-[244px] ${
        usesBottomTabs ? "max-md:hidden" : ""
      } ${
        // Translation is confined to the mobile drawer; desktop is always visible.
        open ? "max-md:translate-x-0" : "max-md:-translate-x-full max-md:rtl:translate-x-full"
      }`}
    >
      <div className="flex min-h-[100px] shrink-0 items-center gap-3 px-6 pt-4">
        <span className="inline-flex h-10 w-10 shrink-0 items-center justify-center text-brand">
          <Box aria-hidden="true" strokeWidth={1.6} className="h-8 w-8" />
        </span>
        <div className="min-w-0 leading-tight">
          <p dir="ltr" className="font-display text-[30px] font-semibold tracking-tight text-nav-fg">ITAM<span className="text-brand">.</span></p>
          <p className="mt-1 truncate text-[11px] text-nav-muted">{t.nav.brandSub}</p>
        </div>
        <button type="button" onClick={() => { setOpen(false); menuRef.current?.focus(); }} aria-label={t.nav.menu} className="ms-auto inline-flex h-11 w-11 items-center justify-center rounded-control text-nav-muted hover:bg-white/10 md:hidden"><X aria-hidden="true" className="h-5 w-5" /></button>
      </div>

      <nav aria-label={t.nav.primaryNavigation} className="flex-1 overflow-y-auto px-4 pb-6 pt-2">
        {/* لوحة المعلومات (بلا عنوان قسم) */}
        <div className="space-y-0.5">{topLevel.map(renderItem)}</div>
        {/* أقسام مجمّعة حسب طبيعة العمل — عنوان القسم يظهر فقط إن كان له عنصر مرئي واحد على الأقل */}
        {sections.map((s) => (
          <div key={s.key} className="space-y-0.5">
            <p className="ui-navh">{t.nav.sections[s.key]}</p>
            {s.items.map(renderItem)}
          </div>
        ))}
      </nav>

      {email && (
        <div className="mx-4 flex shrink-0 items-center gap-2.5 border-t border-nav-line py-5">
          <span className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-white/10 text-xs font-medium text-nav-fg">{initialsFromEmail(email)}</span>
          <div className="min-w-0 flex-1 leading-tight">
            <p className="truncate text-[11px] font-medium text-nav-fg" dir="ltr">{email}</p>
            {presentationRole && <p className="mt-1 truncate text-[11px] text-nav-muted">{t.roles[presentationRole]}</p>}
          </div>
          <button
            type="button"
            onClick={signOut}
            aria-label={t.nav.signOut}
            title={t.nav.signOut}
            className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-nav-muted hover:bg-white/10 hover:text-brand max-md:h-11 max-md:w-11"
          >
            <LogOut aria-hidden="true" className="h-[18px] w-[18px] rtl:rotate-180" />
          </button>
        </div>
      )}
    </aside>
    </>
  );
}
