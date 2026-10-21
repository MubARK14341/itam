"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { AlertTriangle, CheckCircle2, ChevronLeft, ClipboardList, Clock, PackageCheck, Plus, RotateCcw } from "lucide-react";
import { Card } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page-header";
import { Dialog } from "@/components/ui/dialog";
import { Button, buttonClass } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { KpiBand } from "@/components/ui/kpi-band";
import { Spinner } from "@/components/ui/spinner";
import { StatusChip } from "@/components/ui/status-chip";
import { inputClass } from "@/components/ui/form";
import { Toast, type ToastState } from "@/components/ui/toast";
import { useAppPreferences } from "@/components/providers/app-preferences-provider";
import { useSession } from "@/lib/session";
import { formatDate } from "@/lib/format";
import type { Tone } from "@/lib/tone";
import {
  listMyEmployeeAssets,
  listMyEmployeeRequests,
  listMyEmployeeReturnRequests,
  listWarehouseEmployeeReturnQueue,
  receiveWarehouseEmployeeReturn,
  type EmployeeAsset,
  type EmployeeRequestSummary,
  type EmployeeReturnRequest,
  type WarehouseReturnIntake,
} from "@/lib/employee-self-service";
import { listRequests, type RequestListRow } from "@/lib/requests";

type Task = {
  id: string;
  title: string;
  reference: string;
  reason: string;
  due: string | null;
  href: string;
  action: "request" | "asset" | "prepare" | "deliver" | "return" | "maintenance";
  urgency: "urgent" | "today" | "soon" | "completed";
};

const DAY = 24 * 60 * 60 * 1000;
const today = () => new Date().toISOString().slice(0, 10);
const daysUntil = (value: string | null) => value ? Math.ceil((Date.parse(value) - Date.parse(today())) / DAY) : null;

// Presentation only: chip tone and due-line colour per urgency group.
const URGENCY_TONE: Record<Task["urgency"], Tone> = { urgent: "bad", today: "warn", soon: "info", completed: "ok" };
const DUE_TEXT: Record<Task["urgency"], string> = { urgent: "text-bad", today: "text-warn", soon: "text-muted", completed: "text-muted" };

