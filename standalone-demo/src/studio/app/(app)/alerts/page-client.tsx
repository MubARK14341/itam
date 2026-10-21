"use client";

// مركز الإجراءات (/alerts) — مركز قيادة للتنبيهات المتتبَّعة، لا بديل عن قوائم العمل:
// «معالجة الآن» يفتح القائمة/الحوار الصحيح، والحل يحدث في البيانات الأصلية فقط.
// الرقم الأساسي يبقى من البيانات الأصلية (auto_resolved عبر sync حصريًا — لا إخفاء يدوي).
// لا ماليات هنا إطلاقًا (metadata = label/count فقط، والقائمة البيضاء في الـRPC تضمنها).

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { Activity, AlertCircle, AlertTriangle, RefreshCw, CheckCircle2, Wrench, Download, UserRound, type LucideIcon } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/ui/page-header";
import { Dialog } from "@/components/ui/dialog";
import { Drawer } from "@/components/ui/drawer";
import { EmptyState } from "@/components/ui/empty-state";
import { StatusChip } from "@/components/ui/status-chip";
import { Spinner } from "@/components/ui/spinner";
import { Tabs, panelId, tabId } from "@/components/ui/tabs";
import { Field, Select, inputClass } from "@/components/ui/form";
import { Toast, type ToastState } from "@/components/ui/toast";
import { AlertDetail, AlertDetailEmpty, ALERT_SEVERITY_TONE, ALERT_STATUS_TONE } from "@/components/action-center/alert-detail";
import { useMediaQuery } from "@/components/action-center/use-media-query";
import { FeatureRoute } from "@/components/feature-gate";
import { useAppPreferences } from "@/components/providers/app-preferences-provider";
import { useSession, canManageActionCenter, canManageSettings } from "@/lib/session";
import { listRegistrationRequests, listUnsoundReturnedAssets, type RegistrationRequest } from "@/lib/queries";
import { UNSOUND_FOLLOWUP_DAYS } from "@/lib/alert-predicates";
import { dateKeyInTimeZone, formatDateTime } from "@/lib/format";
import { interpolate } from "@/lib/i18n";
import {
  syncActionAlerts, listActionAlertsPage, getActionAlertOperationalCounts,
  assignActionAlert, startActionAlert, addActionAlertNote,
  actionAlertUrl, resolveUserLabels,
  ACTION_ALERT_TYPE_KEYS, type ActionAlertInstance, type ActionAlertSeverity,
  type ActionAlertOperationalCounts,
} from "@/lib/action-center";
import { collectCursorPages, type DescTimeCursor } from "@/lib/pagination";
import { downloadCSV } from "@/lib/export";
import {
  beginOperationalListRequest,
  completeOperationalListRequest,
  createOperationalListRequestGate,
  isCurrentOperationalListRequest,
} from "@/lib/operational-list-request-gate";

type TabKey = "needsAction" | "inProgress" | "mine" | "resolved";

