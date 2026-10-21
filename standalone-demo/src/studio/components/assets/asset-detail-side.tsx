"use client";

// البطاقات الجانبية لصفحة تفاصيل الأصل (Ledger): رمز QR، العهدة الحالية، الموقع، المورد والضمان.
// عرض فقط لبيانات محمّلة مسبقًا — لا استعلامات جديدة، ولا توسيع لإسقاط صفحة QR العامة.

import type { ReactNode } from "react";
import { QRCodeCanvas } from "qrcode.react";
import { ExternalLink, MapPin, UserRound } from "lucide-react";
import { StatusChip } from "@/components/ui/status-chip";
import { formatDate } from "@/lib/format";
import { interpolate, type Dict, type Lang } from "@/lib/i18n";

function SideCard({ id, title, actions, children }: { id: string; title: string; actions?: ReactNode; children: ReactNode }) {
  return (
    <section aria-labelledby={id} className="ui-surface flex flex-col gap-3 px-[18px] py-4">
      <div className="flex items-center justify-between gap-2">
        <h2 id={id} className="font-display text-sm font-semibold text-fg">{title}</h2>
        {actions}
      </div>
      {children}
    </section>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3 text-[13px]">
      <span className="text-muted">{label}</span>
      <span className="min-w-0 truncate text-end text-fg-2">{children}</span>
    </div>
  );
}

const pick = (lang: Lang, ar?: string | null, en?: string | null) => (lang === "en" ? (en ?? ar) : (ar ?? en)) ?? null;

function initials(name: string | null): string {
  if (!name) return "";
  return name.trim().split(/\s+/).slice(0, 2).map((w) => w.charAt(0)).join("");
}

export function QrCard({ asset, origin, t }: { asset: any; origin: string; t: Dict }) {
  const L = t.assetDetail.ledger;
  const qrUrl = `${origin}/a/${asset.qr_token}`;
  return (
    <SideCard id="asset-qr-title" title={L.qrCardTitle}
      actions={
        <a href={qrUrl} target="_blank" className="inline-flex items-center gap-1 text-[12.5px] font-semibold text-brand-ink hover:underline">
          {L.publicPage}<ExternalLink aria-hidden="true" className="h-3.5 w-3.5" />
          <span className="sr-only">{t.assetDetail.openPublic}</span>
        </a>
      }>
      <div className="flex items-center gap-3.5">
        <div className="shrink-0 overflow-hidden rounded-xl border border-line">
          {origin ? <QRCodeCanvas value={qrUrl} size={112} level="M" includeMargin aria-label={L.qrImageLabel.replace("{tag}", asset.asset_tag ?? "")} /> : <div className="h-[112px] w-[112px] animate-pulse bg-sunk" />}
        </div>
        <div className="min-w-0 leading-relaxed">
          <div className="tag text-sm font-medium text-fg">{asset.asset_tag}</div>
          {asset.name && <div className="truncate text-[12.5px] text-muted">{asset.name}</div>}
          <p className="tag mt-1 break-all text-[11.5px] text-muted" dir="ltr">{asset.qr_token}</p>
          <p className="mt-1.5 text-xs text-muted">{L.publicNote}</p>
        </div>
      </div>
    </SideCard>
  );
}

export function CustodyCard({ asset, assignments, t, lang }: { asset: any; assignments: any[]; t: Dict; lang: Lang }) {
  const L = t.assetDetail.ledger;
  const holderName = pick(lang, asset.holder?.full_name_ar, asset.holder?.full_name);
  const active = (assignments ?? []).find((a) => a.status === "active") ?? null;
  return (
    <SideCard id="asset-custody-title" title={L.custodyTitle}>
      {holderName ? (
        <>
          <div className="flex items-center gap-3">
            <span aria-hidden="true" className="ui-avatar h-10 w-10 shrink-0 bg-res-soft text-[13px] text-res">{initials(holderName)}</span>
            <div className="min-w-0 leading-snug">
              <div className="truncate font-semibold text-fg">{holderName}</div>
              <div className="text-[12.5px] text-muted">{t.status.reserved}</div>
            </div>
          </div>
          {active && (
            <>
              <Row label={L.since}><span className="tabular-nums">{formatDate(active.assigned_at, lang)}</span></Row>
              <Row label={L.plannedReturn}>
                {active.due_return_date ? <span className="tabular-nums">{formatDate(active.due_return_date, lang)}</span> : L.noPlannedReturn}
              </Row>
            </>
          )}
        </>
      ) : (
        <div className="flex items-center gap-3">
          <span aria-hidden="true" className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-full border-[1.5px] border-dashed border-line-strong text-muted">
            <UserRound className="h-4 w-4" />
          </span>
          <div className="leading-snug">
            <div className="font-semibold text-fg">{L.unassigned}</div>
            <div className="text-[12.5px] text-muted">{L.unassignedNote}</div>
          </div>
        </div>
      )}
    </SideCard>
  );
}

export function LocationCard({ asset, t, lang }: { asset: any; t: Dict; lang: Lang }) {
  const L = t.assetDetail.ledger;
  const loc = pick(lang, asset.location?.name_ar, asset.location?.name);
  const dept = pick(lang, asset.department?.name_ar, asset.department?.name);
  return (
    <SideCard id="asset-location-title" title={L.locationTitle}>
      <div className="flex items-center gap-2.5">
        <span aria-hidden="true" className="tone-info inline-flex h-[34px] w-[34px] shrink-0 items-center justify-center rounded-[10px]">
          <MapPin className="h-4 w-4" />
        </span>
        <div className="min-w-0 leading-snug">
          <div className={`truncate font-semibold ${loc ? "text-fg" : "text-muted"}`}>{loc ?? L.noLocation}</div>
          <div className="text-[12.5px] text-muted">{t.assetDetail.info.department}: {dept ?? "—"}</div>
        </div>
      </div>
    </SideCard>
  );
}

export function SupplierWarrantyCard({ asset, t, lang }: { asset: any; t: Dict; lang: Lang }) {
  const L = t.assetDetail.ledger;
  const supplier = asset.supplier?.name_ar ?? asset.supplier?.name ?? null;
  const end: string | null = asset.warranty_end ?? null;
  const today = new Date().toISOString().slice(0, 10);
  const active = end ? end >= today : false;
  return (
    <SideCard id="asset-warranty-title" title={L.supplierWarrantyTitle}>
      <Row label={t.assetDetail.info.supplier}><span className="font-medium text-fg">{supplier ?? "—"}</span></Row>
      <div className="flex flex-wrap items-center justify-between gap-2 text-[13px]">
        <span className="text-muted">{t.assetDetail.info.warrantyEnd}</span>
        {end ? (
          <span className="flex items-center gap-2">
            <StatusChip tone={active ? "ok" : "bad"} size="sm">{active ? L.warrantyActive : L.warrantyExpired}</StatusChip>
            <span className="tabular-nums text-fg-2">{interpolate(L.warrantyUntil, { date: formatDate(end, lang) })}</span>
          </span>
        ) : (
          <span className="text-muted">{L.warrantyNone}</span>
        )}
      </div>
    </SideCard>
  );
}