export default function MyTasksPage() {
  const { role } = useSession();
  const { t, lang } = useAppPreferences();
  const copy = t.dailyTasks;
  const [tasks, setTasks] = useState<Task[]>([]);
  const [loading, setLoading] = useState(true);
  const [returns, setReturns] = useState<WarehouseReturnIntake[]>([]);
  const [intake, setIntake] = useState<WarehouseReturnIntake | null>(null);
  const [condition, setCondition] = useState<"sound" | "needs_inspection">("sound");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<ToastState>(null);
  // Stable close handler: the dialog focus trap re-runs whenever onClose changes identity.
  const closeIntake = useCallback(() => { if (!busy) setIntake(null); }, [busy]);

  useEffect(() => {
    let live = true;
    async function load() {
      setLoading(true);
      if (role === "employee") {
        const [requests, assets, returns] = await Promise.all([
          listMyEmployeeRequests(), listMyEmployeeAssets(), listMyEmployeeReturnRequests(),
        ]);
        if (live) setTasks(employeeTasks(requests.rows, assets.rows, returns.rows, copy.status));
      } else if (role === "technician" || role === "warehouse_manager") {
        const [requests, queue] = await Promise.all([
          listRequests({ includeFinancial: false }),
          listWarehouseEmployeeReturnQueue(),
        ]);
        if (live) { setTasks(warehouseTasks(requests.rows, copy.status)); setReturns(queue.rows); }
      } else if (live) {
        setTasks([]);
      }
      if (live) setLoading(false);
    }
    void load();
    return () => { live = false; };
  }, [role, copy.status]);

  const groups = useMemo(() => ({
    urgent: tasks.filter((task) => task.urgency === "urgent"),
    today: tasks.filter((task) => task.urgency === "today"),
    soon: tasks.filter((task) => task.urgency === "soon"),
    completed: tasks.filter((task) => task.urgency === "completed"),
  }), [tasks]);

  async function completeIntake() {
    if (!intake || (condition === "needs_inspection" && !note.trim())) return;
    setBusy(true);
    const result = await receiveWarehouseEmployeeReturn(intake.id, condition, note);
    setBusy(false);
    if (result.error || result.data?.ok !== true) { setToast({ type: "error", message: t.employeeSelfService.actionRejected }); return; }
    const refreshed = await listWarehouseEmployeeReturnQueue();
    setReturns(refreshed.rows);
    setIntake(null); setNote(""); setToast({ type: "success", message: copy.intakeDone });
  }

  const actionLabel = (task: Task) =>
    task.action === "asset" ? copy.openAsset : task.action === "prepare" ? copy.prepare : task.action === "deliver" ? copy.deliver : task.action === "return" ? copy.receiveReturn : task.action === "maintenance" ? copy.maintenance : copy.openRequest;
  const isEmployee = role === "employee";
  const isWarehouse = role === "technician" || role === "warehouse_manager";

  return (
    <div className="mx-auto max-w-6xl">
      <PageHeader eyebrow={<span className="tabular-nums">{formatDate(today(), lang)}</span>} title={copy.title} description={copy.subtitle} />
      {loading ? (
        <Card className="flex justify-center p-10"><Spinner label={t.common.loading} /></Card>
      ) : (
        <div className="space-y-6">
          {tasks.length > 0 && (
            <KpiBand
              label={copy.summaryLabel}
              items={[
                { key: "urgent", label: copy.urgent, value: groups.urgent.length, tone: groups.urgent.length ? "bad" : undefined },
                { key: "today", label: copy.today, value: groups.today.length, tone: groups.today.length ? "warn" : undefined },
                { key: "soon", label: copy.soon, value: groups.soon.length },
                { key: "completed", label: copy.completed, value: groups.completed.length, tone: groups.completed.length ? "ok" : undefined },
              ]}
            />
          )}

          <div className={`grid gap-5 ${isEmployee ? "lg:grid-cols-[minmax(0,1fr)_280px]" : ""}`}>
            <div className="min-w-0 space-y-6">
              <TaskSection id="tasks-urgent" title={copy.urgent} tasks={groups.urgent} icon={PackageCheck} lang={lang} dueLabel={copy.due} actionLabel={actionLabel} />
              <TaskSection id="tasks-today" title={copy.today} tasks={groups.today} icon={ClipboardList} lang={lang} dueLabel={copy.due} actionLabel={actionLabel} />
              <TaskSection id="tasks-soon" title={copy.soon} tasks={groups.soon} icon={RotateCcw} lang={lang} dueLabel={copy.due} actionLabel={actionLabel} />
              <TaskSection id="tasks-completed" title={copy.completed} tasks={groups.completed} icon={CheckCircle2} lang={lang} dueLabel={copy.due} actionLabel={actionLabel} completed />

              {isWarehouse && returns.length > 0 && (
                <section aria-labelledby="tasks-return-queue" className="ui-surface overflow-hidden">
                  <SectionHeader id="tasks-return-queue" title={copy.returnQueue} icon={RotateCcw} count={returns.length} />
                  <ul className="grid md:grid-cols-2">
                    {returns.map((item) => (
                      <li key={item.id} className="flex min-w-0 flex-col gap-2 border-t border-line px-4 py-3.5 md:odd:border-e">
                        <p className="font-semibold text-fg">{item.asset_name ?? item.asset_tag}</p>
                        {item.asset_tag && <p className="tag font-mono text-xs text-fg-2" dir="ltr">{item.asset_tag}</p>}
                        <p className="text-[13px] text-fg-2">{item.employee_name} · {item.reason}</p>
                        <div className="flex items-center justify-between gap-2">
                          <span className="text-xs tabular-nums text-muted">{formatDate(item.requested_at, lang)}</span>
                          <Button size="sm" onClick={() => { setIntake(item); setCondition("sound"); setNote(""); }}>{copy.intake}</Button>
                        </div>
                      </li>
                    ))}
                  </ul>
                </section>
              )}

              {tasks.length === 0 && returns.length === 0 && (
                <Card><EmptyState icon={CheckCircle2} title={copy.empty} /></Card>
              )}
            </div>

            {isEmployee && (
              <aside aria-labelledby="tasks-quick-actions" className="min-w-0">
                <h2 id="tasks-quick-actions" className="mb-2 font-display text-[15px] font-semibold text-fg">{copy.quickActions}</h2>
                <div className="grid grid-cols-2 gap-2.5 lg:grid-cols-1">
                  <Link href="/my-requests" className="ui-surface flex min-h-[112px] flex-col items-start gap-1.5 p-3.5 transition-colors hover:bg-surface-2">
                    <span className="inline-flex h-9 w-9 items-center justify-center rounded-[11px] bg-brand-soft text-brand-ink"><Plus aria-hidden="true" className="h-[18px] w-[18px]" /></span>
                    <span className="text-[14.5px] font-semibold text-fg">{t.employeeSelfService.newRequest}</span>
                    <span className="text-xs leading-relaxed text-muted">{copy.newRequestHint}</span>
                  </Link>
                  <Link href="/my-assets" className="ui-surface flex min-h-[112px] flex-col items-start gap-1.5 p-3.5 transition-colors hover:bg-surface-2">
                    <span className="inline-flex h-9 w-9 items-center justify-center rounded-[11px] bg-warn-soft text-warn"><AlertTriangle aria-hidden="true" className="h-[18px] w-[18px]" /></span>
                    <span className="text-[14.5px] font-semibold text-fg">{copy.reportIssue}</span>
                    <span className="text-xs leading-relaxed text-muted">{copy.reportIssueHint}</span>
                  </Link>
                </div>
                <Link href="/my-requests" className="mt-2.5 inline-flex min-h-11 items-center gap-1 text-[13px] font-semibold text-brand-ink hover:underline">
                  {copy.allRequests}<ChevronLeft aria-hidden="true" className="h-4 w-4 ltr:rotate-180" />
                </Link>
              </aside>
            )}
          </div>
        </div>
      )}
      <Dialog
        open={!!intake}
        onClose={closeIntake}
        title={copy.confirmIntake}
        description={intake?.asset_name ?? intake?.asset_tag ?? undefined}
        footer={<>
          <Button variant="outline" disabled={busy} onClick={() => setIntake(null)}>{t.common.cancel}</Button>
          <Button disabled={busy || (condition !== "sound" && !note.trim())} onClick={() => void completeIntake()}>{copy.intake}</Button>
        </>}
      >
        <fieldset className="grid gap-2">
          {(["sound", "needs_inspection"] as const).map((value) => (
            <label key={value} className={`flex min-h-11 cursor-pointer items-center gap-2.5 rounded-control border px-3 text-[13.5px] ${condition === value ? "border-brand bg-brand-soft text-fg" : "border-line-strong text-fg-2"}`}>
              <input type="radio" checked={condition === value} onChange={() => setCondition(value)} className="h-4 w-4 accent-[rgb(var(--brand))]" />
              <span>{value === "sound" ? copy.returnSound : copy.returnMaintenance}</span>
            </label>
          ))}
        </fieldset>
        <label className="mt-4 block">
          <span className="ui-label">{copy.intakeNote}</span>
          <textarea value={note} onChange={(event) => setNote(event.target.value)} className={`${inputClass} min-h-20 resize-none`} />
        </label>
      </Dialog>
      <Toast toast={toast} onDone={() => setToast(null)} />
    </div>
  );
}

