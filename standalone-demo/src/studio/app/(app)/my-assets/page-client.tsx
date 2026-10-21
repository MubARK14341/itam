"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { AlertTriangle, ChevronLeft, Info as InfoIcon, PackageOpen, Plus, RefreshCw, RotateCcw, UserRound } from "lucide-react";
import { EquipmentPhoto } from "@/components/assets/equipment-photo";
import { Card } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page-header";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { EmptyState } from "@/components/ui/empty-state";
import { StatusChip } from "@/components/ui/status-chip";
import { inputClass } from "@/components/ui/form";
import { Toast, type ToastState } from "@/components/ui/toast";
import { useAppPreferences } from "@/components/providers/app-preferences-provider";
import { useSession } from "@/lib/session";
import { formatDate } from "@/lib/format";
import type { Tone } from "@/lib/tone";
import {
  listMyEmployeeAssets,
  listMyEmployeeReturnRequests,
  reportMyAssetIssue,
  requestMyAssetReturn,
  type EmployeeAsset,
  type EmployeeReturnRequest,
} from "@/lib/employee-self-service";

// Presentation only: chip tone of an employee return request status.
const RETURN_TONE: Record<string, Tone> = { pending: "warn", acknowledged: "info", completed: "ok", rejected: "neu" };

export default function MyAssetsPage() {
  const { t, lang } = useAppPreferences();
  const { role } = useSession();
  const copy = t.employeeSelfService;
  const [assets, setAssets] = useState<EmployeeAsset[]>([]);
  const [returns, setReturns] = useState<EmployeeReturnRequest[]>([]);
  const [issueAsset, setIssueAsset] = useState<string | null>(null);
  const [returnAsset, setReturnAsset] = useState<string | null>(null);
  const [description, setDescription] = useState("");
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<ToastState>(null);
  const descriptionRef = useRef<HTMLTextAreaElement>(null);
  // Stable close handler: the dialog focus trap re-runs whenever onClose changes identity.
  const closeSheet = useCallback(() => { if (busy) return; setIssueAsset(null); setReturnAsset(null); }, [busy]);

  async function reload() {
    const [assetResult, returnResult] = await Promise.all([
      listMyEmployeeAssets(),
      listMyEmployeeReturnRequests(),
    ]);
    if (assetResult.error || returnResult.error) {
      setToast({ type: "error", message: copy.loadError });
      return;
    }
    setAssets(assetResult.rows);
    setReturns(returnResult.rows);
  }

  useEffect(() => {
    if (role === "employee") void reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [role]);

  const sheetAssetId = issueAsset ?? returnAsset;
  // The sheet's description field takes focus once the dialog has placed its own initial focus.
  useEffect(() => {
    if (!sheetAssetId) return;
    let inner = 0;
    const outer = requestAnimationFrame(() => { inner = requestAnimationFrame(() => descriptionRef.current?.focus()); });
    return () => { cancelAnimationFrame(outer); cancelAnimationFrame(inner); };
  }, [sheetAssetId]);

  async function submitIssue(assetId: string) {
    if (!description.trim()) return;
    setBusy(true);
    const result = await reportMyAssetIssue(assetId, description);
    setBusy(false);
    if (result.error || result.data?.ok !== true) {
      setToast({ type: "error", message: copy.actionRejected });
      return;
    }
    setIssueAsset(null);
    setDescription("");
    setToast({ type: "success", message: copy.issueReported });
    await reload();
  }

  async function submitReturn(assetId: string) {
    if (!description.trim()) return;
    setBusy(true);
    const result = await requestMyAssetReturn(assetId, description);
    setBusy(false);
    if (result.error || result.data?.ok !== true) {
      setToast({ type: "error", message: copy.actionRejected });
      return;
    }
    setReturnAsset(null);
    setDescription("");
    setToast({ type: "success", message: copy.returnRequested });
    await reload();
  }

  if (role !== "employee") {
    return <Card><EmptyState icon={UserRound} title={copy.employeeOnly} /></Card>;
  }

  const date = (value: string | null) =>
    value ? formatDate(value, lang) : t.common.dash;
  const statusLabel = (value: string) => (t.dailyTasks.status as Record<string, string>)[value] ?? value;
  const sheetAsset = assets.find((asset) => asset.asset_id === sheetAssetId) ?? null;
  const isIssue = !!issueAsset;

  return (
    <div className="mx-auto max-w-6xl">
      <PageHeader title={copy.assetsTitle} description={copy.assetsSubtitle} actions={
        <Button variant="outline" onClick={() => void reload()}>
          <RefreshCw aria-hidden="true" className="h-4 w-4" />
          {t.common.refresh}
        </Button>
      } />

      <section aria-labelledby="my-assets-custody" className="space-y-3">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 id="my-assets-custody" className="font-display text-[17px] font-semibold text-fg">{copy.currentCustody}</h2>
          <span className="text-[13px] tabular-nums text-fg-2">{copy.custodySummary.replace("{count}", String(assets.length))}</span>
        </div>
        <div className="grid gap-4 lg:grid-cols-2">
          {assets.length === 0 ? (
            <Card className="lg:col-span-2"><EmptyState icon={PackageOpen} title={copy.assetsEmpty} /></Card>
          ) : assets.map((asset) => (
            <article key={asset.asset_id} aria-labelledby={`asset-${asset.asset_id}`} className="ui-surface flex flex-col overflow-hidden">
              <div className="flex items-center gap-4 px-5 py-5">
                <EquipmentPhoto asset={{ name: asset.name }} size="row" />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center justify-between gap-2">
                    <span className="tag font-mono text-[13px] font-medium text-brand-ink [unicode-bidi:isolate]" dir="ltr">{asset.asset_tag ?? t.common.dash}</span>
                    <StatusChip tone={asset.status === "reserved" ? "res" : "neu"}>{asset.status === "reserved" ? copy.assignedToYou : statusLabel(asset.status)}</StatusChip>
                  </div>
                  <h3 id={`asset-${asset.asset_id}`} className="mt-2 font-display text-lg font-semibold leading-snug text-fg">{asset.name ?? t.common.dash}</h3>
                </div>
              </div>
              <dl className="grid grid-cols-3 border-t border-line bg-surface-2">
                <Info label={copy.assignedAt} value={date(asset.assigned_at)} />
                <Info label={copy.dueReturn} value={date(asset.due_return_date)} className="border-s border-line" />
                <Info label={copy.openIssues} value={String(asset.open_issue_count)} className="border-s border-line" tone={asset.open_issue_count > 0 ? "text-warn" : undefined} />
              </dl>
              {asset.return_requested && (
                <p className="flex items-start gap-2 border-t border-line bg-brand-soft px-4 py-2.5 text-[12.5px] leading-relaxed text-brand-ink">
                  <InfoIcon aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0" />{copy.returnPendingNote}
                </p>
              )}
              <div className="mt-auto grid grid-cols-2 gap-3 border-t border-line px-5 py-4">
                <Button
                  variant="outline"
                  className="min-w-0 whitespace-normal px-2 text-center leading-tight"
                  onClick={() => {
                    setIssueAsset(asset.asset_id);
                    setReturnAsset(null);
                    setDescription("");
                  }}
                >
                  <AlertTriangle aria-hidden="true" className="h-4 w-4 text-warn" />
                  {copy.reportIssue}
                </Button>
                <Button
                  variant="outline"
                  className="min-w-0 whitespace-normal px-2 text-center leading-tight"
                  disabled={asset.return_requested}
                  onClick={() => {
                    setReturnAsset(asset.asset_id);
                    setIssueAsset(null);
                    setDescription("");
                  }}
                >
                  <RotateCcw aria-hidden="true" className="h-4 w-4" />
                  {asset.return_requested ? copy.returnAlreadyRequested : copy.requestReturn}
                </Button>
              </div>
            </article>
          ))}
        </div>
      </section>

      <div className="mt-5 grid gap-4 lg:grid-cols-[minmax(0,1fr)_320px] lg:items-start">
        <section aria-labelledby="my-assets-returns" className="ui-surface overflow-hidden">
          <div className="flex items-baseline justify-between gap-2 px-4 py-3.5 sm:px-5">
            <h2 id="my-assets-returns" className="font-display text-[17px] font-semibold text-fg">{copy.returnRequests}</h2>
            <span className="ui-count">{returns.length}</span>
          </div>
          {returns.length === 0 ? (
            <p className="border-t border-line px-5 py-6 text-center text-[13px] text-muted">{t.common.none}</p>
          ) : (
            <ul>
              {returns.map((row) => (
                <li key={row.id} className="flex flex-wrap items-start justify-between gap-3 border-t border-line px-4 py-3.5 sm:px-5">
                  <div className="min-w-0">
                    <p className="text-[14px] font-semibold text-fg">{row.asset_name ?? row.asset_tag ?? t.common.dash}</p>
                    {row.asset_tag && <p className="tag mt-0.5 font-mono text-xs text-fg-2 [unicode-bidi:isolate]" dir="ltr">{row.asset_tag}</p>}
                    <p className="mt-1 text-[13px] text-fg-2">{row.reason}</p>
                  </div>
                  <div className="flex flex-col items-end gap-1.5">
                    <StatusChip tone={RETURN_TONE[row.status] ?? "neu"}>{statusLabel(row.status)}</StatusChip>
                    <span className="text-xs tabular-nums text-muted">{date(row.requested_at)}</span>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>

        <Link href="/my-requests" className="ui-surface flex min-h-[60px] items-center gap-3 px-4 py-3.5 transition-colors hover:bg-surface-2">
          <span className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-[10px] bg-brand-soft text-brand-ink"><Plus aria-hidden="true" className="h-[18px] w-[18px]" /></span>
          <span className="min-w-0 flex-1 leading-snug">
            <span className="block font-semibold text-fg">{copy.needAnother}</span>
            <span className="block text-[12.5px] text-muted">{copy.needAnotherHint}</span>
          </span>
          <ChevronLeft aria-hidden="true" className="h-4 w-4 shrink-0 text-muted ltr:rotate-180" />
        </Link>
      </div>

      <Dialog
        open={!!sheetAsset}
        onClose={closeSheet}
        title={isIssue ? copy.reportIssue : copy.requestReturn}
        description={sheetAsset ? <><span className="font-mono text-xs [unicode-bidi:isolate]" dir="ltr">{sheetAsset.asset_tag ?? t.common.dash}</span> · {sheetAsset.name ?? t.common.dash}</> : undefined}
        footer={sheetAsset ? <>
          <Button variant="outline" disabled={busy} onClick={closeSheet}>{t.common.cancel}</Button>
          <Button
            disabled={busy || !description.trim()}
            onClick={() => void (
              issueAsset === sheetAsset.asset_id
                ? submitIssue(sheetAsset.asset_id)
                : submitReturn(sheetAsset.asset_id)
            )}
          >
            {isIssue ? copy.reportIssue : copy.requestReturn}
          </Button>
        </> : undefined}
      >
        <label className="block">
          <span className="ui-label">{isIssue ? copy.issueDescription : copy.returnReason}</span>
          <textarea
            ref={descriptionRef}
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            className={`${inputClass} min-h-24 resize-none`}
          />
        </label>
      </Dialog>
      <Toast toast={toast} onDone={() => setToast(null)} />
    </div>
  );
}

function Info({ label, value, className = "", tone }: { label: string; value: string; className?: string; tone?: string }) {
  return (
    <div className={`min-w-0 px-4 py-2.5 ${className}`}>
      <dt className="text-[11.5px] text-muted">{label}</dt>
      <dd className={`mt-0.5 text-[13px] font-medium tabular-nums ${tone ?? "text-fg"}`}>{value}</dd>
    </div>
  );
}
