"use client";

import { use, useCallback, useEffect, useState } from "react";
import Link from "next/link";
import {
  ArrowRight, UserPlus, Undo2, MoveRight, Wrench, RefreshCw, Pencil, PackageSearch,
} from "lucide-react";
import { Card } from "@/components/ui/card";
import { Button, buttonClass } from "@/components/ui/button";
import { StatusBadge } from "@/components/ui/badge";
import { StatusChip } from "@/components/ui/status-chip";
import { EmptyState } from "@/components/ui/empty-state";
import { Tabs, tabId, panelId, type TabItem } from "@/components/ui/tabs";
import { Toast, type ToastState } from "@/components/ui/toast";
import type { SaveFeedback } from "@/lib/save-feedback";
import { MaintenanceModal } from "@/components/maintenance-modal";
import { formatSAR, formatDate } from "@/lib/format";
import type { AssetStatus } from "@/lib/types";
import { useSession, canManageAssets, canSeeFinancial, canSeeMaintenanceCost, useCan } from "@/lib/session";
import { useAppPreferences } from "@/components/providers/app-preferences-provider";
import { useFeatureExposure } from "@/components/providers/feature-exposure-provider";
import type { FeatureKey } from "@/lib/feature-exposure";
import { interpolate } from "@/lib/i18n";
import {
  getAsset, getAssetLogs, getAssetRequestHistory, getFormOptions, getLastModifier,
  listDepreciationRules,
} from "@/lib/queries";
import type { DepreciationRule } from "@/lib/depreciation";
import { computeCompleteness } from "@/lib/asset-completeness";
import { AssetExtraDetails } from "@/components/assets/asset-extra-details";
import { AssetDocuments } from "@/components/assets/asset-documents";
import { AssetTemplateBadge } from "@/components/assets/asset-template-badge";
import { EquipmentPhoto } from "@/components/assets/equipment-photo";
import { CompletenessBadge } from "@/components/assets/completeness-badge";
import { ASSET_POOLS_UI_VISIBLE } from "@/lib/asset-pools-visibility";
import { safeInventoryReturnTo } from "@/lib/inventory-navigation";
import {
  AssignDialog, ReturnDialog, MoveDialog, MaintDialog, StatusDialog, EditAssetDialog,
} from "@/components/assets/asset-detail-dialogs";
import {
  PanelSection, InfoGrid, Info, Movements, Maint, Assigns, RequestTracking, Attachments,
  FinancialPanel, OperationalLife,
} from "@/components/assets/asset-detail-sections";
import { QrCard, CustodyCard, LocationCard, SupplierWarrantyCard } from "@/components/assets/asset-detail-side";

// Ledger: أقسام الصفحة في تبويبات. المالية تظهر فقط لمن يرى المال اليوم (canSeeFinancial).
type Section = "overview" | "custody" | "maintenance" | "documents" | "financial";

