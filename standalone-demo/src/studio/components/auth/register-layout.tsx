"use client";

import type { ReactNode } from "react";
import Link from "next/link";
import { Building2, Users } from "lucide-react";
import { useAppPreferences } from "@/components/providers/app-preferences-provider";
import { AuthBrand, AuthPrefs } from "@/components/auth/auth-chrome";

/** Split layout shared by /register and /client-portal-register: form column + hero. */
export function RegisterShell({ children, hero }: { children: ReactNode; hero: ReactNode }) {
  return (
    <main className="mx-auto grid min-h-dvh w-full max-w-[1440px] gap-5 bg-canvas p-4 sm:p-7 lg:grid-cols-[minmax(0,1.08fr)_minmax(0,.92fr)]">
      <div className="flex min-w-0 flex-col rounded-[22px] bg-surface px-5 py-5 sm:px-10 sm:py-7">
        <div className="flex items-center justify-between gap-3">
          <AuthBrand />
          <AuthPrefs />
        </div>
        <div className="flex flex-1 flex-col justify-center py-6 sm:py-8">
          <div className="mx-auto w-full max-w-[520px]">{children}</div>
        </div>
      </div>
      {hero}
    </main>
  );
}

/** Link-based segmented switch between the employee and the customer registration routes. */
export function RegisterTypeSwitch({ active }: { active: "employee" | "customer" }) {
  const { t } = useAppPreferences();
  const item = "ui-seg-item justify-center gap-2 max-md:min-h-11 md:min-h-9";
  return (
    <nav aria-label={t.registration.accountType} className="ui-seg mt-5 grid w-full grid-cols-2">
      <Link href="/register" aria-current={active === "employee" ? "page" : undefined} className={item}>
        <Building2 aria-hidden="true" className="h-4 w-4" />{t.registration.typeEmployee}
      </Link>
      <Link href="/client-portal-register" aria-current={active === "customer" ? "page" : undefined} className={item}>
        <Users aria-hidden="true" className="h-4 w-4" />{t.registration.typeCustomer}
      </Link>
    </nav>
  );
}

/** Centered result/notice block (closed, no seats, submitted). */
export function RegisterNotice({ icon, tone, title, children }: {
  icon: ReactNode; tone: "warn" | "ok"; title?: string; children?: ReactNode;
}) {
  return (
    <div className="mt-6 flex flex-col items-center rounded-card border border-line bg-surface-2 px-6 py-8 text-center">
      <span className={`mb-3 inline-flex h-12 w-12 items-center justify-center rounded-xl ${tone === "ok" ? "bg-ok-soft text-ok" : "bg-warn-soft text-warn"}`}>{icon}</span>
      {title && <p className="font-display text-base font-semibold text-fg">{title}</p>}
      {children}
    </div>
  );
}
