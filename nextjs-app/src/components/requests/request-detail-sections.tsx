"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Link2, ShoppingCart, PackageOpen, History, Truck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Select } from "@/components/ui/form";
import { StatusBadge } from "@/components/ui/badge";
import { StatusChip } from "@/components/ui/status-chip";
import { EmptyState } from "@/components/ui/empty-state";
import { useAppPreferences } from "@/components/providers/app-preferences-provider";
import { formatDate, formatDateTime, formatSAR } from "@/lib/format";
import { assetMatchesNeed } from "@/lib/request-options";
import type { Tone } from "@/lib/tone";
import type { Dict } from "@/lib/i18n";
import type {
  RequestRow, RequestItemRow, RequestEventRow, RequestFormData, RequestItemPurchaseLink,
  RequestAssetAllocation, DeliveryEvidence,
} from "@/lib/requests";

type Lang = "ar" | "en";

// ===== أجزاء عرض صفحة تفاصيل الطلب (بلا منطق أعمال — الحالة والإجراءات في الصفحة) =====

/** Definition row: muted term on the start side, value on the end side. */
export function DetailRow({ label, value, dir }: { label: string; value: React.ReactNode; dir?: "ltr" | "rtl" }) {
  return (
    <div className="grid gap-1 border-b border-line py-3 last:border-0">
      <dt className="text-xs text-muted">{label}</dt>
      <dd className="min-w-0 break-words font-medium text-fg" dir={dir}>{value}</dd>
    </div>
  );
}

