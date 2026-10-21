"use client";

import { useCallback, useEffect, useState } from "react";
import { Paperclip, ExternalLink, FileText, Loader2, Upload } from "lucide-react";
import { FileInput } from "@/components/ui/file-input";
import { Button } from "@/components/ui/button";
import { StatusChip } from "@/components/ui/status-chip";
import { useAppPreferences } from "@/components/providers/app-preferences-provider";
import { formatBytes, formatDateTime } from "@/lib/format";
import {
  portalListRequestAttachments, uploadRequestAttachmentPortal, getPortalAttachmentUrl,
  validateAttachmentFile, ATTACHMENT_ACCEPT, type PortalAttachment,
} from "@/lib/request-attachments";
import type { PortalRole } from "@/lib/portal";

const EDITABLE = new Set(["draft", "under_review", "needs_clarification"]);

// بطاقة مرفقات الطلب في البوابة: يعرض مرفقات العميل + مرفقات الموظفين المرئية له،
// ويسمح بالإضافة عندما تكون الحالة قابلة للتحرير والدور ليس viewer.
export function PortalAttachments({
  requestId, status, role, expectedActorId, isCurrent,
}: { requestId: string; status: string; role: PortalRole | undefined; expectedActorId: string; isCurrent: (actorId: string) => boolean }) {
  const { t, lang } = useAppPreferences();
  const tp = t.portal;
  const ta = tp.attachments;

  const [rows, setRows] = useState<PortalAttachment[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [opening, setOpening] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ type: "ok" | "err"; text: string } | null>(null);

  const canUpload = isCurrent(expectedActorId) && EDITABLE.has(status) && role !== "viewer";
  const errLabel = (code: string) => (tp.err as Record<string, string>)[code] ?? code;

  const load = useCallback(async () => {
    if (!isCurrent(expectedActorId)) return;
    const { rows, error } = await portalListRequestAttachments(requestId);
    if (!isCurrent(expectedActorId)) return;
    setRows(rows); setLoadErr(error); setLoaded(true);
  }, [requestId, expectedActorId, isCurrent]);
  useEffect(() => { load(); }, [load]);

  async function onUpload() {
    if (!file || !canUpload || busy) return;
    const v = validateAttachmentFile(file);
    if (v) { setMsg({ type: "err", text: errLabel(v) }); return; }
    setBusy(true);
    const e = await uploadRequestAttachmentPortal(requestId, file, expectedActorId);
    if (!isCurrent(expectedActorId)) return;
    setBusy(false);
    if (e) { setMsg({ type: "err", text: `${ta.uploadError} ${errLabel(e)}` }); return; }
    setFile(null); setMsg({ type: "ok", text: ta.uploadedPendingToast }); load();
  }

  async function open(id: string) {
    // نفتح تبويبًا فارغًا تزامنيًا داخل معالج النقر (ينجو من مانع النوافذ المنبثقة)
    // ثم نوجّهه بعد وصول الرابط الموقّت.
    const w = window.open("", "_blank");
    setOpening(id);
    const { url } = await getPortalAttachmentUrl(id);
    setOpening(null);
    if (url) {
      if (w) w.location.href = url;
      else window.open(url, "_blank");
    } else {
      if (w) w.close();
      setMsg({ type: "err", text: ta.openError });
    }
  }

  return (
    <section aria-labelledby={`portal-attachments-${requestId}`} className="ui-surface overflow-hidden">
      <div className="flex items-center justify-between gap-2 px-4 py-3.5 sm:px-5">
        <h2 id={`portal-attachments-${requestId}`} className="flex items-center gap-2 font-display text-[17px] font-semibold text-fg">
          <Paperclip aria-hidden="true" className="h-4 w-4 text-muted" />{ta.title}
        </h2>
        {loaded && !loadErr && <span className="ui-count">{rows.length}</span>}
      </div>

      {loaded && loadErr && (
        <p role="alert" className="border-t border-line px-4 py-3 text-xs font-medium text-bad sm:px-5">{errLabel(loadErr)}</p>
      )}
      {loaded && !loadErr && rows.length === 0 && (
        <p className="border-t border-line px-4 py-3 text-[13px] text-muted sm:px-5">{ta.empty}</p>
      )}

      {rows.length > 0 && (
        <ul>
          {rows.map((a) => (
            <li key={a.id} className="flex min-h-[62px] items-center gap-3 border-t border-line py-2 pe-2 ps-4 sm:ps-5">
              <span className="inline-flex h-9 w-6 shrink-0 items-center justify-center text-fg-2">
                <FileText aria-hidden="true" className="h-[18px] w-[18px]" />
              </span>
              <div className="min-w-0 flex-1">
                <p className="truncate text-[13px] font-semibold text-fg">{a.file_name}</p>
                <p className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted">
                  <StatusChip tone={a.uploaded_by_kind === "portal" ? "info" : "neu"} size="sm" dot={false}>
                    {a.uploaded_by_kind === "portal" ? ta.mine : ta.fromTeam}
                  </StatusChip>
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
              <Button
                variant="ghost"
                size="sm"
                onClick={() => open(a.id)}
                disabled={opening === a.id || a.scan_status !== "clean"}
                aria-label={`${ta.open} ${a.file_name}`}
                className="shrink-0 text-brand-ink">
                {opening === a.id ? <Loader2 aria-hidden="true" className="h-3.5 w-3.5 animate-spin" /> : <ExternalLink aria-hidden="true" className="h-3.5 w-3.5" />}
                {ta.open}
              </Button>
            </li>
          ))}
        </ul>
      )}

      {canUpload && (
        <div className="border-t border-line bg-surface-2 px-4 py-4 sm:px-5">
          <FileInput accept={ATTACHMENT_ACCEPT} file={file} onPick={setFile} disabled={busy} />
          <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
            <p className="text-xs text-muted">{ta.hint}</p>
            <Button size="sm" disabled={!file || busy} onClick={onUpload}>
              {busy ? <Loader2 aria-hidden="true" className="h-4 w-4 animate-spin" /> : <Upload aria-hidden="true" className="h-4 w-4" />}
              {busy ? ta.uploading : ta.add}
            </Button>
          </div>
        </div>
      )}

      {msg && (
        <p role={msg.type === "ok" ? "status" : "alert"} className={`border-t border-line px-4 py-2.5 text-xs font-medium sm:px-5 ${msg.type === "ok" ? "text-ok" : "text-bad"}`}>{msg.text}</p>
      )}
    </section>
  );
}