export default function ActionCenterPage() {
  const { role } = useSession();
  const { t, lang } = useAppPreferences();
  const ta = t.actionCenter;
  const write = canManageActionCenter(role);
  const isManager = canManageSettings(role);

  const [rows, setRows] = useState<ActionAlertInstance[]>([]);
  const [labels, setLabels] = useState<Map<string, string>>(new Map());
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [exportBusy, setExportBusy] = useState(false);
  const [cursor, setCursor] = useState<DescTimeCursor | null>(null);
  const [serverCounts, setServerCounts] = useState<ActionAlertOperationalCounts | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [tab, setTab] = useState<TabKey>("needsAction");
  const [typeFilter, setTypeFilter] = useState("");
  const [sevFilter, setSevFilter] = useState("");
  const [toast, setToast] = useState<ToastState>(null);
  const [noteFor, setNoteFor] = useState<ActionAlertInstance | null>(null);
  const [assignFor, setAssignFor] = useState<ActionAlertInstance | null>(null);
  const [users, setUsers] = useState<RegistrationRequest[]>([]);
  const [me, setMe] = useState<string | null>(null);
  const listRequestGate = useRef(createOperationalListRequestGate());
  const initialSyncPending = useRef(true);
  // أجهزة راجعة غير سليمة — عرض قراءة فقط (نُقل من صفحة مهام المستودع المُزالة). لا منطق جديد.
  const [unsound, setUnsound] = useState<any[]>([]);
  // عرض مقسّم: القائمة + لوحة تفاصيل (lg) أو درج جانبي على الشاشات الأصغر — عرض فقط.
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const isLg = useMediaQuery("(min-width: 1024px)");

  // The user id only filters the "mine" tab; its late arrival must not reload other tabs.
  const mineKey = tab === "mine" ? me : null;
  const rowsCountRef = useRef(0);
  rowsCountRef.current = rows.length;

  async function refresh(doSync: boolean, reset = true) {
    const generation = beginOperationalListRequest(listRequestGate.current, reset, cursor !== null);
    if (generation === null) return;
    if (doSync && write) {
      setSyncing(true);
      const err = await syncActionAlerts();
      setSyncing(false);
      if (!isCurrentOperationalListRequest(listRequestGate.current, generation)) return;
      if (err) setToast({ type: "error", message: ta.syncError + err });
    }
    // A background reconcile keeps the current list on screen instead of flashing the skeleton.
    if (reset) setLoading(!(doSync && rowsCountRef.current > 0)); else setLoadingMore(true);
    const page = await listActionAlertsPage({
      cursor: reset ? null : cursor,
      filters: {
        tab,
        type: typeFilter,
        severity: sevFilter as ActionAlertSeverity | "",
        assignedTo: me,
      },
    });
    const { rows, error } = page;
    if (!isCurrentOperationalListRequest(listRequestGate.current, generation)) return;
    const [pageLabels, countsResult] = await Promise.all([
      resolveUserLabels(rows.map((r) => r.assigned_to).filter(Boolean) as string[]),
      getActionAlertOperationalCounts(),
    ]);
    if (!completeOperationalListRequest(listRequestGate.current, generation)) return;
    if (error) setToast({ type: "error", message: ta.loadError + error });
    if (countsResult.error) setToast({ type: "error", message: ta.loadError + countsResult.error });
    setRows((previous) => reset ? rows : [...previous, ...rows]);
    setCursor(page.nextCursor);
    setLabels((previous) => new Map([...previous, ...pageLabels]));
    setServerCounts(countsResult.counts);
    setLoading(false); setLoadingMore(false);
  }

  useEffect(() => {
    import("@/lib/supabase/client").then(({ createClient }) =>
      createClient().auth.getUser().then(({ data }) => setMe(data.user?.id ?? null)));
    // قائمة المستخدمين للإسناد — للمدراء فقط (RPC مقيّد أصلًا)
    if (isManager) listRegistrationRequests("approved").then(({ rows }) => setUsers(rows));
    // أجهزة راجعة غير سليمة تحتاج صيانة — استعلام قائم كما هو (بلا تعديل).
    listUnsoundReturnedAssets().then(({ rows }) => setUnsound(rows));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const doSync = initialSyncPending.current && write;
    if (doSync) initialSyncPending.current = false;
    // Show the stored alert list immediately, then reconcile (sync) in the background and reload
    // once it lands — the page no longer waits for candidate building + sync before first paint.
    void refresh(false, true).then(() => { if (doSync) void refresh(true, true); });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, typeFilter, sevFilter, mineKey, write]);

  const todayISO = dateKeyInTimeZone();
  const summary = {
    needsAction: serverCounts?.needs_action ?? 0,
    highSev: serverCounts?.high_severity ?? 0,
    inProgress: serverCounts?.in_progress ?? 0,
    mine: serverCounts?.mine ?? 0,
    resolvedToday: serverCounts?.resolved_today ?? 0,
  };

  const filtered = useMemo(() => rows.filter((r) => {
    if (tab === "needsAction" && !(r.status === "open" || r.status === "reopened")) return false;
    if (tab === "inProgress" && r.status !== "in_progress") return false;
    if (tab === "mine" && !(r.assigned_to === me && r.status !== "auto_resolved")) return false;
    if (tab === "resolved" && r.status !== "auto_resolved") return false;
    if (typeFilter && r.alert_type !== typeFilter) return false;
    if (sevFilter && r.severity !== sevFilter) return false;
    return true;
  }), [rows, tab, typeFilter, sevFilter, me]);

  async function exportCsv() {
    if (exportBusy) return;
    setExportBusy(true);
    try {
    const result = await collectCursorPages<ActionAlertInstance, DescTimeCursor>((cursor) => listActionAlertsPage({
      cursor, pageSize: 250, filters: { tab, type: typeFilter, severity: sevFilter as ActionAlertSeverity | "", assignedTo: me },
    }));
    if (result.error) { setToast({ type: "error", message: ta.loadError + result.error }); return; }
    const exportLabels = await resolveUserLabels(result.rows.map(row => row.assigned_to).filter(Boolean) as string[], { requireComplete: true });
    downloadCSV("action-center.csv",
      [ta.csvType, ta.csvLabel, ta.csvSeverity, ta.csvStatus, ta.csvAssignee, ta.csvLastSeen, ta.csvCount],
      result.rows.map((r) => [
        ta.types[r.alert_type] ?? r.alert_type,
        r.metadata?.label ?? (r.metadata?.count != null ? String(r.metadata.count) : ""),
        ta.sev[r.severity], ta.statuses[r.status],
        r.assigned_to ? (exportLabels.get(r.assigned_to) ?? "") : "",
        r.last_seen_at, r.occurrence_count,
      ]));
    } catch (error) {
      setToast({ type: "error", message: ta.loadError + (error instanceof Error ? error.message : ta.loadError) });
    } finally { setExportBusy(false); }
  }

  async function act(fn: () => Promise<string | null>, okMsg: string) {
    const err = await fn();
    if (err) setToast({ type: "error", message: ta.actionError + err });
    else { setToast({ type: "success", message: okMsg }); refresh(false); }
  }

  const TABS: { key: TabKey; label: string; count: number }[] = [
    { key: "needsAction", label: ta.tabs.needsAction, count: summary.needsAction },
    { key: "inProgress", label: ta.tabs.inProgress, count: summary.inProgress },
    { key: "mine", label: ta.tabs.mine, count: summary.mine },
    { key: "resolved", label: ta.tabs.resolved, count: serverCounts?.resolved ?? 0 },
  ];

  const selected = filtered.find((r) => r.id === selectedId) ?? null;
  const hasFilters = typeFilter !== "" || sevFilter !== "";
  const detailProps = selected ? {
    alert: selected,
    assigneeLabel: selected.assigned_to ? (labels.get(selected.assigned_to) ?? null) : null,
    write, isManager, me,
    onStart: () => act(() => startActionAlert(selected.id), ta.started),
    onAssign: () => setAssignFor(selected),
    onAssignToMe: () => act(() => assignActionAlert(selected.id, me), ta.assignedToMe),
    onNote: () => setNoteFor(selected),
  } : null;

  return (
    <FeatureRoute feature="actionCenter.page">
    <div>
      <PageHeader title={ta.title} description={ta.subtitle} actions={<>
          <Button variant="outline" onClick={exportCsv} disabled={exportBusy || filtered.length === 0}>
            <Download aria-hidden="true" className="h-4 w-4" />{ta.exportCsv}
          </Button>
          {write && (
            <Button variant="outline" onClick={() => refresh(true)} disabled={syncing} aria-busy={syncing}>
              <RefreshCw aria-hidden="true" className={`h-4 w-4 ${syncing ? "animate-spin" : ""}`} />{syncing ? ta.syncing : ta.syncNow}
            </Button>
          )}
        </>} />

      {/* بطاقات الملخّص — شريط مؤشرات واحد (الأعداد من الخادم كما هي) */}
      <section aria-label={ta.summaryLabel} className="ui-surface mb-6 grid grid-cols-2 gap-3 overflow-hidden p-4 lg:grid-cols-5">
        <SummaryCell label={ta.summary.needsAction} value={summary.needsAction} danger={summary.needsAction > 0} icon={AlertCircle} />
        <SummaryCell label={ta.summary.highSeverity} value={summary.highSev} danger={summary.highSev > 0} icon={AlertTriangle} />
        <SummaryCell label={ta.summary.inProgress} value={summary.inProgress} icon={Activity} />
        <SummaryCell label={ta.summary.mine} value={summary.mine} icon={UserRound} />
        <SummaryCell label={ta.summary.resolvedToday} value={summary.resolvedToday} icon={CheckCircle2} className="col-span-2 lg:col-span-1" />
      </section>

      {/* تبويبات + فلاتر */}
      <Tabs items={TABS} value={tab} onChange={setTab} label={ta.title} idBase="action-center" className="mb-6" />

      <div role="group" aria-label={ta.filtersLabel} className="mb-6 flex flex-wrap items-center gap-4">
        <div className="w-full sm:w-60">
          <Select value={typeFilter} onChange={setTypeFilter} placeholder={ta.allTypes}
            options={ACTION_ALERT_TYPE_KEYS.map((k) => ({ value: k, label: ta.types[k] }))} />
        </div>
        <div className="w-full sm:w-48">
          <Select value={sevFilter} onChange={setSevFilter} placeholder={ta.allSeverities}
            options={(["critical", "high", "medium", "low"] as ActionAlertSeverity[]).map((s) => ({ value: s, label: ta.sev[s] }))} />
        </div>
        {hasFilters && (
          <Button variant="ghost" size="sm" onClick={() => { setTypeFilter(""); setSevFilter(""); }}>{ta.clearFilters}</Button>
        )}
      </div>

      <div className="grid min-w-0 gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(280px,320px)] lg:items-start">
        <section
          role="tabpanel"
          id={panelId("action-center", tab)}
          aria-labelledby={tabId("action-center", tab)}
          className="ui-surface min-w-0 overflow-hidden"
        >
          <div className="flex min-h-16 items-center justify-between gap-3 px-5 text-[12.5px] text-muted sm:px-6">
            <span className="tabular-nums">{loading ? ta.loading : interpolate(ta.shown, { n: filtered.length })}</span>
          </div>
          {loading ? (
            <div className="flex justify-center py-12"><Spinner label={ta.loading} /></div>
          ) : filtered.length === 0 ? (
            <EmptyState icon={CheckCircle2} title={ta.empty}
              action={hasFilters ? <Button variant="outline" size="sm" onClick={() => { setTypeFilter(""); setSevFilter(""); }}>{ta.clearFilters}</Button> : undefined} />
          ) : (
            <ul className="divide-y divide-line px-5 pb-5 sm:px-6 sm:pb-6">
              {filtered.map((r) => {
                const isSelected = r.id === selectedId;
                return (
                  <li key={r.id}>
                    <button
                      type="button"
                      onClick={() => setSelectedId(r.id)}
                      aria-current={isSelected ? "true" : undefined}
                      className={`grid w-full min-w-0 gap-x-3 gap-y-2 rounded-control px-3 py-5 text-start transition-colors sm:grid-cols-[5rem_minmax(0,1fr)] sm:items-start ${isSelected ? "bg-brand-soft" : "hover:bg-surface-2"}`}
                    >
                      <span><StatusChip tone={ALERT_SEVERITY_TONE[r.severity]}>{ta.sev[r.severity]}</StatusChip></span>
                      <span className="block min-w-0">
                        <span className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm font-semibold text-fg">
                          {ta.types[r.alert_type] ?? r.alert_type}
                          {r.metadata?.label && <span className="tag text-xs font-medium text-brand-ink" dir="ltr">{r.metadata.label}</span>}
                          {r.metadata?.count != null && <span className="ui-count" dir="ltr">{r.metadata.count}</span>}
                          {r.status !== "open" && <StatusChip tone={ALERT_STATUS_TONE[r.status]} size="sm">{ta.statuses[r.status]}</StatusChip>}
                          {r.occurrence_count > 1 && <span className="text-[11px] font-medium text-muted" dir="ltr">×{r.occurrence_count}</span>}
                        </span>
                        <span className="mt-0.5 block text-xs text-muted">
                          {ta.age}: <bdi dir="ltr" className="tabular-nums">{formatDateTime(r.first_seen_at, lang)}</bdi>
                          {r.metadata?.due_at && <> · {ta.due}: <bdi dir="ltr" className="tabular-nums">{formatDateTime(r.metadata.due_at, lang)}</bdi></>}
                          <> · {ta.lastSeen}: <bdi dir="ltr" className="tabular-nums">{formatDateTime(r.last_seen_at, lang)}</bdi></>
                        </span>
                      </span>
                      <span className="inline-flex min-w-0 items-center gap-1.5 text-xs text-fg-2 sm:col-start-2">
                        <UserRound aria-hidden="true" className="h-3.5 w-3.5 shrink-0 text-muted" />
                        <span className="sr-only">{ta.assignee}: </span>
                        {r.assigned_to ? (labels.get(r.assigned_to) ?? "—") : <span className="text-muted">{ta.unassigned}</span>}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </section>

        {isLg && (
          <aside aria-label={ta.detailsLabel} className="ui-surface sticky top-20 min-w-0 overflow-hidden">
            {detailProps ? <AlertDetail {...detailProps} /> : <AlertDetailEmpty />}
          </aside>
        )}
      </div>
      {cursor && (
        <div className="mt-4 flex justify-center">
          <Button variant="outline" disabled={syncing || loading || loadingMore} onClick={() => void refresh(false, false)}>
            {loadingMore ? ta.loading : t.reports.showMore}
          </Button>
        </div>
      )}

      {/* أجهزة راجعة غير سليمة تحتاج صيانة — قسم عرض فقط (متابعة على مستوى الجهاز، تستمر حتى الإصلاح).
          نُقل كما هو من صفحة مهام المستودع المُزالة: يستدعي listUnsoundReturnedAssets() ويُبقي الروابط إلى /assets/[id]. */}
      {unsound.length > 0 && (
        <Card className="mt-5 overflow-hidden">
          <div className="flex items-center justify-between gap-3 border-b border-line px-5 py-4">
            <div className="flex min-w-0 items-center gap-2">
              <Wrench aria-hidden="true" className="h-4 w-4 shrink-0 text-bad" />
              <h2 className="font-display text-[17px] font-semibold text-fg">{t.warehouse.buckets.unsoundDevices}</h2>
            </div>
            <StatusChip tone="bad"><span dir="ltr" className="tabular-nums">{unsound.length}</span> {t.warehouse.countUnit}</StatusChip>
          </div>
          <p className="px-5 pt-3 text-xs text-muted">{t.warehouse.followupNote}</p>
          <div className="mt-2 divide-y divide-line border-t border-line">
            {unsound.map((a) => {
              const d = a.last_return_at ? Math.floor((Date.now() - new Date(a.last_return_at).getTime()) / 864e5) : 0;
              const stale = d >= UNSOUND_FOLLOWUP_DAYS;
              return (
                <Link key={a.id} href={`/assets/${a.id}`}
                  className="flex items-center justify-between gap-3 px-5 py-3 transition-colors hover:bg-surface-2">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium text-fg">
                      <span className="tag" dir="ltr">{a.asset_tag ?? a.name ?? a.id}</span>
                      {a.serial_number && <span className="ms-2 font-mono text-xs text-muted" dir="ltr">SN: {a.serial_number}</span>}
                    </p>
                    <p className="mt-0.5 text-xs text-muted">
                      {(t.requests.cond as Record<string, string>)[a.last_return_condition] ?? a.last_return_condition}
                    </p>
                  </div>
                  {a.last_return_at && (
                    <StatusChip tone={stale ? "bad" : "neu"} size="sm" className="shrink-0">
                      <span dir="ltr" className="tabular-nums">{d}</span> {t.warehouse.daysAgo}
                    </StatusChip>
                  )}
                </Link>
              );
            })}
          </div>
        </Card>
      )}

      {/* على الشاشات الأصغر من lg: التفاصيل في درج جانبي (يُخفى مؤقتًا أثناء فتح نافذة الملاحظة/الإسناد) */}
      <Drawer
        open={!isLg && !!detailProps && !noteFor && !assignFor}
        onClose={() => setSelectedId(null)}
        title={selected ? (ta.types[selected.alert_type] ?? selected.alert_type) : ""}
        eyebrow={ta.detailsLabel}
      >
        {detailProps && <AlertDetail {...detailProps} showTitle={false} />}
      </Drawer>

      <NoteDialog alert={noteFor} onClose={() => setNoteFor(null)}
        onSave={(note) => { setNoteFor(null); act(() => addActionAlertNote(noteFor!.id, note), ta.noteSaved); }} />
      <AssignDialog alert={assignFor} users={users} onClose={() => setAssignFor(null)}
        onSave={(uid) => { setAssignFor(null); act(() => assignActionAlert(assignFor!.id, uid), ta.assigned); }} />

      <Toast toast={toast} onDone={() => setToast(null)} />
    </div>
    </FeatureRoute>
  );
}

function SummaryCell({ label, value, danger, icon: Icon, className = "" }: {
  label: string; value: number; danger?: boolean; icon: LucideIcon; className?: string;
}) {
  return (
    <div className={`flex min-w-0 items-center gap-3 px-2 py-2 sm:px-4 ${className}`}>
      <Icon aria-hidden="true" className={`h-5 w-5 shrink-0 ${danger ? "text-bad" : "text-muted"}`} strokeWidth={1.6} />
      <div className="min-w-0">
        <span className={`block font-display text-[28px] font-medium leading-9 tabular-nums ${danger ? "text-bad" : "text-fg"}`} dir="ltr">{value}</span>
        <span className="block truncate text-xs font-medium text-muted">{label}</span>
      </div>
    </div>
  );
}

function NoteDialog({ alert, onClose, onSave }: {
  alert: ActionAlertInstance | null; onClose: () => void; onSave: (note: string) => void;
}) {
  const { t } = useAppPreferences();
  const ta = t.actionCenter;
  const [note, setNote] = useState("");
  useEffect(() => { setNote(""); }, [alert]);
  if (!alert) return null;
  return (
    <Dialog open={!!alert} onClose={onClose} title={ta.noteTitle}
      footer={<>
        <Button variant="outline" onClick={onClose}>{t.common.cancel}</Button>
        <Button onClick={() => note.trim() && onSave(note.trim())} disabled={!note.trim()}>{t.common.save}</Button>
      </>}>
      <Field label={ta.noteLabel} required>
        <textarea className={`${inputClass} min-h-24 resize-none`} value={note} onChange={(e) => setNote(e.target.value)} />
      </Field>
      <p className="mt-2 text-xs text-muted">{ta.noteHint}</p>
    </Dialog>
  );
}

function AssignDialog({ alert, users, onClose, onSave }: {
  alert: ActionAlertInstance | null; users: RegistrationRequest[];
  onClose: () => void; onSave: (uid: string | null) => void;
}) {
  const { t } = useAppPreferences();
  const ta = t.actionCenter;
  const [uid, setUid] = useState("");
  useEffect(() => { setUid(alert?.assigned_to ?? ""); }, [alert]);
  if (!alert) return null;
  // المرشّحون للإسناد: المعتمدون بأدوار تشغيلية فقط
  const assignable = users.filter((u) =>
    u.approval_status === "approved" && ["admin", "it_manager", "technician"].includes(u.assigned_role ?? ""));
  return (
    <Dialog open={!!alert} onClose={onClose} title={ta.assignTitle}
      footer={<>
        <Button variant="outline" onClick={onClose}>{t.common.cancel}</Button>
        <Button onClick={() => onSave(uid || null)}>{t.common.save}</Button>
      </>}>
      <Field label={ta.assignLabel}>
        <select value={uid} onChange={(e) => setUid(e.target.value)} className={inputClass}>
          <option value="">{ta.unassigned}</option>
          {assignable.map((u) => (
            <option key={u.id} value={u.id}>{u.full_name ?? u.email}</option>
          ))}
        </select>
      </Field>
      <p className="mt-2 text-xs text-muted">{ta.assignHint}</p>
    </Dialog>
  );
}