export default function AssetDetailsPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const { role } = useSession();
  const { t, lang } = useAppPreferences();
  const { isVisible } = useFeatureExposure();
  const can = useCan();
  const recordWrite = can("asset.update");
  const custodyWrite = can("asset.assign");
  const moveWrite = can("asset.move");
  const maintenanceWrite = can("maintenance.manage");
  const documentWrite = canManageAssets(role);
  const write = recordWrite || custodyWrite || moveWrite || maintenanceWrite;
  const fin = canSeeFinancial(role);
  const costVis = canSeeMaintenanceCost(role);
  // إظهار تدريجي للإجراءات الثانوية (فوق شرط الدور write، لا بديلًا عنه):
  // تسليم/إرجاع/نقل من 30، تعديل/تغيير حالة من 40، فتح صيانة من 60، مستندات/تفاصيل إضافية من 50.
  const expAssign = isVisible("assets.details.assign");
  const expReturn = isVisible("assets.details.return");
  const expMove = isVisible("assets.details.move");
  const expEdit = isVisible("assets.details.edit");
  const expStatus = isVisible("assets.details.changeStatus");
  const expMaintCreate = isVisible("maintenance.create");
  const expDocs = isVisible("assets.documents");
  const expExtra = isVisible("assets.extraDetails");
  const anyActionVisible = expEdit || expAssign || expReturn || expMove || expMaintCreate || expStatus;
  const [asset, setAsset] = useState<any>(null);
  const [logs, setLogs] = useState<any>({ assignments: [], maintenance: [], movements: [], attachments: [] });
  const [reqHistory, setReqHistory] = useState<any[]>([]);
  const [lastMod, setLastMod] = useState<{ by: string | null; at: string; action: string } | null>(null);
  const [opts, setOpts] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [section, setSection] = useState<Section>("overview");
  const [toast, setToast] = useState<ToastState>(null);
  const [origin, setOrigin] = useState("");
  const [backHref, setBackHref] = useState("/assets");
  const [dialog, setDialog] = useState<null | "assign" | "return" | "move" | "maint" | "status" | "edit">(null);
  const [editMaint, setEditMaint] = useState<any | null>(null);
  const [deprRules, setDeprRules] = useState<DepreciationRule[]>([]);

  const load = useCallback(async () => {
    const [{ asset, error }, l, lm, rh] = await Promise.all([
      getAsset(id, fin),
      getAssetLogs(id, fin),
      getLastModifier("assets", id),
      getAssetRequestHistory(id),
    ]);
    if (error) setToast({ type: "error", message: t.assetDetail.loadError + error });
    setAsset(asset); setLogs(l); setLastMod(lm); setReqHistory(rh.rows); setLoading(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, fin]);

  useEffect(() => {
    setOrigin(window.location.origin);
    setBackHref(safeInventoryReturnTo(new URLSearchParams(window.location.search).get("returnTo")));
    load(); getFormOptions().then(setOpts);
    // قواعد الإهلاك: تُحمَّل لكل الأدوار — الحقول المالية (النِّسب) محجوبة تلقائيًا لغير المخوّلين،
    // بينما الحقول غير المالية (العمر الافتراضي) تكفي لعرض حالة «العمر التشغيلي» بلا أرقام.
    listDepreciationRules(fin).then(({ rows, lifecycleAvailable }) => {
      setDeprRules(lifecycleAvailable ? rows as DepreciationRule[] : []);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [load]);

  // ?action=assign|return|status|edit — روابط قوائم العمل تفتح الحوار المطلوب مباشرة
  // (نفس نمط ?m= في الصيانة). طبقة تسهيل فقط: الدور + RPC الخادم يحكمان التنفيذ.
  useEffect(() => {
    if (loading || !write) return;
    try {
      const a = new URLSearchParams(window.location.search).get("action");
      if (
        ((a === "assign" || a === "return") && custodyWrite)
        || (a === "status" && recordWrite)
        || (a === "edit" && recordWrite)
      ) {
        setDialog(a);
        window.history.replaceState({}, "", `/assets/${id}`);
      }
    } catch { /* غير حرج */ }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading, write, recordWrite, custodyWrite]);

  function refresh() { load(); }

  if (loading) {
    return (
      <div aria-busy="true" className="animate-pulse space-y-4">
        <div className="h-4 w-32 rounded bg-sunk" />
        <div className="h-9 w-72 rounded-lg bg-sunk" />
        <div className="grid grid-cols-1 gap-5 lg:grid-cols-[minmax(0,1fr)_340px]">
          <div className="h-96 rounded-card bg-sunk" />
          <div className="h-96 rounded-card bg-sunk" />
        </div>
      </div>
    );
  }
  if (!asset) {
    return (
      <Card>
        <EmptyState icon={PackageSearch} title={t.assetDetail.notFound}
          action={<Link href={backHref} className={buttonClass("outline", "sm")}>{t.assetForm.backToAssets}</Link>} />
      </Card>
    );
  }

  const L = t.assetDetail.ledger;
  const status: AssetStatus = asset.status;
  const nameOf = (o: any, ar = "name_ar", en = "name") => (lang === "en" ? (o?.[en] ?? o?.[ar]) : (o?.[ar] ?? o?.[en])) ?? null;
  const categoryName = nameOf(asset.category);
  const locationName = nameOf(asset.location);
  const modelName = asset.model ? `${asset.model.brand} ${asset.model.model_name}` : null;
  const title = asset.name ?? categoryName ?? asset.asset_tag;
  const subline = [categoryName, modelName, asset.company?.name, locationName].filter(Boolean).join(" · ");
  const completeness = expExtra ? computeCompleteness(asset, { canSeeFinancial: fin, canWrite: recordWrite }) : null;

  // تبويبات — إظهار تدريجي كما كان: الحركات من 20، الصيانة/العُهد من 30، المستندات/المرفقات من 50.
  const showMovements = isVisible("assets.details.movements" as FeatureKey);
  const showAssignments = isVisible("assets.details.assignments" as FeatureKey);
  // سجل الطلبات يظهر مع تبويب العُهد (نفس المستوى) — لا مفتاح إظهار جديد.
  const showRequests = showAssignments;
  const showMaint = isVisible("assets.details.maintenanceTab" as FeatureKey);
  const showDocs = expDocs;
  const tabItems: TabItem<Section>[] = [
    { key: "overview", label: L.tabs.overview },
    ...(showMovements || showAssignments || showRequests ? [{ key: "custody" as const, label: L.tabs.custody, count: showMovements ? logs.movements.length : undefined }] : []),
    ...(showMaint ? [{ key: "maintenance" as const, label: L.tabs.maintenance, count: logs.maintenance.length }] : []),
    ...(showDocs ? [{ key: "documents" as const, label: L.tabs.documents, count: logs.attachments.length }] : []),
    ...(fin ? [{ key: "financial" as const, label: L.tabs.financial }] : []),
  ];
  const active: Section = tabItems.some((x) => x.key === section) ? section : "overview";
  const canOpenMaint = maintenanceWrite && expMaintCreate;

  return (
    <div className="space-y-[18px]">
      <header className="flex flex-col gap-2">
        <Link href={backHref} className="inline-flex items-center gap-1.5 self-start text-[13px] text-muted hover:text-fg">
          <ArrowRight aria-hidden="true" className="h-4 w-4 ltr:rotate-180" />{t.assetForm.backToAssets}
        </Link>
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2.5">
              <span className="tag text-sm font-medium text-brand-ink">{asset.asset_tag}</span>
              <StatusBadge status={status} />
              <AssetTemplateBadge asset={asset} />
              {completeness && completeness.total > 0 && (
                <span className="inline-flex items-center gap-2 text-xs text-muted">
                  {L.completeness}<CompletenessBadge result={completeness} />
                </span>
              )}
            </div>
            <h1 className="mt-2 font-display text-[28px] font-semibold leading-tight tracking-tight text-fg sm:text-[32px] sm:leading-10">{title}</h1>
            {subline && <p className="mt-0.5 text-sm text-fg-2">{subline}</p>}
          </div>
          {write && anyActionVisible ? (
            <div role="group" aria-label={L.actionsLabel} className="page-header-actions flex flex-wrap items-center gap-2">
              {custodyWrite && expAssign && status === "available" && <Button data-action="asset-assign" onClick={() => setDialog("assign")}><UserPlus aria-hidden="true" className="h-4 w-4" />{t.assetDetail.assign}</Button>}
              {custodyWrite && expReturn && status === "reserved" && asset.assigned_to_employee_id && <Button onClick={() => setDialog("return")}><Undo2 aria-hidden="true" className="h-4 w-4" />{t.assetDetail.return}</Button>}
              {moveWrite && expMove && <Button variant="outline" onClick={() => setDialog("move")}><MoveRight aria-hidden="true" className="h-4 w-4 rtl:rotate-180" />{t.assetDetail.move}</Button>}
              {canOpenMaint && <Button variant="outline" onClick={() => setDialog("maint")}><Wrench aria-hidden="true" className="h-4 w-4" />{t.assetDetail.maintenance}</Button>}
              {recordWrite && expStatus && <Button variant="outline" onClick={() => setDialog("status")}><RefreshCw aria-hidden="true" className="h-4 w-4" />{t.assetDetail.changeStatus}</Button>}
              {recordWrite && expEdit && <Button variant="outline" onClick={() => setDialog("edit")}><Pencil aria-hidden="true" className="h-4 w-4" />{t.assetDetail.editData}</Button>}
            </div>
          ) : (
            <StatusChip tone="neu" dot={false}>{t.assetDetail.viewOnly}</StatusChip>
          )}
        </div>
      </header>

      <div className="grid grid-cols-1 items-start gap-5 lg:grid-cols-[minmax(0,1fr)_340px]">
        <Card className="min-w-0 overflow-hidden">
          <Tabs items={tabItems} value={active} onChange={setSection} label={L.tabsLabel} idBase="asset-sections" className="px-5" />

          <div role="tabpanel" id={panelId("asset-sections", active)} aria-labelledby={tabId("asset-sections", active)} tabIndex={0} className="focus-visible:outline-none">
            {active === "overview" && (
              <>
                <PanelSection
                  title={t.assetDetail.infoTitle}
                  meta={lastMod?.by ? interpolate(L.lastModified, { by: lastMod.by, date: formatDate(asset.updated_at, lang) }) : undefined}
                >
                  <InfoGrid>
                    {/* (I18N-2) اختيار عمود الاسم حسب اللغة النشطة بدل name_ar دائمًا — عرض فقط، لا ترجمة لبيانات القاعدة */}
                    <Info label={t.assetDetail.info.category} value={categoryName} />
                    <Info label={t.assetDetail.info.model} value={modelName} />
                    <Info label={t.companies.label} value={asset.company?.name} />
                    <Info label={t.assetDetail.info.department} value={nameOf(asset.department)} />
                    <Info label={t.assetDetail.info.conditionGrade} value={asset.condition_grade ? (t.condition[asset.condition_grade as keyof typeof t.condition] ?? asset.condition_grade) : null} />
                    <Info label={t.assetDetail.info.location} value={locationName} />
                    <Info label={t.assetDetail.info.holder} value={nameOf(asset.holder, "full_name_ar", "full_name")} />
                    <Info label={t.assetDetail.info.supplier} value={asset.supplier?.name_ar ?? asset.supplier?.name} />
                    {/* مجموعة الأصل — مُخفاة من الواجهة مؤقتًا (pool_id باقٍ في البيانات) */}
                    {ASSET_POOLS_UI_VISIBLE && <Info label={t.pools.field} value={asset.pool?.name_ar ?? asset.pool?.name} />}
                    <Info label={t.assetDetail.info.purchaseDate} value={asset.purchase_date ? <span className="tabular-nums">{formatDate(asset.purchase_date, lang)}</span> : null} />
                    {fin && <Info label={t.assetDetail.info.purchaseCost} value={<span className="tabular-nums">{formatSAR(asset.purchase_cost, lang)}</span>} />}
                    <Info label={t.assetDetail.info.warrantyEnd} value={asset.warranty_end ? <span className="tabular-nums">{formatDate(asset.warranty_end, lang)}</span> : null} />
                    <Info label={t.assetDetail.info.updatedAt} value={<span className="tabular-nums">{formatDate(asset.updated_at, lang)}</span>} />
                    {lastMod?.by && <Info label={t.assetDetail.info.lastModBy} value={lastMod.by} />}
                  </InfoGrid>
                  {asset.notes && <p className="mt-4 whitespace-pre-line rounded-xl bg-warn-soft px-3.5 py-2.5 text-[13px] text-warn">{asset.notes}</p>}
                </PanelSection>

                <PanelSection title={L.identityTitle}>
                  <InfoGrid>
                    <Info label={t.assetDetail.info.serial} value={asset.serial_number} mono />
                    <Info label={L.assetTag} value={asset.asset_tag} mono />
                    <Info label={t.assetDetail.qrTitle} value={asset.qr_token ? `/a/${asset.qr_token}` : null} mono />
                    <Info label={t.assetDetail.info.rfid} value={asset.rfid_tag || L.rfidNotRegistered} mono={Boolean(asset.rfid_tag)} muted={!asset.rfid_tag} />
                  </InfoGrid>
                </PanelSection>

                {/* تفاصيل إضافية حسب نوع الأصل — إظهار تدريجي من 50 */}
                {expExtra && (
                  <PanelSection>
                    <AssetExtraDetails asset={asset} canSeeFinancial={fin} canWrite={recordWrite} onEdit={() => setDialog("edit")} />
                  </PanelSection>
                )}

                {/* غير مالي: حالة العمر التشغيلي فقط — بلا أي قيمة مالية (المخوّل ماليًا يراها في تبويب المالية) */}
                {!fin && <OperationalLife asset={asset} deprRules={deprRules} t={t} lang={lang} />}
              </>
            )}

            {active === "custody" && (
              <>
                {showMovements && (
                  <PanelSection title={t.assetDetail.tabs.movements}>
                    <Movements rows={logs.movements} t={t} lang={lang} />
                  </PanelSection>
                )}
                {showAssignments && (
                  <PanelSection title={t.assetDetail.tabs.assignments}>
                    <Assigns rows={logs.assignments} t={t} lang={lang} />
                  </PanelSection>
                )}
                {showRequests && (
                  <PanelSection title={t.assetDetail.tracking.title}>
                    <RequestTracking asset={asset} rows={reqHistory} t={t} lang={lang} />
                  </PanelSection>
                )}
              </>
            )}

            {active === "maintenance" && (
              <PanelSection
                title={t.assetDetail.tabs.maintenance}
                actions={canOpenMaint ? <Button size="sm" variant="outline" onClick={() => setDialog("maint")}><Wrench aria-hidden="true" className="h-4 w-4" />{L.openMaintenance}</Button> : undefined}
              >
                <Maint rows={logs.maintenance} canWrite={maintenanceWrite && isVisible("maintenance.update")} canSeeCost={costVis} onEdit={setEditMaint} t={t} lang={lang} />
              </PanelSection>
            )}

            {active === "documents" && (
              <>
                {/* مستندات الأصل: صورة الجهاز + فاتورة الضمان + فاتورة الشراء (منفصلة عن الصيانة)
                    حجب الفواتير المالية داخلها يبقى بالدور (canSeeFinancial) كما هو */}
                <PanelSection>
                  <AssetDocuments assetId={id} attachments={logs.attachments} canWrite={documentWrite} canSeeFinancial={fin}
                    onChange={refresh} setToast={setToast} t={t} />
                  <p className="mt-3 text-xs text-muted">{L.docsNote}</p>
                </PanelSection>
                <PanelSection title={L.otherAttachments}>
                  <Attachments assetId={id} rows={logs.attachments} onChange={refresh} setToast={setToast} canWrite={documentWrite} t={t} lang={lang} />
                </PanelSection>
              </>
            )}

            {active === "financial" && fin && (
              <FinancialPanel asset={asset} deprRules={deprRules} t={t} lang={lang} />
            )}
          </div>
        </Card>

        <aside aria-label={t.assetDetail.infoTitle} className="flex min-w-0 flex-col gap-4">
          <EquipmentPhoto asset={asset} attachments={logs.attachments} size="stage" />
          <QrCard asset={asset} origin={origin} t={t} />
          <CustodyCard asset={asset} assignments={logs.assignments} t={t} lang={lang} />
          <LocationCard asset={asset} t={t} lang={lang} />
          <SupplierWarrantyCard asset={asset} t={t} lang={lang} />
        </aside>
      </div>

      {/* dialogs */}
      {opts && (
        <>
          <AssignDialog open={dialog==="assign"} onClose={() => setDialog(null)} assetId={id} fromStatus={status}
            employees={opts.employees} onDone={(m: ToastState)=>{ setToast(m); if (m?.type === "success") { setDialog(null); refresh(); } }} />
          <ReturnDialog open={dialog==="return"} onClose={() => setDialog(null)} assetId={id} fromStatus={status}
            onDone={(m: ToastState)=>{ setToast(m); if (m?.type === "success") { setDialog(null); refresh(); } }} />
          <MoveDialog open={dialog==="move"} onClose={() => setDialog(null)} assetId={id} fromLocation={asset.location_id}
            locations={opts.locations} departments={opts.departments} canCreate={recordWrite} setToast={setToast}
            onDone={(m: ToastState)=>{ setToast(m); if (m?.type === "success") { setDialog(null); refresh(); } }} />
          <MaintDialog open={dialog==="maint"} onClose={() => setDialog(null)} assetId={id} assetStatus={status}
            employees={opts.employees} suppliers={opts.suppliers} showCost={costVis} onDone={(m: SaveFeedback)=>{ setToast(m); if (m.persisted) { setDialog(null); refresh(); } }} />
          <StatusDialog open={dialog==="status"} onClose={() => setDialog(null)} assetId={id} fromStatus={status}
            onDone={(m: ToastState)=>{ setToast(m); if (m?.type === "success") { setDialog(null); refresh(); } }} />
          <EditAssetDialog open={dialog==="edit"} onClose={() => setDialog(null)} asset={asset} opts={opts} canCreate={recordWrite} canSeeFinancial={fin} setToast={setToast}
            onDone={(m: ToastState)=>{ setToast(m); if (m?.type === "success") { setDialog(null); refresh(); } }} />
        </>
      )}

      {/* نافذة إدارة الصيانة المشتركة — تعمل حتى قبل تحميل opts.
          إظهار تدريجي: نموذج التحديث من 60 (تُمرَّر canWrite=false تحته فتظهر النافذة للعرض فقط) */}
      <MaintenanceModal record={editMaint} canWrite={maintenanceWrite && isVisible("maintenance.update")} canSeeFinancial={fin} canSeeMaintenanceCost={costVis}
        onClose={() => setEditMaint(null)} onDone={(m: ToastState)=>{ setToast(m); if (m?.type === "success") { setEditMaint(null); refresh(); } }} />

      <Toast toast={toast} onDone={() => setToast(null)} />
    </div>
  );
}