function SectionHeader({ id, title, icon: Icon, count }: { id: string; title: string; icon: typeof ClipboardList; count: number }) {
  return (
    <div className="flex items-center justify-between gap-3 px-4 py-3 sm:px-5">
      <h2 id={id} className="flex items-center gap-2 font-display text-[17px] font-semibold text-fg">
        <Icon aria-hidden="true" className="h-4 w-4 text-muted" />{title}
      </h2>
      <span className="ui-count">{count}</span>
    </div>
  );
}

function TaskSection({ id, title, tasks, icon, completed = false, lang, dueLabel, actionLabel }: {
  id: string; title: string; tasks: Task[]; icon: typeof ClipboardList; completed?: boolean;
  lang: "ar" | "en"; dueLabel: string; actionLabel: (task: Task) => string;
}) {
  if (!tasks.length) return null;
  return (
    <section aria-labelledby={id} className="space-y-3">
      <SectionHeader id={id} title={title} icon={icon} count={tasks.length} />
      <ul className="grid gap-3 md:grid-cols-2">
        {tasks.map((task) => (
          <li key={task.id} className={`ui-surface flex min-w-0 flex-col justify-between gap-4 px-5 py-5 ${completed ? "bg-surface-2" : ""}`}>
            <div className="min-w-0">
              <p className={`font-display text-[17px] font-semibold leading-snug ${completed ? "text-fg-2" : "text-fg"}`}>{task.title}</p>
              <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1">
                <span className="font-mono text-xs text-fg-2 [unicode-bidi:isolate]" dir="ltr">{task.reference}</span>
                {task.reason !== task.title && <StatusChip tone={URGENCY_TONE[task.urgency]} size="sm">{task.reason}</StatusChip>}
              </div>
            </div>
            <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-3 border-t border-line pt-4">
              {task.due ? (
                <span className={`inline-flex items-center gap-1.5 text-[12.5px] tabular-nums ${DUE_TEXT[task.urgency]}`}>
                  <Clock aria-hidden="true" className="h-3.5 w-3.5" />{dueLabel}: {formatDate(task.due, lang)}
                </span>
              ) : <span />}
              {!completed && (
                <Link href={task.href} className={buttonClass("outline", "sm", "min-h-11 shrink-0")}>
                  {actionLabel(task)}<ChevronLeft aria-hidden="true" className="h-4 w-4 ltr:rotate-180" />
                </Link>
              )}
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}

function employeeTasks(rows: EmployeeRequestSummary[], assets: EmployeeAsset[], returns: EmployeeReturnRequest[], labels: Record<string, string>): Task[] {
  const result: Task[] = [];
  for (const request of rows) {
    const due = request.pickup_date ?? request.return_date;
    const urgency = request.status === "needs_clarification" || (due && daysUntil(due)! < 0) ? "urgent" : request.status === "ready_for_pickup" || daysUntil(due) === 0 ? "today" : "soon";
    if (["needs_clarification", "ready_for_pickup", "under_review", "preparing", "approved"].includes(request.status)) result.push({
      id: `request:${request.id}`, title: labels[request.status] ?? request.status, reference: request.request_number,
      reason: request.status === "needs_clarification" ? labels.needs_clarification : request.status === "ready_for_pickup" ? labels.ready_for_pickup : labels.under_review,
      due, href: "/my-requests", action: "request", urgency,
    });
    if (["completed", "cancelled", "rejected"].includes(request.status) && request.updated_at.slice(0, 10) === today()) result.push({
      id: `done:${request.id}`, title: labels[request.status] ?? request.status, reference: request.request_number, reason: labels[request.status] ?? request.status,
      due: request.updated_at, href: "/my-requests", action: "request", urgency: "completed",
    });
  }
  for (const asset of assets) {
    const days = daysUntil(asset.due_return_date);
    if (days !== null && days <= 7) result.push({
      id: `asset:${asset.asset_id}`, title: labels.pending, reference: asset.asset_tag ?? asset.name ?? "—",
      reason: days < 0 ? labels.overdue : labels.pending, due: asset.due_return_date, href: "/my-assets", action: "asset", urgency: days < 0 ? "urgent" : days === 0 ? "today" : "soon",
    });
  }
  for (const item of returns.filter((row) => row.status === "pending" || row.status === "acknowledged")) result.push({
    id: `return:${item.id}`, title: labels[item.status] ?? item.status, reference: item.asset_tag ?? item.asset_name ?? "—", reason: labels[item.status] ?? item.status,
    due: item.requested_at, href: "/my-assets", action: "asset", urgency: "today",
  });
  return result.sort(taskOrder);
}

function warehouseTasks(rows: RequestListRow[], labels: Record<string, string>): Task[] {
  const result = rows.flatMap((request): Task[] => {
    const status = request.status;
    const action = status === "ready_for_pickup" ? "deliver" : status === "delivered" || status === "partially_returned" || status === "overdue" ? "return" : "prepare";
    if (!["approved", "auto_provisioning", "provisioned", "stock_shortage", "preparing", "ready_for_pickup", "delivered", "partially_returned", "overdue", "returned"].includes(status)) return [];
    const due = status === "ready_for_pickup" ? request.pickup_date : request.return_date;
    return [{ id: request.id, title: labels[status] ?? status, reference: request.request_number, reason: labels[status] ?? status, due, href: `/requests/${request.id}`, action, urgency: status === "overdue" || (due && daysUntil(due)! < 0) ? "urgent" : due && daysUntil(due) === 0 ? "today" : "soon" }];
  });
  return result.sort(taskOrder);
}

function taskOrder(a: Task, b: Task) {
  const rank = { urgent: 0, today: 1, soon: 2, completed: 3 };
  return rank[a.urgency] - rank[b.urgency] || (a.due ?? "9999").localeCompare(b.due ?? "9999");
}
