"use client";

import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, ClipboardList, MessageSquareReply, Plus, RefreshCw, Send, UserRound } from "lucide-react";
import { Card } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page-header";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { EmptyState } from "@/components/ui/empty-state";
import { StatusChip } from "@/components/ui/status-chip";
import { inputClass } from "@/components/ui/form";
import { Toast, type ToastState } from "@/components/ui/toast";
import { Spinner } from "@/components/ui/spinner";
import { StageProgress, stageAriaLabel } from "@/components/self-service/stage-progress";
import { EMPLOYEE_DONE_STATUSES, employeeRequestStage } from "@/components/self-service/request-stage";
import { useMediaQuery } from "@/components/self-service/use-media-query";
import { useAppPreferences } from "@/components/providers/app-preferences-provider";
import { useSession } from "@/lib/session";
import { formatDate } from "@/lib/format";
import { REQUEST_STATUS_TONE } from "@/lib/tone";
import {
  createMyEmployeeRequest,
  getMyEmployeeRequest,
  listMyEmployeeRequests,
  replyToMyRequest,
  type EmployeeRequestDetail,
  type EmployeeRequestSummary,
} from "@/lib/employee-self-service";
import {
  beginOperationalListRequest, cancelOperationalListRequest, completeOperationalListRequest,
  createOperationalListRequestGate, isCurrentOperationalListRequest,
} from "@/lib/operational-list-request-gate";

const initialForm = {
  projectName: "",
  description: "",
  category: "",
  quantity: 1,
  pickupDate: "",
  returnDate: "",
  notes: "",
};

type View = "active" | "done";

