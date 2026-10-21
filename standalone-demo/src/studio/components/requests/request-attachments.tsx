"use client";

import { useCallback, useEffect, useState } from "react";
import { ExternalLink, Loader2, Upload, Eye, EyeOff, FileText, Paperclip } from "lucide-react";
import { Button } from "@/components/ui/button";
import { FileInput } from "@/components/ui/file-input";
import { StatusChip } from "@/components/ui/status-chip";
import { EmptyState } from "@/components/ui/empty-state";
import { Toast, type ToastState } from "@/components/ui/toast";
import { useAppPreferences } from "@/components/providers/app-preferences-provider";
import { formatBytes, formatDateTime } from "@/lib/format";
import {
  listRequestAttachmentsStaff, uploadRequestAttachmentStaff, getStaffAttachmentUrl,
  setAttachmentVisibility, validateAttachmentFile, ATTACHMENT_ACCEPT, type StaffAttachment,
} from "@/lib/request-attachments";

// تبويب مرفقات الطلب الداخلي: يعرض مرفقات العميل والموظفين مع تمييز المصدر والرؤية،
// ويسمح للموظف صاحب الصلاحية بالرفع (مع اختيار «مرئي للعميل») وتبديل رؤية مرفقات الموظفين.
export function RequestAttachments({
  requestId,
  canWrite,
  canSetCustomerVisibility,
}: {
  requestId: string;
  canWrite: boolean;
  canSetCustomerVisibility: boolean;
}) {
  const { t, lang } = useAppPreferences();
  const tr = t.requests;
  const ta = tr.attachments;

  const [rows, setRows] = useState<StaffAttachment[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [visible, setVisible] = useState(false);
  const [busy, setBusy] = useState(false);
  const [opening, setOpening] = useState<string | null>(null);
  const [toast, setToast] = useState<ToastState>(null);

  const errLabel = (code: string) => (tr.err as Record<string, string>)[code] ?? code;

  const load = useCallback(async () => {
    const { rows, error } = await listRequestAttachmentsStaff(requestId);
    setRows(rows); setLoadErr(error); setLoaded(true);
  }, [requestId]);
  useEffect(() => { load(); }, [load]);

  async function onUpload() {
    if (!file) return;
    const v = validateAttachmentFile(file);
    if (v) { setToast({ type: "error", message: `${ta.uploadError} ${errLabel(v)}` }); return; }
    setBusy(true);
    const e = await uploadRequestAttachmentStaff(requestId, file, visible);
    setBusy(false);
    if (e) { setToast({ type: "error", message: `${ta.uploadError} ${errLabel(e)}` }); return; }
    setFile(null);
    setVisible(false);
    setToast({ type: "success", message: ta.uploadedPendingToast });
    load();
  }

  async function open(path: string, fileName: string, id: string) {
    const w = window.open("", "_blank");
    setOpening(id);
    const { url } = await getStaffAttachmentUrl(path, fileName);
    setOpening(null);
    if (url) {
      if (w) w.location.href = url;
      else window.open(url, "_blank");
    } else {
      if (w) w.close();
      setToast({ type: "error", message: ta.openError });
    }
  }

  async function toggle(a: StaffAttachment) {
    setBusy(true);
    const e = await setAttachmentVisibility(a.id, !a.visible_to_customer);
    setBusy(false);
    if (e) { setToast({ type: "error", message: `${tr.actionError}${errLabel(e)}` }); return; }
    setToast({ type: "success", message: ta.visibilityToast }); load();
  }

  return (
    <div className="p-5">
      {loaded && loadErr && (
        <p role="alert" className="text-sm font-medium text-bad">{errLabel(loadErr)}</p>
      )}
      {loaded && !loadErr && rows.length === 0 && (
        <EmptyState compact icon={Paperclip} title={ta.empty} />
      )}

      {rows.length > 0 && (
        <ul className="divide-y divide-line rounded-xl border border-line">
          {rows.map((a) => {
            const fromCustomer = a.uploaded_by_kind === "portal";
            return (
              <li key={a.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
                <span aria-hidden="true" className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-[10px] bg-sunk text-muted">
                  <FileText className="h-[18px] w-[18px]" />
                </span>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[13.5px] font-medium text-fg">{a.file_name}</p>
                  <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted">
                    <StatusChip tone={fromCustomer ? "info" : "neu"} size="sm" dot={false}>
                      {fromCustomer ? ta.uploaderCustomer : ta.uploaderStaff}
                    </StatusChip>
                    {!fromCustomer && (
                      <StatusChip tone={a.visible_to_customer ? "ok" : "warn"} size="sm">
                        {a.visible_to_customer ? ta.visibleBadge : ta.internalBadge}
                      </StatusChip>
                    )}
                    <span className="tabular-nums" dir="ltr">{formatBytes(a.size_bytes)}</span>
                    <span className="tabular-nums" dir="ltr">{formatDateTime(a.created_at, lang)}</span>
                    {a.scan_status !== "clean" && (
                      <StatusChip tone={a.scan_status === "infected" ? "bad" : "warn"} size="sm">
                        {a.scan_status === "infected"
                          ? ta.scanInfected
                          : a.scan_status === "error"
                            ? ta.scanError
                            : ta.scanPending}
                      </StatusChip>
                    )}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-1.5">
                  {canSetCustomerVisibility && !fromCustomer && a.classification !== "financial" && (
                    <Button
                      type="button" variant="ghost" size="sm" onClick={() => toggle(a)} disabled={busy}
                      title={a.visible_to_customer ? ta.makeInternal : ta.makeVisible}>
                      {a.visible_to_customer ? <EyeOff aria-hidden="true" /> : <Eye aria-hidden="true" />}
                      {a.visible_to_customer ? ta.makeInternal : ta.makeVisible}
                    </Button>
                  )}
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => open(a.storage_path, a.file_name, a.id)}
                    disabled={opening === a.id || a.scan_status !== "clean"}>
                    {opening === a.id ? <Loader2 aria-hidden="true" className="animate-spin" /> : <ExternalLink aria-hidden="true" />}
                    {ta.open}
                  </Button>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {canWrite && (
        <div className="mt-5 rounded-xl border border-dashed border-line-strong p-4">
          <h3 className="mb-2 text-sm font-semibold text-fg">{ta.upload}</h3>
          <FileInput accept={ATTACHMENT_ACCEPT} file={file} onPick={setFile} disabled={busy} />
          <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
            {canSetCustomerVisibility && (
              <label className="flex cursor-pointer items-center gap-2 text-[13px] text-fg-2">
                <input type="checkbox" checked={visible} onChange={(e) => setVisible(e.target.checked)} className="h-4 w-4 rounded accent-brand" />
                {ta.visibleToCustomer}
              </label>
            )}
            <div className="ms-auto flex flex-wrap items-center gap-2">
              <span className="text-xs text-muted">{ta.hint}</span>
              <Button size="sm" disabled={!file || busy} onClick={onUpload}>
                {busy ? <Loader2 aria-hidden="true" className="animate-spin" /> : <Upload aria-hidden="true" />}
                {busy ? ta.uploading : ta.upload}
              </Button>
            </div>
          </div>
        </div>
      )}

      <Toast toast={toast} onDone={() => setToast(null)} />
    </div>
  );
}
