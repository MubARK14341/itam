"use client";

import { Fragment, useState, type KeyboardEvent } from "react";
import Link from "next/link";
import {
  SlidersHorizontal, Users, UserPlus, Truck, Boxes, Warehouse, TrendingDown, Bell, Gauge, ShieldCheck, Lock,
} from "lucide-react";
import { useSession, canManageSettings, isAdmin } from "@/lib/session";
import { useAppPreferences } from "@/components/providers/app-preferences-provider";
import { useFeatureExposure } from "@/components/providers/feature-exposure-provider";
import type { FeatureKey } from "@/lib/feature-exposure";
import { GeneralSettings } from "@/components/settings/general-settings";
import { UsersSettings } from "@/components/settings/users-settings";
import { RegistrationSettings } from "@/components/settings/registration-settings";
import { SuppliersSettings } from "@/components/settings/suppliers-settings";
import { CatalogSettings } from "@/components/settings/catalog-settings";
import { InventorySettings } from "@/components/settings/inventory-settings";
import { DepreciationSettings } from "@/components/settings/depreciation-settings";
import { NotificationSettingsPanel } from "@/components/settings/notification-settings";
import { FeatureRolloutSettings } from "@/components/settings/feature-rollout-settings";
import { PermissionsSettings } from "@/components/settings/permissions-settings";
import { PageHeader } from "@/components/ui/page-header";
import { EmptyState } from "@/components/ui/empty-state";
import { buttonClass } from "@/components/ui/button";
import { handleTabKeyDown } from "@/components/ui/tab-keyboard";

type Tab =
  | "general" | "users" | "registration" | "suppliers"
  | "companies" | "inventory" | "depreciation" | "notifications"
  | "featureRollout" | "permissions";

// إظهار تدريجي: مفتاح كل تبويب. admin يرى الكل دائمًا (isFeatureVisible ترجع true له)؛
// التدرج هنا يخص it_manager فقط. الوصول للصفحة كلها يبقى بالدور (canManageSettings + RLS).
const SETTINGS_TAB_FEATURE: Record<Tab, FeatureKey> = {
  general: "settings.general",
  users: "settings.users",
  registration: "settings.registration",
  suppliers: "settings.suppliers",
  companies: "settings.companies",
  inventory: "settings.inventory",
  depreciation: "settings.depreciation",
  notifications: "settings.notifications",
  featureRollout: "settings.featureRollout",
  permissions: "settings.permissions",
};

// Studio section groups are presentation only; capability/exposure keys are unchanged.
type Group = "base" | "accounts" | "reference" | "notify";
const TAB_GROUP: Record<Tab, Group> = {
  general: "base",
  users: "accounts",
  registration: "accounts",
  permissions: "accounts",
  companies: "reference",
  suppliers: "reference",
  inventory: "reference",
  depreciation: "reference",
  notifications: "notify",
  featureRollout: "notify",
};
const GROUP_ORDER: Group[] = ["base", "accounts", "reference", "notify"];

const TAB_ID = (k: Tab) => `settings-tab-${k}`;
const PANEL_ID = "settings-panel";

// القائمة عمودية على lg وأفقية على الشاشات الصغيرة ⇒ نقبل الأسهم الرأسية أيضًا،
// ونفوّض الأفقية/Home/End للمساعد المشترك (يحترم اتجاه RTL).
function onSectionKeyDown(event: KeyboardEvent<HTMLButtonElement>) {
  if (event.key !== "ArrowUp" && event.key !== "ArrowDown") { handleTabKeyDown(event); return; }
  const tabList = event.currentTarget.closest<HTMLElement>('[role="tablist"]');
  if (!tabList) return;
  const tabs = Array.from(tabList.querySelectorAll<HTMLButtonElement>('[role="tab"]:not(:disabled)'));
  const i = tabs.indexOf(event.currentTarget);
  if (i < 0 || tabs.length < 2) return;
  event.preventDefault();
  const next = tabs[(i + (event.key === "ArrowDown" ? 1 : -1) + tabs.length) % tabs.length];
  next.focus();
  next.click();
}