export default function MyRequestsPage() {
  const { t, lang } = useAppPreferences();
  const { role } = useSession();
  const copy = t.employeeSelfService;
  const [rows, setRows] = useState<EmployeeRequestSummary[]>([]);
  const [detail, setDetail] = useState<EmployeeRequestDetail | null>(null);
  const [form, setForm] = useState(initialForm);
  const [reply, setReply] = useState("");
  const [busy, setBusy] = useState(false);
  const [newOpen, setNewOpen] = useState(false);
  const [toast, setToast] = useState<ToastState>(null);
  const [descriptionError, setDescriptionError] = useState(false);
  const [view, setView] = useState<View>("active");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selection = useRef<string | null>(null);
  const [listLoading, setListLoading] = useState(true);
  const [listError, setListError] = useState(false);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState(false);
  const listGate = useRef(createOperationalListRequestGate());
  const detailGate = useRef(createOperationalListRequestGate());
  const descriptionRef = useRef<HTMLInputElement>(null);
  const wide = useMediaQuery("(min-width: 1024px)");
  // Stable close handler: the dialog focus trap re-runs whenever onClose changes identity.
  const closeNew = useCallback(() => { if (!busy) setNewOpen(false); }, [busy]);

  const loadDetail = useCallback(async (id: string) => {
    const gate = detailGate.current;
    const generation = beginOperationalListRequest(gate, true, false)!;
    setDetailLoading(true); setDetailError(false);
    try {
      const result = await getMyEmployeeRequest(id);
      if (!isCurrentOperationalListRequest(gate, generation) || selection.current !== id) return;
      if (result.error || result.detail?.ok !== true || result.detail.request?.id !== id) {
        setDetail(null); setDetailError(true);
      } else setDetail(result.detail);
    } catch {
      if (isCurrentOperationalListRequest(gate, generation) && selection.current === id) {
        setDetail(null); setDetailError(true);
      }
    } finally {
      if (completeOperationalListRequest(gate, generation)) setDetailLoading(false);
    }
  }, []);

  const reload = useCallback(async (selectId?: string) => {
    const gate = listGate.current;
    const generation = beginOperationalListRequest(gate, true, false)!;
    const selectedBefore = selection.current;
    setListLoading(true); setListError(false);
    try {
      const result = await listMyEmployeeRequests();
      if (!isCurrentOperationalListRequest(gate, generation)) return;
      if (result.error) { setListError(true); return; }
      setRows(result.rows);
      if (selectId) {
        selection.current = selectId;
        setSelectedId(selectId); setDetail(null); setReply("");
        void loadDetail(selectId);
      } else if (selectedBefore && selectedBefore === selection.current) void loadDetail(selectedBefore);
    } catch {
      if (isCurrentOperationalListRequest(gate, generation)) setListError(true);
    } finally {
      if (completeOperationalListRequest(gate, generation)) setListLoading(false);
    }
  }, [loadDetail]);

  useEffect(() => {
    const listRequests = listGate.current;
    const detailRequests = detailGate.current;
    if (role === "employee") void reload();
    return () => {
      cancelOperationalListRequest(listRequests);
      cancelOperationalListRequest(detailRequests);
    };
  }, [role, reload]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!form.description.trim()) {
      setDescriptionError(true);
      requestAnimationFrame(() => descriptionRef.current?.focus());
      return;
    }
    setDescriptionError(false);
    if (form.quantity < 1) return;
    setBusy(true);
    const result = await createMyEmployeeRequest(form);
    setBusy(false);
    if (result.error || result.data?.ok !== true) {
      setToast({ type: "error", message: copy.actionRejected });
      return;
    }
    setForm(initialForm);
    setNewOpen(false);
    setView("active");
    setToast({ type: "success", message: copy.requestCreated });
    await reload(result.data.id);
  }

  async function sendReply() {
    const id = detail?.request?.id;
    if (!id || !reply.trim()) return;
    setBusy(true);
    const result = await replyToMyRequest(id, reply);
    setBusy(false);
    if (result.error || result.data?.ok !== true) {
      setToast({ type: "error", message: copy.actionRejected });
      return;
    }
    setReply("");
    setToast({ type: "success", message: copy.replySent });
    await reload();
  }

  function toggleRow(id: string) {
    cancelOperationalListRequest(detailGate.current);
    setDetail(null); setDetailError(false); setReply("");
    const next = selection.current === id ? null : id;
    selection.current = next; setSelectedId(next);
    if (next) void loadDetail(next);
    else setDetailLoading(false);
  }

  const counts = useMemo(() => ({
    active: rows.filter((row) => !EMPLOYEE_DONE_STATUSES.has(row.status)).length,
    done: rows.filter((row) => EMPLOYEE_DONE_STATUSES.has(row.status)).length,
  }), [rows]);
  const visible = rows.filter((row) => (view === "done") === EMPLOYEE_DONE_STATUSES.has(row.status));

  if (role !== "employee") {
    return <Card><EmptyState icon={UserRound} title={copy.employeeOnly} /></Card>;
  }

  const date = (value: string | null | undefined) =>
    value ? formatDate(value, lang) : t.common.dash;
  const statusLabel = (value: string) => copyStatus(t, value);
  const stages: [string, string, string, string] = [copy.stageReview, copy.stagePreparing, copy.stageReady, copy.stageDelivered];
  const detailPanel = detailLoading ? (
    <div role="status" className="flex justify-center p-6"><Spinner label={t.common.loading} /></div>
  ) : detailError && selectedId ? (
    <div role="alert" className="space-y-3 p-4">
      <p className="text-sm text-bad">{copy.loadError}</p>
      <Button variant="outline" onClick={() => void loadDetail(selectedId)}>{t.reports.retry}</Button>
    </div>
  ) : detail?.request?.id === selectedId ? (
    <RequestDetailPanel
      detail={detail}
      reply={reply}
      onReply={setReply}
      onSend={() => void sendReply()}
      busy={busy}
      date={date}
      statusLabel={statusLabel}
      t={t}
      showHeader={wide}
    />
  ) : null;

  return (
    <div className="mx-auto max-w-6xl">
      <PageHeader
        title={copy.requestsTitle}
        description={copy.requestsSubtitle}
        actions={<>
          <Button variant="outline" disabled={listLoading} onClick={() => void reload()}>
            <RefreshCw aria-hidden="true" className="h-4 w-4" />
            {t.common.refresh}
          </Button>
          <Button onClick={() => setNewOpen(true)}>
            <Plus aria-hidden="true" className="h-4 w-4" />
            {copy.newRequest}
          </Button>
        </>}
      />

      <div className="mb-4 flex items-center justify-between gap-3">
        <div className="ui-seg" role="group" aria-label={copy.viewLabel}>
          {(["active", "done"] as const).map((key) => (
            <button key={key} type="button" aria-pressed={view === key} onClick={() => setView(key)} className="ui-seg-item">
              {key === "active" ? copy.viewActive : copy.viewDone}
              <span className="text-[11.5px] tabular-nums text-muted">{counts[key]}</span>
            </button>
          ))}
        </div>
      </div>

      {listError && <div role="alert" className="ui-surface mb-4 flex flex-wrap items-center justify-between gap-3 p-4">
        <p className="text-sm text-bad">{copy.loadError}</p>
        <Button variant="outline" disabled={listLoading} onClick={() => void reload()}>{t.reports.retry}</Button>
      </div>}

      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)] lg:items-start">
        <ul aria-label={view === "active" ? copy.viewActive : copy.viewDone} aria-busy={listLoading} className="flex min-w-0 flex-col gap-3">
          {listLoading && rows.length === 0 ? (
            <li role="status"><Card><Spinner label={t.common.loading} /></Card></li>
          ) : listError && rows.length === 0 ? null : visible.length === 0 ? (
            <li><Card><EmptyState compact icon={ClipboardList} title={rows.length === 0 ? copy.requestsEmpty : copy.listEmptyTitle} description={copy.listEmptyHint} /></Card></li>
          ) : visible.map((row) => {
            const stage = employeeRequestStage(row.status);
            const open = selectedId === row.id;
            return (
              <li key={row.id}>
                <article aria-label={row.request_number} className={`ui-surface flex flex-col gap-3 px-5 pb-3 pt-5 ${open ? "border-brand ring-1 ring-brand/15" : ""}`}>
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-mono text-[13px] font-medium text-brand-ink [unicode-bidi:isolate]" dir="ltr">{row.request_number}</span>
                    <StatusChip tone={REQUEST_STATUS_TONE[row.status]}>{statusLabel(row.status)}</StatusChip>
                  </div>
                  <div>
                    <h2 className="font-display text-lg font-semibold leading-snug text-fg">{row.project_name || copy.itemsCount.replace("{count}", String(row.item_count))}</h2>
                    <p className="mt-0.5 text-[12.5px] tabular-nums text-muted">
                      {copy.itemsCount.replace("{count}", String(row.item_count))}
                      {row.pickup_date && <> · {copy.pickupDate}: {date(row.pickup_date)}</>}
                    </p>
                  </div>
                  <StageProgress className="border-t border-line pt-4" stages={stages} model={stage} label={stageAriaLabel(copy.stageOf, copy.stageClosed, stages, stage.current)} />
                  <div className="flex items-center justify-between gap-2 border-t border-line pt-1">
                    <span className="text-[12.5px] tabular-nums text-muted">{date(row.created_at)}</span>
                    <Button variant="ghost" size="sm" aria-expanded={open} onClick={() => void toggleRow(row.id)} className="text-brand-ink">
                      {open ? copy.hideDetails : copy.showDetails}
                      <ChevronDown aria-hidden="true" className={`h-4 w-4 transition-transform ${open ? "rotate-180" : ""}`} />
                    </Button>
                  </div>
                  {open && !wide && detailPanel && <div className="border-t border-line pb-2 pt-3">{detailPanel}</div>}
                </article>
              </li>
            );
          })}
        </ul>

        {wide && (
          <div className="sticky top-4 min-w-0">
            {detailPanel ? (
              <Card className="p-5">{detailPanel}</Card>
            ) : (
              <Card><EmptyState icon={ClipboardList} title={copy.requestDetails} description={copy.selectRequest} /></Card>
            )}
          </div>
        )}
      </div>

      <Dialog
        open={newOpen}
        onClose={closeNew}
        title={copy.newRequest}
        description={copy.requestsSubtitle}
        size="xl"
        footer={<>
          <Button variant="outline" disabled={busy} onClick={() => setNewOpen(false)}>{t.common.cancel}</Button>
          <Button type="submit" form="employee-request-form" disabled={busy}>
            <Send aria-hidden="true" className="h-4 w-4" />
            {copy.submitRequest}
          </Button>
        </>}
      >
        <form id="employee-request-form" onSubmit={submit} className="grid gap-4 md:grid-cols-2">
          <Field label={copy.description} wide>
            <input
              ref={descriptionRef}
              id="employee-request-description"
              aria-invalid={descriptionError || undefined}
              aria-describedby={descriptionError ? "employee-request-description-error" : undefined}
              value={form.description}
              onChange={(event) => {
                setForm({ ...form, description: event.target.value });
                if (descriptionError) setDescriptionError(false);
              }}
              className={inputClass}
            />
            {descriptionError && (
              <p id="employee-request-description-error" role="alert" className="text-xs font-medium text-bad">
                {copy.description} {t.common.required}
              </p>
            )}
          </Field>
          <Field label={copy.category}>
            <input
              value={form.category}
              onChange={(event) => setForm({ ...form, category: event.target.value })}
              className={inputClass}
            />
          </Field>
          <Field label={copy.quantity}>
            <input
              required
              type="number"
              min={1}
              max={1000}
              value={form.quantity}
              onChange={(event) => setForm({ ...form, quantity: Number(event.target.value) })}
              className={`${inputClass} tabular-nums`}
              dir="ltr"
            />
          </Field>
          <Field label={copy.projectName} wide>
            <input
              value={form.projectName}
              onChange={(event) => setForm({ ...form, projectName: event.target.value })}
              className={inputClass}
            />
          </Field>
          <Field label={copy.pickupDate}>
            <input
              type="date"
              value={form.pickupDate}
              onChange={(event) => setForm({ ...form, pickupDate: event.target.value })}
              className={`${inputClass} tabular-nums`}
              dir="ltr"
            />
          </Field>
          <Field label={copy.returnDate}>
            <input
              type="date"
              value={form.returnDate}
              onChange={(event) => setForm({ ...form, returnDate: event.target.value })}
              className={`${inputClass} tabular-nums`}
              dir="ltr"
            />
          </Field>
          <Field label={copy.notes} wide>
            <textarea
              value={form.notes}
              onChange={(event) => setForm({ ...form, notes: event.target.value })}
              className={`${inputClass} min-h-20 resize-none`}
            />
          </Field>
        </form>
      </Dialog>
      <Toast toast={toast} onDone={() => setToast(null)} />
    </div>
  );
}

