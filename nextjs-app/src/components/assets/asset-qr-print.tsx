"use client";

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { Printer } from "lucide-react";
import { Dialog } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { useAppPreferences } from "@/components/providers/app-preferences-provider";
import { interpolate } from "@/lib/i18n";

export type AssetQrLabel = { id: string; asset_tag: string; name: string; qr_token: string };

type QrCodeComponent = typeof import("qrcode.react")["QRCodeSVG"];
let qrCodeCode: Promise<QrCodeComponent> | null = null;
function loadQrCode(): Promise<QrCodeComponent> {
  return qrCodeCode ??= import("qrcode.react")
    .then((module) => module.QRCodeSVG)
    .catch((error: unknown) => {
      qrCodeCode = null;
      throw error;
    });
}

function Labels({ assets, origin, QrCode }: { assets: AssetQrLabel[]; origin: string; QrCode: QrCodeComponent }) {
  return <div className="asset-qr-label-grid">
    {assets.map((asset) => <article key={asset.id} className="asset-qr-label" data-asset-label={asset.id}>
      <QrCode value={`${origin}/a/${asset.qr_token}`} size={112} level="M" marginSize={4} aria-label={asset.asset_tag} />
      <strong dir="auto">{asset.asset_tag}</strong>
      <span dir="auto" title={asset.name}>{asset.name}</span>
    </article>)}
  </div>;
}

/** Only the already-loaded selection is rendered; public QR URLs retain their existing contract. */
export function AssetQrPrint({ assets, onClose }: { assets: AssetQrLabel[] | null; onClose: () => void }) {
  const { t, lang } = useAppPreferences();
  const lu = t.assets.listUx;
  const open = assets !== null;
  const [QrCode, setQrCode] = useState<QrCodeComponent | null>(null);
  const [codeFailed, setCodeFailed] = useState(false);
  const [codeRetry, setCodeRetry] = useState(0);
  useEffect(() => {
    if (!open || QrCode || codeFailed) return;
    let active = true;
    void loadQrCode().then((component) => {
      if (active) setQrCode(() => component);
    }).catch(() => {
      if (active) setCodeFailed(true);
    });
    return () => { active = false; };
  }, [open, QrCode, codeFailed, codeRetry]);
  useEffect(() => {
    if (!open) setCodeFailed(false);
  }, [open]);
  useEffect(() => {
    if (!open || !QrCode) return;
    document.body.dataset.assetQrPrint = "true";
    return () => { delete document.body.dataset.assetQrPrint; };
  }, [open, QrCode]);
  if (!assets) return null;
  const origin = window.location.origin;
  return <>
    <Dialog open onClose={onClose} title={lu.printTitle} size="3xl"
      description={interpolate(lu.printCount, { count: assets.length })}
      footer={QrCode
        ? <Button type="button" onClick={() => window.print()}><Printer aria-hidden="true" className="h-4 w-4" />{lu.printNow}</Button>
        : codeFailed ? <Button type="button" onClick={(event) => {
          // The retry control disappears while loading. Keep focus inside the
          // existing dialog; its modal hook still restores the original trigger.
          event.currentTarget.closest('[role="dialog"]')?.querySelector<HTMLButtonElement>("button")?.focus();
          setCodeFailed(false); setCodeRetry((attempt) => attempt + 1);
        }}>{t.reports.retry}</Button> : undefined}>
      {QrCode ? <Labels assets={assets} origin={origin} QrCode={QrCode} />
        : codeFailed ? <p role="alert" className="text-sm text-bad">{lu.printLoadError}</p>
          : <p role="status" className="text-sm text-muted">{lu.printLoading}</p>}
    </Dialog>
    {QrCode && createPortal(<div className="asset-qr-print-sheet" dir={lang === "ar" ? "rtl" : "ltr"}>
      <Labels assets={assets} origin={origin} QrCode={QrCode} />
    </div>, document.body)}
  </>;
}