export default function SettingsPage() {
  const { role, loading } = useSession();
  const { t } = useAppPreferences();
  const { isVisible } = useFeatureExposure();
  const [tab, setTab] = useState<Tab>("general");

  // مركز التحكم — لـ admin و it_manager فقط (RLS يفرض ذلك أيضًا على مستوى القاعدة).
  // الحجب هنا يعتمد على الدور الفعلي (المعتمد فقط يحصل على دور)، لا على إخفاء الواجهة وحده.
  if (!loading && !canManageSettings(role)) {
    return (
      <div className="ui-surface">
        <EmptyState
          icon={Lock}
          title={t.settings.noPermission}
          action={<Link href="/dashboard" className={buttonClass("outline", "sm")}>{t.nav.dashboard}</Link>}
        />
      </div>
    );
  }

  const TABS: { key: Tab; label: string; icon: typeof Users }[] = ([
    { key: "general", label: t.settings.tabs.general, icon: SlidersHorizontal },
    // تحكم النسبة — admin فقط (قرار 2026-07-05): فلترة إضافية بـ isAdmin أدناه + RLS كتابة admin حصرًا.
    { key: "featureRollout", label: t.settings.tabs.featureRollout, icon: Gauge },
    // الصلاحيات التفصيلية — admin فقط (فلترة isAdmin أدناه + RPCs admin-only + RLS).
    { key: "permissions", label: t.settings.tabs.permissions, icon: ShieldCheck },
    { key: "users", label: t.settings.tabs.users, icon: Users },
    { key: "registration", label: t.settings.tabs.registration, icon: UserPlus },
    { key: "suppliers", label: t.settings.tabs.suppliers, icon: Truck },
    { key: "companies", label: t.settings.tabs.catalog, icon: Boxes },
    { key: "inventory", label: t.settings.tabs.inventory, icon: Warehouse },
    { key: "depreciation", label: t.settings.tabs.depreciation, icon: TrendingDown },
    { key: "notifications", label: t.settings.tabs.notifications, icon: Bell },
  ] as { key: Tab; label: string; icon: typeof Users }[]).filter(
    (tb) => isVisible(SETTINGS_TAB_FEATURE[tb.key])
      && ((tb.key !== "featureRollout" && tb.key !== "permissions") || isAdmin(role)),
  );

  // لو كان التبويب الحالي مخفيًا بهذا المستوى نعود لأول تبويب ظاهر (general دائمًا من 10).
  const activeTab: Tab = TABS.some((tb) => tb.key === tab) ? tab : (TABS[0]?.key ?? "general");

  const groupLabel: Record<Group, string | null> = {
    base: null,
    accounts: t.settings.ledger.groupAccounts,
    reference: t.settings.ledger.groupReference,
    notify: t.settings.ledger.groupNotifications,
  };
  const groups = GROUP_ORDER
    .map((g) => ({ g, items: TABS.filter((tb) => TAB_GROUP[tb.key] === g) }))
    .filter((x) => x.items.length > 0);

  return (
    <div className="space-y-6">
      <PageHeader title={t.settings.title} description={t.settings.subtitle} />

      <div className="lg:grid lg:grid-cols-[190px_minmax(0,1fr)] lg:items-start lg:gap-7">
        <div className="lg:sticky lg:top-[104px]">
          <div
            role="tablist"
            aria-label={t.settings.title}
            className="flex gap-5 overflow-x-auto border-b border-line pb-1 lg:flex-col lg:gap-1 lg:overflow-visible lg:border-b-0 lg:pb-0"
          >
            {groups.map(({ g, items }) => (
              <Fragment key={g}>
                {groupLabel[g] && (
                  // عنوان مجموعة بصري فقط؛ أسماء التبويبات هي ما يُعلَن لقارئ الشاشة.
                  <div aria-hidden="true" className="ui-navh hidden lg:block">{groupLabel[g]}</div>
                )}
                {items.map((tb) => {
                  const selected = activeTab === tb.key;
                  return (
                    <button
                      key={tb.key}
                      type="button"
                      role="tab"
                      id={TAB_ID(tb.key)}
                      aria-selected={selected}
                      aria-controls={selected ? PANEL_ID : undefined}
                      tabIndex={selected ? 0 : -1}
                      onKeyDown={onSectionKeyDown}
                      onClick={() => setTab(tb.key)}
                      className="group inline-flex shrink-0 items-center gap-2.5 whitespace-nowrap text-[13px] font-medium text-muted transition-colors hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-ink aria-selected:font-semibold aria-selected:text-brand-ink max-lg:-mb-px max-lg:min-h-11 max-lg:border-b-2 max-lg:border-transparent max-lg:aria-selected:border-brand lg:min-h-11 lg:w-full lg:rounded-control lg:px-3 lg:text-fg-2 lg:hover:bg-surface lg:aria-selected:bg-brand lg:aria-selected:text-brand-on"
                    >
                      <tb.icon aria-hidden="true" strokeWidth={1.75} className="h-[18px] w-[18px] shrink-0 group-aria-selected:text-brand-ink lg:group-aria-selected:text-brand-on" />
                      <span className="min-w-0 truncate">{tb.label}</span>
                    </button>
                  );
                })}
              </Fragment>
            ))}
          </div>
          <div className="mt-5 hidden rounded-xl bg-sunk p-3 text-xs leading-5 text-fg-2 lg:block">
            <p className="font-semibold text-fg">{t.settings.ledger.accessTitle}</p>
            <p className="mt-0.5">{t.settings.ledger.accessNote}</p>
          </div>
        </div>

        <div
          role="tabpanel"
          id={PANEL_ID}
          aria-labelledby={TAB_ID(activeTab)}
          className="min-w-0 max-lg:mt-5"
        >
          {activeTab === "general" && <GeneralSettings />}
          {activeTab === "users" && <UsersSettings />}
          {activeTab === "registration" && <RegistrationSettings />}
          {activeTab === "suppliers" && <SuppliersSettings />}
          {activeTab === "companies" && <CatalogSettings />}
          {activeTab === "inventory" && <InventorySettings />}
          {activeTab === "depreciation" && <DepreciationSettings />}
          {activeTab === "notifications" && <NotificationSettingsPanel />}
          {activeTab === "featureRollout" && <FeatureRolloutSettings />}
          {activeTab === "permissions" && <PermissionsSettings />}
        </div>
      </div>
    </div>
  );
}
