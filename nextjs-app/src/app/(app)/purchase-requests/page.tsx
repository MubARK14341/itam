"use client";

// طلبات الشراء (/purchase-requests) — تجهيز ومتابعة فقط (ليست ERP):
// المخزون لا يتحدّث من هنا أبدًا؛ «توريد» كل بند يفتح نافذة التوريد الموجودة
// (consumable_stock_move الذرّي)، و«الاستلام» هنا متابعة كميات عبر RPC.
// unit_cost مالي: يظهر ويُعدَّل للمصرح ماليًا فقط (admin/it_manager) —
// محمي في القاعدة بنمط HIGH-1 (grant أعمدة + RPC + trigger حارس).

import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { ShoppingCart, Download, ChevronDown, ArrowDownToLine, Info, Truck } from "lucide-react";
import { Button, buttonClass } from "@/components/ui/button";
import { Select, inputClass } from "@/components/ui/form";
import { PageHeader } from "@/components/ui/page-header";
import { EmptyState } from "@/components/ui/empty-state";
import { Spinner } from "@/components/ui/spinner";
import { Toast, type ToastState } from "@/components/ui/toast";
import { FeatureRoute } from "@/components/feature-gate";
import { useAppPreferences } from "@/components/providers/app-preferences-provider";
import { useSession, canManageSettings, canSeeFinancial, useCan } from "@/lib/session";
import { formatDate } from "@/lib/format";
import { interpolate } from "@/lib/i18n";
import { toneStyles, type Tone } from "@/lib/tone";
import { downloadCSV } from "@/lib/export";
import {
  listPurchaseRequestsPage, getPurchaseRequestItems, setPurchaseRequestStatus, receivePurchaseRequestItem,
  type PurchaseRequestRow, type PurchaseRequestItemRow, type PurchaseRequestStatus, type PurchaseRequestAction,
} from "@/lib/purchase-requests";
import type { DescTimeCursor } from "@/lib/pagination";
import { validateReceiptQuantity } from "@/lib/purchase-receiving";
import { idempotentOperationError } from "@/lib/idempotent-operation-error";
import { recoverCompletedOperations } from "@/lib/idempotent-operation";
import {
  beginOperationalListRequest,
  cancelOperationalListRequest,
  completeOperationalListRequest,
  createOperationalListRequestGate,
} from "@/lib/operational-list-request-gate";

const STATUS_KEYS: PurchaseRequestStatus[] = [
  "draft", "submitted", "approved", "ordered", "partially_received", "received", "cancelled",
];

// نبرات Ledger للحالات (نقطة + نص) — تحويل محلي عبر toneStyles.
const STATUS_TONE: Record<PurchaseRequestStatus, Tone> = {
  draft: "neu",
  submitted: "info",
  approved: "res",
  ordered: "warn",
  partially_received: "warn",
  received: "ok",
  cancelled: "neu",
};

const STATUS_STYLE: Record<PurchaseRequestStatus, string> = toneStyles(STATUS_TONE);