/** Tone callout used for status notes (clarification, shortage, rejection…). */
export function Callout({ tone, icon, children }: { tone: Tone; icon?: React.ReactNode; children: React.ReactNode }) {
  const cls: Record<Tone, string> = {
    ok: "bg-ok-soft text-ok", res: "bg-res-soft text-res", warn: "bg-warn-soft text-warn",
    bad: "bg-bad-soft text-bad", info: "bg-brand-soft text-brand-ink", neu: "bg-sunk text-fg-2",
  };
  return (
    <div className={`flex items-start gap-2.5 rounded-control border border-line px-4 py-4 text-[13px] leading-6 ${cls[tone]}`}>
      {icon && <span aria-hidden="true" className="mt-1 shrink-0 [&>svg]:h-4 [&>svg]:w-4">{icon}</span>}
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}

// ----- Items -----
export function RequestItemsTable({
  items, allocations, purchaseLinks, fin, canWrite, canApprove, fulfillableState, busy, onFulfill, onConvert,
}: {
  items: RequestItemRow[];
  allocations: RequestAssetAllocation[];
  purchaseLinks: Record<string, RequestItemPurchaseLink>;
  fin: boolean;
  canWrite: boolean;
  canApprove: boolean;
  fulfillableState: boolean;
  busy: boolean;
  onFulfill: (it: RequestItemRow) => void;
  onConvert: (it: RequestItemRow) => void;
}) {
  const { t, lang } = useAppPreferences();
  const tr = t.requests;
  const tl = tr.ledger;
  const delivered = items.reduce((sum, it) => sum + (it.delivered_quantity ?? 0), 0);
  const returned = items.reduce((sum, it) => sum + (it.item_kind === "asset" ? it.returned_quantity ?? 0 : 0), 0);
  return (
    <>
      <div tabIndex={0} className="overflow-x-auto">
        <table className="ui-table">
          <caption className="sr-only">{tr.requestedItems}</caption>
          <thead>
            <tr>
              <th scope="col">{tr.requestedItems}</th>
              <th scope="col">{tr.status}</th>
              <th scope="col">{tr.quantity}</th>
              <th scope="col">{tr.deliveredCol}</th>
              <th scope="col">{tr.returnedCol}</th>
              {fin && <th scope="col">{tr.unitPrice}</th>}
              {fin && <th scope="col">{tr.lineTotal}</th>}
            </tr>
          </thead>
          <tbody>
            {items.length === 0 ? <tr><td colSpan={fin ? 7 : 5} className="!h-auto"><EmptyState compact icon={PackageOpen} title={tr.noItems} /></td></tr>
            : items.map((it) => {
              const isCustom = it.item_kind === "custom";
              const isPortalNeed = it.requested_kind !== "existing_asset";
              const canFulfill = canWrite && fulfillableState && it.delivered_quantity === 0;
              const selectedCount = allocations.filter((allocation) => allocation.request_item_id === it.id && ["selected", "prepared", "delivered"].includes(allocation.state)).length;
              const linkPr = purchaseLinks[it.id]; // بند مُحوَّل لطلب شراء (رابط للموظف فقط)
              const canConvert = canApprove && fulfillableState && isCustom && it.delivered_quantity === 0 && !linkPr;
              const label = isCustom
                ? (it.requested_description || it.requested_category || tr.requestedNeed)
                : it.item_kind === "asset"
                  ? `${it.asset?.asset_tag ?? it.asset?.name ?? "—"}${it.asset?.name && it.asset?.asset_tag ? ` · ${it.asset.name}` : ""}`
                  : `${it.consumable?.name ?? "—"}${it.consumable?.sku ? ` · ${it.consumable.sku}` : ""}`;
              const href = !isCustom ? (it.item_kind === "asset" && it.asset_id ? `/assets/${it.asset_id}` : it.consumable_id ? `/consumables/${it.consumable_id}` : null) : null;
              const pref = [it.preferred_company?.name, it.preferred_model].filter(Boolean).join(" · ");
              return (
                <tr key={it.id}>
                  <td className="min-w-[240px] !py-3">
                    {href ? <Link href={href} className="font-semibold text-brand-ink hover:underline">{label}</Link> : <span className="font-semibold text-fg">{label}</span>}
                    {isPortalNeed && (
                      <div className="mt-0.5 space-y-0.5 text-xs text-muted">
                        {isCustom && it.requested_category && <div>{tr.requestedNeed}: {it.requested_category}</div>}
                        {pref && <div>{tr.preferredBrand}: {pref}</div>}
                        <div>{tr.acceptAlternative}: {it.accept_alternative ? tr.yesLabel : tr.noLabel}</div>
                      </div>
                    )}
                    {isCustom ? (
                      linkPr ? (
                        // رابط داخلي لطلب الشراء — للموظفين فقط (البوابة لا تراه إطلاقًا)
                        <Link href={`/purchase-requests?open=${linkPr.pr_id}`} className="mt-1.5 inline-flex items-center gap-1 text-xs font-medium text-brand-ink hover:underline">
                          <ShoppingCart aria-hidden="true" className="h-3.5 w-3.5" />{tr.viewPurchaseRequest}{linkPr.request_number ? <> · <bdi dir="ltr" className="font-mono">{linkPr.request_number}</bdi></> : ""}
                        </Link>
                      ) : (canFulfill || canConvert) ? (
                        <span className="mt-2 flex flex-wrap gap-1.5">
                          {canFulfill && <Button type="button" variant="outline" size="sm" onClick={() => onFulfill(it)} disabled={busy}><Link2 aria-hidden="true" />{it.requested_kind === "existing_asset" ? tr.selectDevice : tr.linkInventory}</Button>}
                          {canConvert && <Button type="button" variant="ghost" size="sm" onClick={() => onConvert(it)} disabled={busy}><ShoppingCart aria-hidden="true" />{tr.convertToPr}</Button>}
                        </span>
                      ) : null
                    ) : null}
                    {it.requested_kind === "existing_asset" && <div className="mt-1 text-xs font-medium tabular-nums text-fg-2">{tr.selectedDevices.replace("{selected}", String(selectedCount)).replace("{required}", String(it.quantity))}</div>}
                  </td>
                  <td>
                    {isCustom
                      ? (linkPr
                          ? <StatusChip tone="warn" size="sm">{tr.purchasingBadge}</StatusChip>
                          : it.needs_purchase
                          ? <StatusChip tone="warn" size="sm">{tr.needsPurchaseBadge}</StatusChip>
                          : <StatusChip tone="neu" size="sm">{tr.unfulfilledBadge}</StatusChip>)
                      : it.item_kind === "asset" && it.asset ? <StatusBadge status={it.asset.status} />
                      : <span className="text-xs text-muted">{tr.inStock}: <span className="tabular-nums">{it.consumable?.quantity_on_hand ?? "—"}</span></span>}
                  </td>
                  <td className="tabular-nums text-fg-2">{it.quantity}</td>
                  <td className="tabular-nums text-fg-2">{it.delivered_quantity}</td>
                  <td className="tabular-nums text-fg-2">{it.item_kind === "asset" ? it.returned_quantity : "—"}</td>
                  {fin && <td className="whitespace-nowrap tabular-nums text-fg-2">{it.unit_price != null ? formatSAR(it.unit_price, lang) : "—"}</td>}
                  {fin && <td className="whitespace-nowrap tabular-nums text-fg-2">{it.total_price != null ? formatSAR(it.total_price, lang) : "—"}</td>}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {items.length > 0 && (
        <p className="border-t border-line bg-surface-2 px-5 py-2.5 text-[13px] tabular-nums text-muted">
          {tl.itemsTotals.replace("{lines}", String(items.length)).replace("{delivered}", String(delivered)).replace("{returned}", String(returned))}
        </p>
      )}
    </>
  );
}

// ----- Delivery & returns -----
const ALLOCATION_TONE: Record<RequestAssetAllocation["state"], Tone> = {
  selected: "info", prepared: "res", delivered: "neu", returned: "ok", released: "neu",
};

export function RequestDeliveryPanel({
  request, evidence, deliveredByLabel, receivingOrganization, provisionedCount, allocations, isEmployeeReq, beneficiaryName, overdue,
}: {
  request: RequestRow;
  evidence: DeliveryEvidence | null;
  deliveredByLabel: string | null;
  receivingOrganization: string;
  provisionedCount: number;
  allocations: RequestAssetAllocation[];
  isEmployeeReq: boolean;
  beneficiaryName: string | null;
  overdue: boolean;
}) {
  const { t, lang } = useAppPreferences();
  const tr = t.requests;
  const tl = tr.ledger;
  const r = request;
  const dateDir = lang === "ar" ? "rtl" : "ltr";
  return (
    <div className="space-y-5 p-5">
      {evidence && r.delivered_at ? (
        <section aria-labelledby="request-delivered-summary" className="rounded-xl bg-ok-soft p-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 id="request-delivered-summary" className="text-sm font-semibold text-fg">{tr.deliveredSummaryTitle}</h3>
            <StatusChip tone="ok" size="sm">{t.requestStatus.delivered}</StatusChip>
          </div>
          <dl className="mt-2 grid grid-cols-1 gap-x-6 text-[13.5px] sm:grid-cols-2">
            <DetailRow label={tr.deliveredSummaryRecipient} value={evidence.receiver_name} />
            <DetailRow label={tr.deliveredSummaryOrganization} value={receivingOrganization} />
            <DetailRow label={tr.deliveredSummaryTime} value={<span className="tabular-nums">{formatDateTime(evidence.acknowledged_at ?? r.delivered_at, lang)}</span>} dir={dateDir} />
            <DetailRow label={tr.deliveredSummaryBy} value={deliveredByLabel ?? tr.staffMember} />
            <DetailRow label={tr.deliveredSummaryCount} value={<span className="tabular-nums">{String(evidence.device_snapshot?.length ?? provisionedCount)}</span>} />
          </dl>
        </section>
      ) : !r.delivered_at ? (
        <EmptyState compact icon={Truck} title={tl.deliveryNotYet} description={tl.deliveryNotYetHint} />
      ) : null}

      {/* طلب موظف مُسلَّم: العهدة سُجّلت على الموظف المستفيد (asset_assignments) */}
      {isEmployeeReq && r.delivered_at && (
        <Callout tone="ok">{tr.custodyRecordedFor}: <span className="font-semibold">{beneficiaryName ?? "—"}</span></Callout>
      )}

      <section aria-labelledby="request-dates-title">
        <h3 id="request-dates-title" className="mb-1 text-sm font-semibold text-fg">{tl.datesTitle}</h3>
        <dl className="grid grid-cols-1 gap-x-6 text-[13.5px] sm:grid-cols-2">
          <DetailRow label={isEmployeeReq ? tr.needDate : tr.pickupDate} value={<span className="tabular-nums">{r.pickup_date ? formatDate(r.pickup_date, lang) : "—"}</span>} dir={dateDir} />
          <DetailRow label={tr.returnDate} value={<span className={`tabular-nums ${overdue ? "font-semibold text-bad" : ""}`}>{r.return_date ? formatDate(r.return_date, lang) : "—"}{overdue ? ` · ${tr.overdueBadge}` : ""}</span>} dir={dateDir} />
          <DetailRow label={tr.deliveredAt} value={<span className="tabular-nums">{r.delivered_at ? formatDateTime(r.delivered_at, lang) : "—"}</span>} dir={dateDir} />
          <DetailRow label={tr.returnedAt} value={<span className="tabular-nums">{r.returned_at ? formatDateTime(r.returned_at, lang) : "—"}</span>} dir={dateDir} />
        </dl>
      </section>

      <section aria-labelledby="request-allocations-title">
        <h3 id="request-allocations-title" className="mb-2 text-sm font-semibold text-fg">{tl.allocationsTitle}</h3>
        {allocations.length === 0 ? (
          <p className="rounded-xl border border-dashed border-line-strong px-4 py-4 text-center text-[13px] text-muted">{tl.allocationsEmpty}</p>
        ) : (
          <ul className="divide-y divide-line rounded-xl border border-line">
            {allocations.map((allocation) => (
              <li key={`${allocation.request_item_id}-${allocation.asset_id}`} className="flex items-center gap-3 px-4 py-2.5">
                <div className="min-w-0 flex-1">
                  <Link href={`/assets/${allocation.asset_id}`} className="font-mono text-[13px] font-medium text-brand-ink hover:underline" dir="ltr">
                    {allocation.asset_tag ?? tr.unknownAssetTag}
                  </Link>
                  <p className="truncate text-xs text-muted">{[allocation.name ?? allocation.model ?? tr.unnamedAsset, allocation.location].filter(Boolean).join(" · ")}</p>
                </div>
                <StatusChip tone={ALLOCATION_TONE[allocation.state]} size="sm">{tl.allocationState[allocation.state]}</StatusChip>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

// ----- History -----
export function RequestHistory({ request, events }: { request: RequestRow; events: RequestEventRow[] }) {
  const { t, lang } = useAppPreferences();
  const tr = t.requests;
  return (
    <div className="p-5">
      <ol className="space-y-0">
        {/* حدث مركّب دائم (قد يسبق نظام السجل) ثم أحداث request_events الحقيقية */}
        <TimelineEvent label={tr.tl.created} at={request.created_at} lang={lang} on last={events.length === 0} />
        {events.map((e, index) => {
          const to = (e.metadata as Record<string, unknown>)?.to as string | undefined;
          const danger = e.event_type === "rejected" || (e.event_type === "status_changed" && (to === "rejected" || to === "cancelled"));
          const label = e.event_type === "status_changed" && to
            ? ((t.requestStatus as Record<string, string>)[to] ?? to)
            : ((tr.ev as Record<string, string>)[e.event_type] ?? e.event_type);
          const actor = e.actor_kind === "staff" ? tr.actorStaff : e.actor_kind === "portal" ? tr.actorPortal : null;
          return <TimelineEvent key={e.id} label={label} at={e.created_at} lang={lang} message={e.message} danger={danger} on={!danger} actor={actor} last={index === events.length - 1} />;
        })}
      </ol>
      {events.length === 0 && (
        <p className="mt-3 flex items-center gap-2 text-[13px] text-muted"><History aria-hidden="true" className="h-4 w-4" />{tr.noEvents}</p>
      )}
    </div>
  );
}

function TimelineEvent({ label, at, lang, on, danger, message, actor, last }: {
  label: string; at: string; lang: Lang; on?: boolean; danger?: boolean; message?: string | null; actor?: string | null; last?: boolean;
}) {
  return (
    <li className="relative flex gap-3 pb-4 last:pb-0">
      {!last && <span aria-hidden="true" className="absolute start-[4px] top-4 h-[calc(100%-8px)] w-px bg-line" />}
      <span aria-hidden="true" className={`relative mt-1.5 h-2.5 w-2.5 shrink-0 rounded-full ring-4 ring-surface ${danger ? "bg-bad" : on ? "bg-brand" : "bg-line-strong"}`} />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <p className="text-[13.5px] font-medium text-fg">{label}</p>
          {actor && <span className="inline-flex h-5 items-center rounded-md bg-sunk px-1.5 text-[11px] font-semibold text-fg-2">{actor}</span>}
        </div>
        {message && <p className="mt-0.5 whitespace-pre-wrap text-[13px] text-fg-2">{message}</p>}
        <p className="text-xs tabular-nums text-muted" dir={lang === "ar" ? "rtl" : "ltr"}>{formatDateTime(at, lang)}</p>
      </div>
    </li>
  );
}

// حوار ربط عنصر احتياج (custom) بمخزون حقيقي — هنا فقط تظهر الأجهزة الفردية
// (asset_tag/serial/الحالة/الموقع — شاشة موظفين). القائمة الافتراضية مفلترة على مطابقة
// الاحتياج (التصنيف/الشركة/الموديل) والحالة القابلة للتسليم، مع مفتاح «عرض كل الأصول»
// لأن المطابقة نصية على labels وقد تفوّت اختلاف تسمية.
export function FulfillDialog({ target, formData, tr, t, busy, onClose, onConfirm }: {
  target: RequestItemRow | null;
  formData: RequestFormData | null;
  tr: Dict["requests"]; t: Dict; busy: boolean;
  onClose: () => void;
  onConfirm: (ref: { assetId?: string; consumableId?: string }) => void;
}) {
  const [kind, setKind] = useState<"asset" | "consumable">("asset");
  const [assetId, setAssetId] = useState("");
  const [consumableId, setConsumableId] = useState("");
  const [showAll, setShowAll] = useState(false);
  useEffect(() => {
    if (target) {
      setKind(target.requested_kind === "consumable" ? "consumable" : "asset");
      setAssetId(""); setConsumableId(""); setShowAll(false);
    }
  }, [target]);
  const isDurableNeed = target?.requested_kind === "existing_asset";
  const deliverable = (formData?.assets ?? []).filter((a) => a.status === "available");
  const matching = target
    ? deliverable.filter((a) => assetMatchesNeed(a, {
        requested_category: target.requested_category,
        preferred_company_id: target.preferred_company_id,
        preferred_model: target.preferred_model,
      }))
    : deliverable;
  // إن لم يطابق شيء نعرض الكل مباشرة حتى لا يعلق الموظف
  const assets = showAll || matching.length === 0 ? deliverable : matching;
  const consumables = formData?.consumables ?? [];
  const canConfirm = kind === "asset" ? !!assetId : !!consumableId;
  const assetLabel = (a: NonNullable<RequestFormData["assets"]>[number]) => {
    const loc = a.location ? (a.location.name_ar ?? a.location.name) : null;
    return [
      a.asset_tag ?? a.name ?? a.id,
      a.serial_number ? `SN: ${a.serial_number}` : null,
      (t.status as Record<string, string>)[a.status] ?? a.status,
      loc,
    ].filter(Boolean).join(" · ");
  };
  return (
    <Dialog open={!!target} onClose={onClose} title={isDurableNeed ? tr.selectDevice : tr.linkInventoryTitle}
      footer={<><Button variant="outline" onClick={onClose}>{t.common.cancel}</Button><Button disabled={busy || !canConfirm} onClick={() => onConfirm(kind === "asset" ? { assetId } : { consumableId })}>{isDurableNeed ? tr.selectDevice : tr.linkInventory}</Button></>}>
      <div className="space-y-3">
        {target?.requested_description && (
          <p className="rounded-xl bg-sunk px-3 py-2.5 text-[13px] text-fg-2">
            {tr.requestedNeed}: <span className="font-semibold text-fg">{target.requested_description}</span>
          </p>
        )}
        {!isDurableNeed && (
          <div role="group" aria-label={tr.linkInventoryTitle} className="ui-seg w-full">
            <button type="button" aria-pressed={kind === "asset"} onClick={() => setKind("asset")} className="ui-seg-item flex-1 justify-center">{tr.linkAssetOption}</button>
            <button type="button" aria-pressed={kind === "consumable"} onClick={() => setKind("consumable")} className="ui-seg-item flex-1 justify-center">{tr.linkConsumableOption}</button>
          </div>
        )}
        {kind === "asset" ? (
          <>
            <Select value={assetId} onChange={setAssetId} placeholder={tr.chooseAsset}
              options={assets.map((a) => ({ value: a.id, label: assetLabel(a) }))} />
            <div className="flex items-center justify-between gap-2">
              <p className="text-xs tabular-nums text-muted">
                {showAll || matching.length === 0 ? tr.showingAllAssets : `${tr.matchingAssets}: ${matching.length}`}
              </p>
              {matching.length > 0 && (
                <Button type="button" variant="ghost" size="sm" onClick={() => { setShowAll((v) => !v); setAssetId(""); }} className="text-brand-ink">
                  {showAll ? tr.showMatchingOnly : tr.showAllAssets}
                </Button>
              )}
            </div>
          </>
        ) : (
          <Select value={consumableId} onChange={setConsumableId} placeholder={tr.chooseConsumable} options={consumables.map((c) => ({ value: c.id, label: `${c.name}${c.sku ? ` · ${c.sku}` : ""} (${c.quantity_on_hand})` }))} />
        )}
      </div>
    </Dialog>
  );
}
