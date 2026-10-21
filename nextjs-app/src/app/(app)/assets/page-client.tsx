"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import AppLoading from "@/app/(app)/loading";
import { prefetchIntentProps } from "@/components/shell/route-prefetch";
import { useRouter } from "next/navigation";
import { Plus, Upload } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { PageHeader } from "@/components/ui/page-header";
import { KpiBand } from "@/components/ui/kpi-band";
import { Tabs, panelId, tabId } from "@/components/ui/tabs";
import { FilterChip } from "@/components/ui/filter-chip";
import { Button, buttonClass } from "@/components/ui/button";
import { STATUS_AR } from "@/lib/format";
import { ASSET_STATUS_TONE, type Tone } from "@/lib/tone";
import { useSession, canManageAssets, canCreateAsset, canSeeFinancial, useCan } from "@/lib/session";
import { listAssetsPage, listConsumablesPage } from "@/lib/queries";
import { downloadCSV } from "@/lib/export";
import { ASSET_VIEWS, type AssetViewKey } from "@/lib/alert-predicates";
import { WorkQueueBanner } from "@/components/work-queue-banner";
import { useAppPreferences } from "@/components/providers/app-preferences-provider";
import { useFeatureExposure } from "@/components/providers/feature-exposure-provider";
import { AssetPoolsCards, type PoolCard } from "@/components/assets/asset-pools-cards";
import { UnifiedInventoryTable, buildUnifiedRows, unifiedLocationFallback, unifiedRowMatches, type UnifiedRow } from "@/components/assets/unified-inventory-table";
import { AssetListTable } from "@/components/assets/asset-list-table";
import { InventoryBulkBar } from "@/components/assets/inventory-selection";
import { AssetQrPrint, type AssetQrLabel } from "@/components/assets/asset-qr-print";
import { InventoryQuickView, quickViewFromAsset, quickViewFromUnified, type QuickViewItem } from "@/components/assets/inventory-quick-view";
import { visibleLocations } from "@/lib/locations";
import { ASSET_POOLS_UI_VISIBLE } from "@/lib/asset-pools-visibility";
import { buildInventoryReturnTo, withInventoryReturnTo } from "@/lib/inventory-navigation";
import {
  inventoryPaginationPlan,
  skippedInventoryPage,
  type InventoryItemType,
} from "@/lib/inventory-pagination";
import {
  beginOperationalListRequest,
  completeOperationalListRequest,
  createOperationalListRequestGate,
  cancelOperationalListRequest,
  operationalListRequestSignal,
} from "@/lib/operational-list-request-gate";
import type { AssetInventoryRow, AssetStatus, Category, ConsumableRow, LocationRow } from "@/lib/types";
import { collectCursorPages, type AscTextCursor } from "@/lib/pagination";
import { SearchInput, Select } from "@/components/ui/form";
import { friendlyErrorStrict } from "@/lib/user-facing-errors";

type ConsumablesPanelComponent = typeof import("@/components/consumables/consumables-panel")["ConsumablesPanel"];
let consumablesPanelCode: Promise<ConsumablesPanelComponent> | null = null;
function loadConsumablesPanel(): Promise<ConsumablesPanelComponent> {
  return consumablesPanelCode ??= import("@/components/consumables/consumables-panel")
    .then((module) => {
      if (typeof module.ConsumablesPanel !== "function") throw new Error("consumables_panel_load_failed");
      return module.ConsumablesPanel;
    }).catch((error: unknown) => {
      consumablesPanelCode = null;
      throw error;
    });
}

// نوع العنصر (فلتر موحّد بدل تبويب «الكل» المربك): الكل = أصول+مستهلكات، أصول = جدول الأصول، مستهلكات = المستهلكات.
type ItemType = InventoryItemType;

const ASSET_VIEW_KEYS: AssetViewKey[] = [
  "maintenance_attention",
  "missing_location",
  "no_qr",
];