export default function PurchaseRequestsPage() {
  const { role, userId, approvalStatus, capabilities } = useSession();
  const { t, lang } = useAppPreferences();
  const tp = t.purchaseRequests;
  const can = useCan();
  const write = can("purchase.manage");
  const isManager = canManageSettings(role);
  const fin = canSeeFinancial(role);

  const [rows, setRows] = useState<PurchaseRequestRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [loadedListScope, setLoadedListScope] = useState<string | null>(null);
  const [cursor, setCursor] = useState<DescTimeCursor | null>(null);
  const [total, setTotal] = useState(0);
  const [statusFilter, setStatusFilter] = useState("");
  const [toast, setToast] = useState<ToastState>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [items, setItems] = useState<PurchaseRequestItemRow[]>([]);
  const [itemsLoading, setItemsLoading] = useState(false);
  const [itemsError, setItemsError] = useState<string | null>(null);
  const [loadedItemsScope, setLoadedItemsScope] = useState<string | null>(null);
  const [receiveQty, setReceiveQty] = useState<Record<string, string>>({});
  const [receiving, setReceiving] = useState<Record<string, boolean>>({});
  const receiptInFlight = useRef(new Set<string>());
  const receiptOperations = useRef(new Map<string, string>());
  const listRequestGate = useRef(createOperationalListRequestGate());
  const itemLoadGeneration = useRef(0);
  const openIdRef = useRef<string | null>(null);
  const initialOpenIntentPending = useRef(true);
  const initialActorRef = useRef(userId);
  const itemLoadController = useRef<AbortController | null>(null);
  const loadedItemsScopeRef = useRef<string | null>(null);
  const scope = `${userId ?? ""}|${role ?? ""}|${approvalStatus}|${[...capabilities].sort().join(",")}|${fin}`;
  const scopeRef = useRef(scope);
  scopeRef.current = scope;

  function itemsReadyFor(id: string) {
    return scopeRef.current === scope && openIdRef.current === id && !itemsLoading && itemsError === null
      && loadedItemsScopeRef.current === `${scope}|${id}` && loadedItemsScope === `${scope}|${id}`;
  }

  async function loadItems(id: string) {
    if (openIdRef.current !== id || scopeRef.current !== scope) return;
    itemLoadController.current?.abort();
    const controller = new AbortController();
    itemLoadController.current = controller;
    const generation = ++itemLoadGeneration.current;
    const current = () => !controller.signal.aborted && generation === itemLoadGeneration.current
      && openIdRef.current === id && scopeRef.current === scope;
    loadedItemsScopeRef.current = null;
    setItemsLoading(true);
    setItemsError(null); setLoadedItemsScope(null); setItems([]);
    const result = await getPurchaseRequestItems(id, fin, { signal: controller.signal });
    if (!current()) return;
    const recovered = result.error !== null ? [] : await recoverCompletedOperations("purchase_receipt", result.rows.map((item) => item.id));
    if (!current()) return;
    setItemsError(result.error);
    if (recovered.length) {
      for (const itemId of recovered) receiptOperations.current.delete(itemId);
      setReceiveQty((state) => Object.fromEntries(Object.entries(state).filter(([itemId]) => !recovered.includes(itemId))));
      setToast({ type: "success", message: t.common.operationPreviousCompleted });
    }
    setItems(result.error === null ? result.rows : []);
    loadedItemsScopeRef.current = result.error === null ? `${scope}|${id}` : null;
    setLoadedItemsScope(`${scope}|${id}`);
    setItemsLoading(false);
  }

  async function load(reset = true, applyInitialOpenIntent = false) {
    if (scopeRef.current !== scope) return;
    const generation = beginOperationalListRequest(listRequestGate.current, reset, cursor !== null);
    if (generation === null) return;
    if (reset) setLoading(true); else setLoadingMore(true);
    const page = await listPurchaseRequestsPage({
      cursor: reset ? null : cursor,
      status: statusFilter as PurchaseRequestStatus | "",
    });
    if (scopeRef.current !== scope) return;
    if (!completeOperationalListRequest(listRequestGate.current, generation)) return;
    const { rows, error } = page;
    if (error) setToast({ type: "error", message: tp.loadError + error });
    setRows((previous) => reset ? rows : [...previous, ...rows]);
    setCursor(page.nextCursor);
    if (page.total != null) setTotal(page.total);
    setLoadedListScope(scope);
    setLoading(false); setLoadingMore(false);
    // Apply the initial deep link once; a background receipt/header refresh must
    // not reopen a selection which the user has since changed or closed.
    if (applyInitialOpenIntent && initialOpenIntentPending.current && !error) {
      initialOpenIntentPending.current = false;
      const openParam = new URLSearchParams(window.location.search).get("open");
      if (openParam && rows.some((r) => r.id === openParam)) {
        openIdRef.current = openParam;
        setOpenId(openParam);
        await loadItems(openParam);
      }
    }
  }
  useEffect(() => {
    if (initialActorRef.current !== userId) {
      initialActorRef.current = userId;
      initialOpenIntentPending.current = true;
      openIdRef.current = null;
      ++itemLoadGeneration.current;
      itemLoadController.current?.abort();
      loadedItemsScopeRef.current = null;
      receiptOperations.current.clear();
      setOpenId(null); setItems([]); setItemsLoading(false);
      setItemsError(null); setLoadedItemsScope(null);
    }
    void load(true, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [statusFilter, scope]);
  useEffect(() => () => {
    cancelOperationalListRequest(listRequestGate.current);
    openIdRef.current = null;
    ++itemLoadGeneration.current;
    itemLoadController.current?.abort();
  }, []);
  useEffect(() => {
    const id = openIdRef.current;
    if (id) void loadItems(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope]);

  async function toggleOpen(id: string) {
    if (openIdRef.current === id) {
      openIdRef.current = null;
      ++itemLoadGeneration.current;
      itemLoadController.current?.abort();
      loadedItemsScopeRef.current = null;
      setOpenId(null); setItems([]); setItemsLoading(false);
      setItemsError(null); setLoadedItemsScope(null);
      return;
    }
    openIdRef.current = id;
    setOpenId(id); setReceiveQty({});
    await loadItems(id);
  }

  const filtered = useMemo(
    () => rows,
    [rows],
  );

  async function changeStatus(id: string, to: PurchaseRequestAction) {
    const err = await setPurchaseRequestStatus(id, to);
    if (err) setToast({ type: "error", message: tp.actionError + (tp.errors[err as keyof typeof tp.errors] ?? err) });
    else { setToast({ type: "success", message: tp.statusChanged }); load(); }
  }

  async function receive(itemId: string) {
    if (receiptInFlight.current.has(itemId)) return;
    const item = items.find((candidate) => candidate.id === itemId);
    if (!item || !write || !itemsReadyFor(item.purchase_request_id)) return;
    const validation = validateReceiptQuantity(
      receiveQty[itemId] ?? "",
      item.requested_quantity,
      item.received_quantity,
    );
    if (validation.error || validation.quantity === null) {
      const code = validation.error ?? "bad_qty";
      setToast({
        type: "error",
        message: tp.actionError + (tp.errors[code as keyof typeof tp.errors] ?? code),
      });
      return;
    }
    receiptInFlight.current.add(itemId);
    setReceiving((state) => ({ ...state, [itemId]: true }));
    const operationId = receiptOperations.current.get(itemId) ?? crypto.randomUUID();
    receiptOperations.current.set(itemId, operationId);
    try {
      const err = await receivePurchaseRequestItem(itemId, validation.quantity, operationId);
      if (scopeRef.current !== scope) return;
      if (err && err !== "operation_previous_completed") {
        setToast({ type: "error", message: idempotentOperationError(err, t.common) ? err : tp.actionError + (tp.errors[err as keyof typeof tp.errors] ?? err) });
      } else {
        receiptOperations.current.delete(itemId);
        setReceiveQty((state) => ({ ...state, [itemId]: "" }));
        setToast({ type: "success", message: err ? t.common.operationPreviousCompleted : tp.receivedSaved });
        await load();
        if (scopeRef.current === scope && openIdRef.current === item.purchase_request_id) {
          await loadItems(item.purchase_request_id);
        }
      }
    } finally {
      receiptInFlight.current.delete(itemId);
      setReceiving((state) => ({ ...state, [itemId]: false }));
    }
  }

  // CSV للطلب المفتوح — عمود التكلفة للمصرح ماليًا فقط (لا يصل للبيانات أصلًا لغيره).
  function exportPr(pr: PurchaseRequestRow) {
    if (!itemsReadyFor(pr.id) || items.some((item) => item.purchase_request_id !== pr.id)) return;
    const downloaded = downloadCSV(`${pr.request_number}.csv`,
      [tp.csvItem, tp.csvRequested, tp.csvReceived, ...(fin ? [tp.csvUnitCost] : [])],
      items.map((i) => [
        i.consumable?.name ?? i.description ?? "", i.requested_quantity, i.received_quantity,
        ...(fin ? [i.unit_cost ?? ""] : []),
      ]));
    if (!downloaded) setToast({ type: "error", message: t.reports.exportFailed });
  }

  // الانتقالات المتاحة حسب الحالة والدور (المرآة الأمامية لآلة الحالات في الخادم)
  function nextActions(r: PurchaseRequestRow): { to: PurchaseRequestAction; label: string; primary?: boolean }[] {
    const out: { to: PurchaseRequestAction; label: string; primary?: boolean }[] = [];
    if (!write) return out;
    if (r.status === "draft") out.push({ to: "submitted", label: tp.actions.submit, primary: true });
    if (r.status === "submitted" && isManager) out.push({ to: "approved", label: tp.actions.approve, primary: true });
    if (r.status === "approved" && isManager && !r.second_approved_by) {
      out.push({ to: "second_approved", label: tp.actions.secondApprove, primary: true });
    }
    if (r.status === "approved" && r.second_approved_by) {
      out.push({ to: "ordered", label: tp.actions.markOrdered, primary: true });
    }
    if (["draft", "submitted", "approved", "ordered"].includes(r.status) && (isManager || r.status === "draft")) {
      out.push({ to: "cancelled", label: tp.actions.cancel });
    }
    return out;
  }

  return (
    <FeatureRoute feature="purchaseRequests.page">
    <div className="space-y-5">
      <PageHeader
        title={tp.title}
        description={tp.subtitle}
        actions={(
          <Link href="/consumables?view=below_reorder" className={buttonClass("outline", "md")}>
            {tp.backToShortages}
          </Link>
        )}
      />

      <section aria-label={tp.listLabel} className="ui-surface min-w-0 overflow-hidden">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-line px-4 py-3">
          <div className="w-full sm:w-60">
            <Select value={statusFilter} onChange={setStatusFilter} placeholder={tp.allStatuses}
              options={STATUS_KEYS.map((s) => ({ value: s, label: tp.statuses[s] }))} />
          </div>
          {!loading && loadedListScope === scope && (
            <span className="inline-flex items-center gap-1.5 text-[13px] tabular-nums text-muted sm:ms-auto">
              <ShoppingCart aria-hidden="true" className="h-3.5 w-3.5" />
              <bdi dir="ltr">{interpolate(tp.shown, { shown: filtered.length, total })}</bdi>
            </span>
          )}
        </div>

        {loading || loadedListScope !== scope ? (
          <div className="flex justify-center py-14"><Spinner label={tp.loading} /></div>
        ) : filtered.length === 0 ? (
          <EmptyState icon={ShoppingCart} title={tp.empty} />
        ) : (
          <div tabIndex={0} className="overflow-x-auto">
            <table className="ui-table min-w-[44rem]">
              <thead>
                <tr>
                  <th scope="col">{tp.colNumber}</th>
                  <th scope="col">{tp.colSupplier}</th>
                  <th scope="col">{tp.colItems}</th>
                  <th scope="col">{tp.colCreated}</th>
                  <th scope="col">{tp.colStatus}</th>
                  <th scope="col" className="w-14"><span className="sr-only">{tp.colDetails}</span></th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((r) => {
                  const isOpen = openId === r.id;
                  const detailsId = `purchase-details-${r.id}`;
                  return (
                    <Fragment key={r.id}>
                      <tr aria-selected={isOpen}>
                        <td>
                          <button
                            type="button"
                            onClick={() => toggleOpen(r.id)}
                            aria-expanded={isOpen}
                            aria-controls={isOpen ? detailsId : undefined}
                            className="inline-flex min-h-11 items-center rounded-md text-start hover:underline md:min-h-9"
                          >
                            <span className="tag font-medium text-brand-ink" dir="ltr">{r.request_number}</span>
                          </button>
                        </td>
                        <td>
                          <span className="inline-flex items-center gap-1.5 text-fg-2">
                            <Truck aria-hidden="true" className="h-3.5 w-3.5 shrink-0 text-muted" />
                            {r.supplier ? (r.supplier.name_ar ?? r.supplier.name) : <span className="text-muted">{tp.noSupplier}</span>}
                          </span>
                        </td>
                        <td><span className="ui-count" dir="ltr">{r.item_count}</span></td>
                        <td className="whitespace-nowrap text-[13px] tabular-nums text-muted">{formatDate(r.created_at, lang)}</td>
                        <td>
                          <span className={`ui-chip ${STATUS_STYLE[r.status]}`}>
                            <span aria-hidden="true" className="ui-chip-dot" />{tp.statuses[r.status]}
                          </span>
                        </td>
                        <td className="text-end">
                          <button
                            type="button"
                            onClick={() => toggleOpen(r.id)}
                            aria-expanded={isOpen}
                            aria-label={interpolate(tp.toggleDetails, { n: r.request_number })}
                            className={buttonClass("ghost", "icon-sm")}
                          >
                            <ChevronDown aria-hidden="true" className={`h-4 w-4 transition-transform ${isOpen ? "rotate-180" : ""}`} />
                          </button>
                        </td>
                      </tr>

                      {isOpen && (
                        <tr>
                          <td colSpan={6} id={detailsId} className="h-auto bg-surface-2 px-5 py-5">
                            {itemsLoading || loadedItemsScope !== `${scope}|${r.id}` ? (
                              <div className="flex justify-center py-4"><Spinner label={tp.loading} /></div>
                            ) : itemsError !== null ? (
                              <div role="alert" className="flex flex-wrap items-center gap-3 py-3 text-bad">
                                <p>{tp.itemsLoadError}</p>
                                <Button size="sm" variant="outline" onClick={() => void loadItems(r.id)}>{t.reports.retry}</Button>
                              </div>
                            ) : (
                              <>
                                <div tabIndex={0} className="overflow-x-auto rounded-control border border-line bg-surface">
                                  <table className="w-full text-start text-[13px]">
                                    <thead>
                                      <tr>
                                        <th className="h-9 px-3 text-start font-semibold">{tp.csvItem}</th>
                                        <th className="h-9 px-3 text-start font-semibold">{tp.csvRequested}</th>
                                        <th className="h-9 px-3 text-start font-semibold">{tp.csvReceived}</th>
                                        {fin && <th className="h-9 px-3 text-start font-semibold">{tp.csvUnitCost}</th>}
                                        <th className="h-9 px-3"></th>
                                      </tr>
                                    </thead>
                                    <tbody className="divide-y divide-line">
                                      {items.map((i) => (
                                        <tr key={i.id}>
                                          <td className="h-auto border-b-0 px-3 py-2.5 font-medium text-fg">
                                            {i.consumable?.name ?? i.description ?? "—"}
                                            {!i.consumable && i.notes && <span className="block text-[11.5px] font-normal text-muted">{i.notes}</span>}
                                          </td>
                                          <td className="h-auto border-b-0 px-3 py-2.5 tabular-nums" dir="ltr">{i.requested_quantity}</td>
                                          <td className="h-auto border-b-0 px-3 py-2.5 tabular-nums" dir="ltr">
                                            <span className={i.received_quantity >= i.requested_quantity ? "font-semibold text-ok" : ""}>
                                              {i.received_quantity}
                                            </span>
                                          </td>
                                          {fin && <td className="h-auto border-b-0 px-3 py-2.5 tabular-nums" dir="ltr">{i.unit_cost ?? "—"}</td>}
                                          <td className="h-auto border-b-0 px-3 py-2.5">
                                            <div className="flex flex-wrap items-center justify-end gap-2">
                                              {write && itemsReadyFor(r.id) && ["ordered", "partially_received"].includes(r.status) && (
                                                <span className="inline-flex items-center gap-1.5">
                                                  <input
                                                    className={`${inputClass} w-20 text-center`} dir="ltr" inputMode="numeric"
                                                    placeholder={tp.qtyPlaceholder}
                                                    aria-label={`${tp.qtyPlaceholder} — ${i.consumable?.name ?? i.description ?? ""}`}
                                                    value={receiveQty[i.id] ?? ""}
                                                    disabled={receiving[i.id]}
                                                    onChange={(e) => setReceiveQty((p) => ({ ...p, [i.id]: e.target.value }))}
                                                  />
                                                  <Button size="sm" variant="outline" onClick={() => receive(i.id)} disabled={receiving[i.id] || !Number(receiveQty[i.id])}>
                                                    {receiving[i.id] ? t.common.saving : tp.receiveBtn}
                                                  </Button>
                                                </span>
                                              )}
                                              {write && i.consumable_id && (
                                                <Link
                                                  href={`/consumables/${i.consumable_id}?action=replenish`}
                                                  className={buttonClass("outline", "sm")}
                                                  title={tp.replenishHint}
                                                >
                                                  <ArrowDownToLine aria-hidden="true" className="h-3.5 w-3.5" />{t.consumables.supply}
                                                </Link>
                                              )}
                                            </div>
                                          </td>
                                        </tr>
                                      ))}
                                    </tbody>
                                  </table>
                                </div>
                                <div className="mt-3 flex flex-wrap items-center gap-2">
                                  {nextActions(r).map((a) => (
                                    <Button key={a.to} size="sm" variant={a.primary ? "primary" : a.to === "cancelled" ? "danger-ghost" : "outline"} onClick={() => changeStatus(r.id, a.to)}>
                                      {a.label}
                                    </Button>
                                  ))}
                                  <Button size="sm" variant="ghost" onClick={() => exportPr(r)} disabled={!itemsReadyFor(r.id) || items.length === 0}>
                                    <Download aria-hidden="true" className="h-3.5 w-3.5" />{tp.exportCsv}
                                  </Button>
                                </div>
                                {r.notes && <p className="mt-2 text-[13px] leading-6 text-fg-2">{r.notes}</p>}
                              </>
                            )}
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        <p className="flex items-start gap-2.5 border-t border-line bg-surface-2 px-4 py-3 text-[12.5px] leading-5 text-muted">
          <Info aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0" />{tp.stockNote}
        </p>
      </section>
      {cursor && loadedListScope === scope && (
        <div className="mt-4 flex justify-center">
          <Button variant="outline" disabled={loading || loadingMore} onClick={() => void load(false)}>
            {loadingMore ? tp.loading : t.reports.showMore}
          </Button>
        </div>
      )}

      <Toast toast={toast} onDone={() => setToast(null)} />
    </div>
    </FeatureRoute>
  );
}
