"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useSession } from "@/lib/session";
import { useAppPreferences } from "@/components/providers/app-preferences-provider";
import { userFacingRole } from "@/lib/user-facing-role";
import { EMPLOYEE_NAV, isNavActive } from "@/components/shell/nav-config";
import { prefetchIntentProps } from "@/components/shell/route-prefetch";

const SHORT: Partial<Record<string, "tasksShort">> = { dailyTasks: "tasksShort" };

/** Bottom tab bar for office employees on phones (replaces the drawer). */
export function EmployeeTabbar() {
  const pathname = usePathname();
  const { role } = useSession();
  const { t } = useAppPreferences();
  if (userFacingRole(role) !== "office_employee") return null;
  return (
    <nav
      aria-label={t.nav.primaryNavigation}
      className="app-bottom-tabs fixed inset-x-0 bottom-0 z-30 grid h-[calc(72px+env(safe-area-inset-bottom))] grid-cols-3 border-t border-line bg-surface pb-[env(safe-area-inset-bottom)] md:hidden"
    >
      {EMPLOYEE_NAV.map((item) => {
        const active = isNavActive(item, pathname);
        const short = SHORT[item.labelKey];
        return (
          <Link
            key={item.href}
            href={item.href}
            prefetch
            {...prefetchIntentProps(item.href)}
            aria-current={active ? "page" : undefined}
            className={`flex flex-col items-center justify-center gap-0.5 text-[11.5px] ${active ? "font-semibold text-brand-ink" : "font-medium text-muted hover:text-fg"}`}
          >
            <span className="inline-flex h-7 items-center justify-center">
              <item.icon aria-hidden="true" className="h-5 w-5" strokeWidth={1.75} />
            </span>
            {short ? t.nav[short] : t.nav[item.labelKey]}
          </Link>
        );
      })}
    </nav>
  );
}