export default function AssetsPage() {
  const router = useRouter();
  const { role } = useSession();
  const { t, lang } = useAppPreferences();
  const { isVisible } = useFeatureExposure();
  const can = useCan();
  const write = canManageAssets(role);
  const fin = canSeeFinancial(role);
  // إظهار تدريجي (طبقة عرض فوق شرط الدور، لا بديلًا عنه):
  // إضافة أصل من 50، فلاتر القوائم من 20، تبويب المستهلكات من 30.
  const addVisible = isVisible("assets.add");
  const importVisible = isVisible("assets.import");
  const filtersVisible = isVisible("assets.filters");
  const consumablesVisible = isVisible("consumables.list");
  const [rows, setRows] = useState<AssetInventoryRow[]>([]);
  const [consumables, setConsumables] = useState<ConsumableRow[]>([]);
  const [cats, setCats] = useState<Category[]>([]);
  const [locs, setLocs] = useState<LocationRow[]>([]);
  const [companies, setCompanies] = useState<{ id: string; name: string }[]>([]);
  const [pools, setPools] = useState<PoolCard[]>([]);
  const [loading, setLoading] = useState(true);
  const [initialInventorySettled, setInitialInventorySettled] = useState(false);
  const [inventoryActivated, setInventoryActivated] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [assetCursor, setAssetCursor] = useState<AscTextCursor | null>(null);
  const [consumableCursor, setConsumableCursor] = useState<AscTextCursor | null>(null);
  const [assetTotal, setAssetTotal] = useState(0);
  const [consumableTotal, setConsumableTotal] = useState(0);
  const listRequestGate = useRef(createOperationalListRequestGate());

  const [tab, setTab] = useState<ItemType>("all");
  const [ConsumablesPanel, setConsumablesPanel] = useState<ConsumablesPanelComponent | null>(null);
  const [consumablesCodeFailed, setConsumablesCodeFailed] = useState(false);
  const [consumablesCodeRetry, setConsumablesCodeRetry] = useState(0);
  useEffect(() => {
    if (tab !== "consumables" || ConsumablesPanel || consumablesCodeFailed) return;
    let active = true;
    void loadConsumablesPanel().then((component) => {
      if (active) setConsumablesPanel(() => component);
    }).catch(() => {
      if (active) setConsumablesCodeFailed(true);
    });
    return () => { active = false; };
  }, [tab, ConsumablesPanel, consumablesCodeFailed, consumablesCodeRetry]);
  const [q, setQ] = useState("");
  const [filtersReady, setFiltersReady] = useState(false);
  const [cat, setCat] = useState("");
  const [status, setStatus] = useState("");
  const [loc, setLoc] = useState("");
  const [company, setCompany] = useState("");
  const [pool, setPool] = useState("");
  // قائمة عمل (?view=) — نفس شرط كرت اللوحة حرفيًا (alert-predicates.ts).
  const [view, setView] = useState<AssetViewKey | null>(null);
  const [exportBusy, setExportBusy] = useState(false);

  // قراءة فلاتر أوّلية من رابط الـ URL بعد التحميل (لِكروت لوحة التحكم) — يتفادى عدم تطابق الـ hydration
  useEffect(() => {
    const p = new URLSearchParams(window.location.search);
    const initialQ = p.get("q"); const c = p.get("cat"); const s = p.get("status"); const l = p.get("loc");
    const initialCompany = p.get("company"); const initialType = p.get("type");
    if (initialQ) setQ(initialQ); if (c) setCat(c); if (s) setStatus(s); if (l) setLoc(l);
    if (initialCompany) setCompany(initialCompany);
    if (initialType === "assets" || initialType === "consumables") setTab(initialType);
    const v = p.get("view");
    // قائمة عمل من مركز الإجراءات = خاصة بالأصول → نفرض عرض «الأصول» حتى تظهر الأزرار السريعة والشعار.
    if (v && (ASSET_VIEW_KEYS as string[]).includes(v)) { setView(v as AssetViewKey); setTab("assets"); }
    setFiltersReady(true);
  }, []);

  // إغلاق قائمة العمل: تُنظَّف من الرابط أيضًا حتى لا تعود بعد التحديث.
  const clearView = () => {
    setView(null);
    try { window.history.replaceState({}, "", "/assets"); } catch { /* غير حرج */ }
  };

  useEffect(() => {
    if (!initialInventorySettled) return;
    const controller = new AbortController();
    (async () => {
      const supabase = createClient();
      const [{ data: c }, { data: l }, { data: comp }, { data: pl }] = await Promise.all([
        supabase.from("categories").select("id,name,name_ar,prefix,kind,management_type").order("name").abortSignal(controller.signal),
        supabase.from("locations").select("id,name,name_ar,code").order("name").abortSignal(controller.signal),
        supabase.from("companies").select("id,name").eq("is_active", true).order("name").abortSignal(controller.signal),
        ASSET_POOLS_UI_VISIBLE
          ? supabase.from("asset_pools").select("id,name,name_ar, category:category_id(name,name_ar), company:company_id(name)").eq("is_active", true).order("name").abortSignal(controller.signal)
          : Promise.resolve({ data: [] }),
      ]);
      if (controller.signal.aborted) return;
      setCats((c as Category[]) ?? []);
      setLocs(visibleLocations((l as LocationRow[]) ?? [])); // إخفاء «الفرع 1/2» من فلتر المواقع
      setCompanies((comp as { id: string; name: string }[]) ?? []);
      setPools((pl as unknown as PoolCard[]) ?? []);
    })();
    return () => { controller.abort(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialInventorySettled]);

  async function loadInventory(reset: boolean) {
    const pagination = inventoryPaginationPlan({
      reset,
      itemType: tab,
      hasMoreAssets: assetCursor !== null,
      hasMoreConsumables: consumableCursor !== null,
    });
    const generation = beginOperationalListRequest(listRequestGate.current, reset, pagination.hasMore);
    if (generation === null) return;
    const signal = operationalListRequestSignal(listRequestGate.current, generation);
    if (reset) setLoading(true); else setLoadingMore(true);
    const filters = {
      q,
      categoryId: cat,
      status,
      locationId: loc,
      companyId: company,
      poolId: pool,
      view,
    };
    const [assetPage, consumablePage] = await Promise.all([
      pagination.loadAssets
        ? listAssetsPage({ cursor: reset ? null : assetCursor, filters, signal })
        : Promise.resolve(skippedInventoryPage<AssetInventoryRow, AscTextCursor>(assetCursor)),
      pagination.loadConsumables
        ? listConsumablesPage({
            cursor: reset ? null : consumableCursor,
            // Unified rows, quick view and selection CSV contain no financial fields.
            includeFinancial: false,
            signal,
            filters: { q, categoryId: cat, locationId: loc, companyId: company },
          })
        : Promise.resolve(skippedInventoryPage<ConsumableRow, AscTextCursor>(consumableCursor)),
    ]);
    if (!completeOperationalListRequest(listRequestGate.current, generation)) return;
    // Options follow the first current list result, including a failed read.
    setInitialInventorySettled(true);
    const pageError = assetPage.error ?? consumablePage.error;
    if (pageError) setError(`${t.assets.loadError}${friendlyErrorStrict(pageError, lang)}`);
    else setError(null);
    setRows((previous) => reset ? assetPage.rows : [...previous, ...assetPage.rows]);
    setConsumables((previous) => reset ? consumablePage.rows : [...previous, ...consumablePage.rows]);
    setAssetCursor(assetPage.nextCursor);
    setConsumableCursor(consumablePage.nextCursor);
    if (assetPage.total != null) setAssetTotal(assetPage.total);
    if (consumablePage.total != null) setConsumableTotal(consumablePage.total);
    setLoading(false);
    setLoadingMore(false);
  }

  const lastLoadQuery = useRef<string | null>(null);
  // The dedicated panel owns its first list. Once shown, keep the parent
  // inventory active across later tab switches so loaded rows/cursors stay intact.
  const inventoryActive = tab !== "consumables" || inventoryActivated;
  useEffect(() => {
    // لا تبدأ القراءة قبل اكتمال تهيئة فلاتر الرابط في العرض الأول.
    if (!filtersReady || !inventoryActive) return;
    setInventoryActivated(true);
    // تأخير 250ms فقط عند كتابة البحث؛ التحميل الأول وتغيير الفلاتر فوريان.
    const typing = lastLoadQuery.current !== null && lastLoadQuery.current !== q;
    lastLoadQuery.current = q;
    const timer = window.setTimeout(() => { void loadInventory(true); }, typing ? 250 : 0);
    const gate = listRequestGate.current;
    return () => { window.clearTimeout(timer); cancelOperationalListRequest(gate); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filtersReady, inventoryActive, q, cat, status, loc, company, pool, view, fin]);

  const filtered = useMemo(() => {
    return rows.filter((r) => {
      // قائمة العمل أولًا: نفس شرط كرت اللوحة حرفيًا — الرقم يطابق القائمة.
      if (view && !ASSET_VIEWS[view](r)) return false;
      if (cat && r.category_id !== cat) return false;
      if (status && r.status !== status) return false;
      if (loc && r.location_id !== loc) return false;
      if (company && r.company_id !== company) return false;
      if (pool && r.pool_id !== pool) return false;
      if (q) {
        const hay = `${r.asset_tag ?? ""} ${r.name ?? ""} ${r.serial_number ?? ""} ${r.model?.brand ?? ""} ${r.model?.model_name ?? ""}`.toLowerCase();
        if (!hay.includes(q.toLowerCase())) return false;
      }
      return true;
    });
  }, [rows, q, cat, status, loc, company, pool, view]);

  // العرض الموحّد (نوع العنصر = الكل): يُبنى من الأصول + المستهلكات، ويحترم الإظهار التدريجي للمستهلكات.
  const rowLocations = unifiedLocationFallback(consumablesVisible ? consumables : [], locs);
  const unifiedFiltered = useMemo(() => {
    const consData = consumablesVisible ? consumables : [];
    return buildUnifiedRows(rows, consData, rowLocations).filter((r) =>
      unifiedRowMatches(r, { q, cat, status, loc, company }),
    );
  }, [rows, consumables, consumablesVisible, rowLocations, q, cat, status, loc, company]);

  const viewCount = view ? assetTotal : 0;

  const exportView = async () => {
    if (!view || exportBusy) return;
    setExportBusy(true);
    try {
    const result = await collectCursorPages<AssetInventoryRow, AscTextCursor>((cursor) => listAssetsPage({
      cursor, pageSize: 250,
      filters: { q, categoryId: cat, status, locationId: loc, companyId: company, poolId: pool, view },
    }));
    if (result.error) { setError(`${t.assets.loadError}${friendlyErrorStrict(result.error, lang)}`); return; }
    const h = t.assets.headers;
    downloadCSV(
      `work-queue-${view}.csv`,
      [h.tag, h.name, h.category, h.status, h.location, h.holder],
      result.rows.filter(ASSET_VIEWS[view]).map((r) => [
        r.asset_tag, r.name, r.category?.name_ar ?? r.category?.name,
        t.status[r.status], r.location?.name_ar ?? r.location?.name,
        r.holder?.full_name_ar ?? r.holder?.full_name,
      ]),
    );
    } finally { setExportBusy(false); }
  };

  // عدد قائمة العمل = نفس شرط الكرت على كامل الصفوف (يطابق رقم كرت اللوحة).
  // تحديث صف محليًا بعد إجراء ناجح — الشرط الموحد يُخرجه من القائمة فورًا وينقص العدد.
  // تصدير CSV لقائمة العمل — أعمدة غير مالية فقط (لا يوجد أي عمود مالي هنا أصلًا).
  const TABS: { key: ItemType; label: string }[] = [
    { key: "all", label: t.assets.tabs.all },
    { key: "assets", label: t.assets.tabs.assetsOnly },
    // إظهار تدريجي: عنصر المستهلكات من مستوى 30.
    ...(consumablesVisible ? [{ key: "consumables" as ItemType, label: t.assets.tabs.consumables }] : []),
  ];

  // فلاتر مرئية نشطة (المجموعة مُخفاة من الواجهة فلا تُحتسب). زر «مسح الفلاتر» يعيدها فقط.
  const anyFilter = !!(q || cat || status || loc || company);
  const clearFilters = useCallback(() => { setQ(""); setCat(""); setStatus(""); setLoc(""); setCompany(""); }, []);
  // لو وصل فلتر عبر الرابط (?status= من بطاقات اللوحة) والفلاتر مخفية بالمستوى،
  // نُبقي واجهة الفلاتر ظاهرة حتى لا يعلق فلتر خفي بلا طريقة لمسحه.
  const filtersUiVisible = filtersVisible || anyFilter;
  const returnTo = useMemo(() => buildInventoryReturnTo({
    q,
    category: cat,
    status,
    location: loc,
    company,
    type: tab,
  }), [q, cat, status, loc, company, tab]);
  const pagination = inventoryPaginationPlan({
    reset: false,
    itemType: tab,
    hasMoreAssets: assetCursor !== null,
    hasMoreConsumables: consumableCursor !== null,
  });

  // ---- Ledger: اختيار متعدد + عرض سريع (طبقة واجهة فقط — بلا أي جلب أو تعديل بيانات إضافي) ----
  const lu = t.assets.listUx;
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [quick, setQuick] = useState<QuickViewItem | null>(null);
  const [printAssets, setPrintAssets] = useState<AssetQrLabel[] | null>(null);
  const tableRows: UnifiedRow[] = useMemo(
    () => (tab === "all" ? unifiedFiltered : tab === "assets" ? buildUnifiedRows(filtered, [], []) : []),
    [tab, unifiedFiltered, filtered],
  );
  // التحديد يقتصر على الصفوف الظاهرة: أي صف يخرج من القائمة (فلتر/تبويب) يخرج من التحديد.
  useEffect(() => {
    setSelected((prev) => {
      if (prev.size === 0) return prev;
      const visible = new Set(tableRows.map((r) => r.key));
      const next = new Set([...prev].filter((key) => visible.has(key)));
      return next.size === prev.size ? prev : next;
    });
  }, [tableRows]);
  const toggleRow = useCallback((key: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  }, []);
  const toggleAllRows = useCallback(() => {
    setSelected((prev) => {
      const all = tableRows.length > 0 && tableRows.every((r) => prev.has(r.key));
      return all ? new Set() : new Set(tableRows.map((r) => r.key));
    });
  }, [tableRows]);
  const selectedRows = tableRows.filter((r) => selected.has(r.key));
  // تصدير المحدد — نفس downloadCSV الآمن، أعمدة غير مالية فقط.
  const exportSelected = () => {
    const h = t.assets.headers;
    const stockLabel = { out: t.consumables.out, low: t.consumables.low, good: t.consumables.good };
    downloadCSV(
      "inventory-selection.csv",
      [h.type, h.tagOrCode, h.name, h.category, h.status, h.location, h.holderOrQty, h.company],
      selectedRows.map((r) => [
        r.type === "asset" ? t.assets.badges.asset : t.assets.badges.consumable,
        r.code, r.name, r.categoryLabel,
        r.assetStatus ? t.status[r.assetStatus] : r.stock ? stockLabel[r.stock] : "",
        r.location, r.holderOrQty, r.company,
      ]),
    );
  };
  const assetById = useMemo(() => new Map(rows.map((r) => [r.id, r] as const)), [rows]);
  const selectedAssets = selectedRows.flatMap((row) => {
    const asset = row.type === "asset" ? assetById.get(row.id) : undefined;
    return asset ? [asset] : [];
  });
  const printBlocked = selectedAssets.some((asset) => !asset.qr_token);
  const printSelected = () => {
    if (printBlocked || selectedAssets.length === 0) return;
    setPrintAssets(selectedAssets.flatMap(({ id, asset_tag, name, qr_token }) => qr_token ? [{ id, asset_tag: asset_tag ?? id, name: name ?? "", qr_token }] : []));
  };
  const closePrint = useCallback(() => setPrintAssets(null), []);
  const openQuickUnified = useCallback((r: UnifiedRow) => {
    const asset = r.type === "asset" ? assetById.get(r.id) : undefined;
    setQuick(asset ? quickViewFromAsset(asset, lang) : quickViewFromUnified(r));
  }, [assetById, lang]);
  const closeQuick = useCallback(() => setQuick(null), []);
  const quickHref = useCallback((href: string) => withInventoryReturnTo(href, returnTo), [returnTo]);

  // عدّادات شرائح الحالة — من الصفوف المحمّلة فعلًا (بلا استعلام إضافي).
  const statusKeys = Object.keys(STATUS_AR) as AssetStatus[];
  const statusCounts = useMemo(() => {
    const counts: Partial<Record<AssetStatus, number>> = {};
    for (const r of filtered) counts[r.status] = (counts[r.status] ?? 0) + 1;
    return counts;
  }, [filtered]);
  const statusCount = (s: AssetStatus) => {
    if (loading) return undefined;
    if (status) return status === s ? filtered.length : undefined;
    return statusCounts[s] ?? 0;
  };

  return (
    <div className="space-y-5">
      <PageHeader title={t.assets.title} description={tab !== "consumables" ? (loading ? t.assets.loading : tab === "all" ? `${unifiedFiltered.length} ${t.common.of} ${assetTotal + (consumablesVisible ? consumableTotal : 0)}` : `${filtered.length} ${t.common.of} ${assetTotal}`) : undefined} actions={write && tab !== "consumables" ? <>
            {importVisible && canCreateAsset(role) && can("asset.import") && (
              <Link href="/assets/import" prefetch={false} {...prefetchIntentProps("/assets/import", router.prefetch)} className={buttonClass("outline", "md")}>
                <Upload aria-hidden="true" className="h-4 w-4" /> {t.assets.importCsv}
              </Link>
            )}
            {addVisible && canCreateAsset(role) && (
              <Link href="/assets/new" prefetch={false} {...prefetchIntentProps("/assets/new", router.prefetch)} className={buttonClass("primary", "md")}>
                <Plus aria-hidden="true" className="h-4 w-4" /> {t.assets.add}
              </Link>
            )}
          </> : undefined} />

      {/* نوع العنصر: الكل (أصول+مستهلكات) / أصول / مستهلكات + شرائح الحالة (فلتر الحالة نفسه) */}
      {tab !== "consumables" && filtersUiVisible && (
        <KpiBand label={t.assets.title} items={[
          { key: "shown", label: lu.loadedCountLabel, value: loading ? "…" : filtered.length, hint: lu.loadedCountNote },
          ...statusKeys.map((key) => ({ key, label: t.status[key], value: loading ? "…" : statusCounts[key] ?? 0, tone: ASSET_STATUS_TONE[key], hint: lu.loadedCountNote })),
        ]} />
      )}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-3 rounded-card border border-line bg-surface px-5 py-4">
        <Tabs variant="segmented" idBase="inventory-type" label={t.assets.itemTypeLabel} items={TABS} value={tab} onChange={setTab} />
        {tab !== "consumables" && filtersUiVisible && (
          <>
            <span aria-hidden="true" className="hidden h-[22px] w-px bg-line-strong sm:block" />
            <div role="group" aria-label={lu.statusFilterLabel} className="flex flex-wrap items-center gap-2">
              {statusKeys.map((s) => (
                <FilterChip key={s} pressed={status === s} count={statusCount(s)} onClick={() => setStatus((cur) => (cur === s ? "" : s))}>
                  <span aria-hidden="true" className={`h-2 w-2 rounded-full ${STATUS_DOT[ASSET_STATUS_TONE[s]]}`} />
                  {t.status[s]}
                </FilterChip>
              ))}
            </div>
          </>
        )}
      </div>

      <div role="tabpanel" id={panelId("inventory-type", tab)} aria-labelledby={tabId("inventory-type", tab)}>
      {tab === "consumables" ? (
        consumablesCodeFailed ? (
          <div role="alert" className="rounded-control border border-bad/20 bg-bad-soft p-5 text-bad">
            <p className="font-semibold">{t.consumables.loadError}</p>
            <p className="mt-1 text-sm">{friendlyErrorStrict("consumables_panel_load_failed", lang)}</p>
            <Button variant="outline" onClick={() => {
              setConsumablesCodeFailed(false);
              setConsumablesCodeRetry((version) => version + 1);
            }} className="mt-3">{t.reports.retry}</Button>
          </div>
        ) : ConsumablesPanel ? <ConsumablesPanel embedded /> : <AppLoading />
      ) : (
      <>
      {/* شعار قائمة العمل — يظهر عند الوصول من كرت تنبيه (?view=، عرض الأصول فقط). العدد يطابق الكرت. */}
      {view && tab === "assets" && (
        <WorkQueueBanner
          title={t.workQueue.views[view].title}
          desc={t.workQueue.views[view].desc}
          action={t.workQueue.views[view].action}
          count={viewCount}
          clearLabel={t.workQueue.showAll}
          csvLabel={t.workQueue.csv}
          onClear={clearView}
          onCsv={exportView}
          csvBusy={exportBusy}
        />
      )}

      {/* مجموعات الأصول — مُخفاة من الواجهة مؤقتًا (لا تخدم التشغيل الحالي). البيانات/الجداول باقية بلا تغيير. */}
      {ASSET_POOLS_UI_VISIBLE && (
        <AssetPoolsCards pools={pools} assets={rows} activePool={pool}
          onSelect={(id) => setPool((cur) => (cur === id ? "" : id))} onClear={() => setPool("")} />
      )}

      <section aria-label={t.assets.title} className="ui-surface overflow-hidden">
        {selectedRows.length > 0 ? (
          <InventoryBulkBar count={selectedRows.length} onExport={exportSelected} onClear={() => setSelected(new Set())}
            printCount={selectedAssets.length} printBlocked={printBlocked} onPrint={printSelected} />
        ) : (
          <div className="flex flex-wrap items-center gap-2.5 border-b border-line px-3.5 py-3">
            <SearchInput
              label={t.assets.searchPlaceholder}
              clearLabel={t.common.clearSearch}
              value={q}
              onChange={(e) => setQ(e.target.value)}
              onClear={() => setQ("")}
              placeholder={t.assets.searchPlaceholder}
              containerClassName="w-full sm:w-80"
            />
            {/* إظهار تدريجي: فلاتر القوائم من مستوى 20 (البحث النصي يبقى دائمًا) */}
            {filtersUiVisible && (
              <>
                <div className="w-full sm:w-44">
                  <Select value={cat} onChange={setCat} placeholder={t.assets.allCategories}
                    options={cats.map((c) => ({ value: c.id, label: c.name_ar ?? c.name }))} />
                </div>
                <div className="w-full sm:w-48">
                  <Select value={loc} onChange={setLoc} placeholder={t.assets.allLocations}
                    options={locs.map((l) => ({ value: l.id, label: l.name_ar ?? l.name }))} />
                </div>
                <div className="w-full sm:w-44">
                  <Select value={company} onChange={setCompany} placeholder={t.assets.allCompanies}
                    options={companies.map((c) => ({ value: c.id, label: c.name }))} />
                </div>
                {/* فلتر المجموعة — مُخفى من الواجهة مؤقتًا (المنطق باقٍ؛ pool="" لا يؤثّر على النتائج) */}
                {ASSET_POOLS_UI_VISIBLE && (
                  <div className="w-full sm:w-44">
                    <Select value={pool} onChange={setPool} placeholder={t.pools.allPools}
                      options={pools.map((p) => ({ value: p.id, label: p.name_ar ?? p.name }))} />
                  </div>
                )}
              </>
            )}
            {anyFilter && (
              <Button type="button" variant="ghost" size="sm" onClick={clearFilters} className="text-brand-ink">
                {t.common.clearFilters}
              </Button>
            )}
          </div>
        )}

        {error && (
          <div role="alert" className="border-b border-line bg-bad-soft px-4 py-3 text-sm text-bad">{error}</div>
        )}

        {tab === "all" ? (
          <UnifiedInventoryTable
            rows={unifiedFiltered}
            loading={loading}
            returnTo={returnTo}
            selected={selected}
            onToggle={toggleRow}
            onToggleAll={toggleAllRows}
            onQuickView={openQuickUnified}
            onClearFilters={anyFilter ? clearFilters : undefined}
          />
        ) : (
          <AssetListTable
            rows={filtered}
            hasAnyRows={rows.length > 0}
            loading={loading}
            returnTo={returnTo}
            view={view}
            fin={fin}
            write={write}
            canFixStatus={write && isVisible("assets.details.changeStatus")}
            canAdd={canCreateAsset(role) && addVisible}
            anyFilter={anyFilter}
            onClearFilters={clearFilters}
            selected={selected}
            onToggle={toggleRow}
            onToggleAll={toggleAllRows}
            onQuickView={(asset: AssetInventoryRow) => setQuick(quickViewFromAsset(asset, lang))}
          />
        )}
      </section>
      {pagination.hasMore && (
        <div className="mt-4 flex justify-center">
          <Button type="button" variant="outline" disabled={loading || loadingMore} onClick={() => void loadInventory(false)}>
            {loadingMore ? t.assets.loading : t.reports.showMore}
          </Button>
        </div>
      )}
      </>
      )}
      </div>

      <InventoryQuickView item={quick} onClose={closeQuick} openHref={quickHref} />
      <AssetQrPrint assets={printAssets} onClose={closePrint} />
    </div>
  );
}

const STATUS_DOT: Record<Tone, string> = {
  ok: "bg-ok", res: "bg-res", warn: "bg-warn", bad: "bg-bad", info: "bg-brand", neu: "bg-muted",
};