function RequestDetailPanel({ detail, reply, onReply, onSend, busy, date, statusLabel, t, showHeader }: {
  detail: EmployeeRequestDetail;
  reply: string;
  onReply: (value: string) => void;
  onSend: () => void;
  busy: boolean;
  date: (value: string | null | undefined) => string;
  statusLabel: (value: string) => string;
  t: ReturnType<typeof useAppPreferences>["t"];
  showHeader: boolean;
}) {
  const copy = t.employeeSelfService;
  const request = detail.request!;
  return (
    <div className="flex flex-col gap-4">
      {showHeader && (
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="min-w-0">
            <h2 className="font-display text-[17px] font-semibold text-fg">{copy.requestDetails}</h2>
            <p className="mt-0.5 font-mono text-[13px] text-fg-2 [unicode-bidi:isolate]" dir="ltr">{request.request_number}</p>
          </div>
          <StatusChip tone={REQUEST_STATUS_TONE[request.status]}>{statusLabel(request.status)}</StatusChip>
        </div>
      )}
      {request.status === "needs_clarification" && (
        <div className="rounded-xl bg-warn-soft p-3.5">
          <label htmlFor="employee-clarification" className="flex items-center gap-2 text-[13px] font-semibold text-warn">
            <MessageSquareReply aria-hidden="true" className="h-4 w-4" />
            {copy.clarification}
          </label>
          <textarea
            id="employee-clarification"
            value={reply}
            onChange={(event) => onReply(event.target.value)}
            placeholder={copy.clarificationPlaceholder}
            className={`${inputClass} mt-2 min-h-24 resize-none`}
          />
          <div className="mt-2 flex justify-end">
            <Button disabled={busy || !reply.trim()} onClick={onSend}>
              <Send aria-hidden="true" className="h-4 w-4" />
              {copy.sendReply}
            </Button>
          </div>
        </div>
      )}
      {!!detail.items?.length && (
        <ul className="overflow-hidden rounded-xl border border-line">
          {detail.items.map((item, index) => (
            <li key={item.id} className={`flex items-start justify-between gap-3 px-3.5 py-2.5 ${index > 0 ? "border-t border-line" : ""}`}>
              <div className="min-w-0">
                <p className="text-[13.5px] font-semibold text-fg">{item.requested_description}</p>
                {item.requested_category && <p className="mt-0.5 text-xs text-muted">{item.requested_category}</p>}
              </div>
              <span className="shrink-0 text-[13px] tabular-nums text-fg-2">{copy.quantity}: <b className="font-semibold text-fg">{item.quantity}</b></span>
            </li>
          ))}
        </ul>
      )}
      <div>
        <h3 className="mb-2 text-[13px] font-semibold text-fg-2">{copy.history}</h3>
        <ol className="relative flex flex-col gap-3 border-s border-line ps-4">
          {detail.events?.map((event, index) => (
            <li key={event.id} className="relative text-[13px]">
              <span aria-hidden="true" className={`absolute -start-[21px] top-1.5 h-2 w-2 rounded-full ${index === 0 ? "bg-brand" : "bg-line-strong"}`} />
              <div className="flex flex-wrap justify-between gap-x-3">
                <span className="font-medium text-fg">{eventLabel(t, event.event_type)}</span>
                <time className="text-xs tabular-nums text-muted">{date(event.created_at)}</time>
              </div>
              {event.message && <p className="mt-0.5 whitespace-pre-wrap text-fg-2">{event.message}</p>}
            </li>
          ))}
        </ol>
      </div>
    </div>
  );
}

function copyStatus(t: ReturnType<typeof useAppPreferences>["t"], value: string) {
  return (t.dailyTasks.status as Record<string, string>)[value] ?? value;
}

function eventLabel(t: ReturnType<typeof useAppPreferences>["t"], value: string) {
  const labels: Record<string, string> = {
    status_changed: t.dailyTasks.status.under_review,
    clarification_requested: t.dailyTasks.status.needs_clarification,
    clarification_reply: t.employeeSelfService.replySent,
    submitted: t.dailyTasks.status.under_review,
  };
  return labels[value] ?? t.employeeSelfService.status;
}

function Field({
  label,
  wide = false,
  children,
}: {
  label: string;
  wide?: boolean;
  children: React.ReactNode;
}) {
  return (
    <label className={`grid gap-1.5 text-[13px] font-medium text-fg-2 ${wide ? "md:col-span-2" : ""}`}>
      {label}
      {children}
    </label>
  );
}
