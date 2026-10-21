"use client";

import { useState } from "react";
import { ImageIcon, FileText, Upload, Eye, Lock } from "lucide-react";
import { buttonClass } from "@/components/ui/button";
import { StatusChip } from "@/components/ui/status-chip";
import { uploadAssetAttachment, getAttachmentUrl, type AssetAttachmentKind } from "@/lib/queries";
import type { ToastState } from "@/components/ui/toast";
import type { Dict } from "@/lib/i18n";

type Att = {
  id: string;
  kind: string | null;
  file_name: string;
  storage_path: string;
  scan_status: "pending" | "clean" | "infected" | "error";
  created_at: string;
};

/**
 * مستندات الأصل: صورة الجهاز التوثيقية + فاتورة الضمان + فاتورة الشراء.
 * منفصلة تمامًا عن مرفقات الصيانة. الملفات في bucket خاص وتُفتح عبر روابط موقّتة فقط.
 * الفواتير (مالية) لا تظهر إلا لمن لديه canSeeFinancial؛ صورة الجهاز تظهر لكل المعتمدين.
 * لا تظهر أي من هذه المرفقات في Public QR.
 */
export function AssetDocuments({
  assetId, attachments, canWrite, canSeeFinancial, onChange, setToast, t,
}: {
  assetId: string; attachments: Att[]; canWrite: boolean; canSeeFinancial: boolean;
  onChange: () => void; setToast: (t: ToastState) => void; t: Dict;
}) {
  const td = t.assetDetail.docs;
  const latest = (kind: AssetAttachmentKind) =>
    attachments.filter((a) => a.kind === kind).sort((a, b) => (a.created_at < b.created_at ? 1 : -1))[0] ?? null;

  const slots: { kind: AssetAttachmentKind; label: string; icon: typeof ImageIcon; financial: boolean; accept: string }[] = [
    { kind: "asset_photo", label: td.devicePhoto, icon: ImageIcon, financial: false, accept: "image/*" },
    { kind: "warranty_invoice", label: td.warrantyInvoice, icon: FileText, financial: true, accept: "image/*,application/pdf" },
    { kind: "purchase_invoice", label: td.purchaseInvoice, icon: FileText, financial: true, accept: "image/*,application/pdf" },
  ];

  return (
    <div>
      <h3 className="mb-4 font-display text-[15px] font-semibold text-fg">{td.title}</h3>
      <div className="flex flex-col gap-2.5">
        {slots.map((s) =>
          s.financial && !canSeeFinancial ? (
            <LockedSlot key={s.kind} label={s.label} note={td.financialOnly} />
          ) : (
            <DocSlot key={s.kind} assetId={assetId} slot={s} current={latest(s.kind)} canWrite={canWrite}
              td={td} onChange={onChange} setToast={setToast} />
          ),
        )}
      </div>
    </div>
  );
}

function LockedSlot({ label, note }: { label: string; note: string }) {
  return (
    <div className="flex items-center gap-3 rounded-xl border border-dashed border-line-strong bg-surface-2 px-3.5 py-3">
      <span aria-hidden="true" className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-[10px] border border-line bg-surface text-muted">
        <Lock className="h-4 w-4" />
      </span>
      <div className="min-w-0 leading-relaxed">
        <p className="text-[13.5px] font-semibold text-fg-2">{label}</p>
        <p className="text-[12.5px] text-muted">{note}</p>
      </div>
    </div>
  );
}

function DocSlot({ assetId, slot, current, canWrite, td, onChange, setToast }: {
  assetId: string; slot: { kind: AssetAttachmentKind; label: string; icon: typeof ImageIcon; accept: string };
  current: Att | null; canWrite: boolean; td: Dict["assetDetail"]["docs"];
  onChange: () => void; setToast: (t: ToastState) => void;
}) {
  const [busy, setBusy] = useState(false);
  const Icon = slot.icon;

  async function upload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]; if (!file) return;
    setBusy(true);
    const err = await uploadAssetAttachment(assetId, file, slot.kind);
    setBusy(false);
    e.target.value = "";
    if (err) { setToast({ type: "error", message: td.uploadError + err }); return; }
    setToast({ type: "success", message: td.uploadedPending });
    onChange();
  }

  async function view() {
    if (!current) return;
    if (current.scan_status !== "clean") return;
    const { url, error } = await getAttachmentUrl(
      current.storage_path,
      current.file_name,
    );
    if (url) window.open(url, "_blank");
    else setToast({ type: "error", message: td.viewError + (error ?? "") });
  }

  const pending = current && current.scan_status !== "clean";
  return (
    <div className="flex flex-wrap items-center gap-3 rounded-xl border border-line px-3.5 py-3 sm:flex-nowrap">
      <span aria-hidden="true" className={`inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-[10px] ${current ? (pending ? "tone-warn" : "tone-info") : "border border-line bg-surface-2 text-muted"}`}>
        <Icon className="h-4 w-4" />
      </span>
      <div className="min-w-0 flex-1 leading-relaxed">
        <p className="text-[13.5px] font-semibold text-fg">{slot.label}</p>
        {current ? (
          <p className="flex min-w-0 items-center gap-2 text-[12.5px] text-muted">
            <span className="truncate" dir="auto">{current.file_name}</span>
            {pending && <StatusChip tone={current.scan_status === "pending" ? "warn" : "bad"} size="sm">{td.scan[current.scan_status as "pending" | "infected" | "error"]}</StatusChip>}
          </p>
        ) : (
          <p className="text-[12.5px] text-muted">{td.none}</p>
        )}
      </div>
      <div className="flex shrink-0 items-center gap-1.5">
        {current && (
          <button
            type="button"
            onClick={view}
            disabled={current.scan_status !== "clean"}
            title={current.scan_status !== "clean" ? td.scan[current.scan_status] : undefined}
            className={buttonClass("ghost", "sm", "text-brand-ink")}
          >
            <Eye aria-hidden="true" className="h-4 w-4" />{td.view}
          </button>
        )}
        {canWrite && (
          <label className={buttonClass("outline", "sm", busy ? "pointer-events-none opacity-60" : "")}>
            <Upload aria-hidden="true" className="h-4 w-4" /> {busy ? td.uploading : current ? td.replace : td.upload}
            <input type="file" accept={slot.accept} className="hidden" onChange={upload} disabled={busy} />
          </label>
        )}
      </div>
    </div>
  );
}
