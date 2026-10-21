"use client";

import { use, useEffect, useState } from "react";
import Link from "next/link";
import { ScanLine, CircleCheck, Tag, MapPin, Lock, LogIn, ShieldCheck, SearchX } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { useAppPreferences } from "@/components/providers/app-preferences-provider";
import { buttonClass } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { StatusChip } from "@/components/ui/status-chip";
import { AuthPrefs } from "@/components/auth/auth-chrome";
import { ASSET_STATUS_TONE } from "@/lib/tone";
import type { AssetStatus } from "@/lib/types";

// الحقول الخمسة غير الحساسة التي يُرجعها RPC الآمن public_asset_by_token فقط.
type PublicAsset = {
  asset_tag: string;
  name: string | null;
  status: AssetStatus;
  category: string | null;
  location: string | null;
};

export default function PublicAssetPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = use(params);
  // اللغة/الثيم/الاتجاه يأتيان من نفس نظام التفضيلات (root layout يضبط html من الكوكي).
  const { t } = useAppPreferences();
  const [asset, setAsset] = useState<PublicAsset | null>(null);
  const [state, setState] = useState<"loading" | "ok" | "notfound">("loading");

  useEffect(() => {
    (async () => {
      const sb = createClient();
      // دالة آمنة (SECURITY DEFINER) تُرجع حقولًا غير حساسة فقط — لا وصول مباشر للجداول.
      const { data, error } = await sb.rpc("public_asset_by_token", { p_token: token });
      const row = Array.isArray(data) ? data[0] : data;
      if (error || !row) { setState("notfound"); return; }
      setAsset(row as PublicAsset); setState("ok");
    })();
  }, [token]);

  const pa = t.publicAsset;
  const staffLogin = (
    <Link href="/login" className={buttonClass("primary", "md", "min-h-11 w-full text-[15px] font-semibold")}>
      <LogIn aria-hidden="true" className="rtl:rotate-180" />{pa.staffLogin}
    </Link>
  );

  return (
    <main className="flex min-h-dvh flex-col bg-canvas">
      {/* تبديل اللغة والثيم — صفحة عامة بلا تسجيل دخول؛ يفيد زائرًا خارجيًا بلا كوكي */}
      <div className="flex h-14 shrink-0 items-center gap-2.5 border-b border-line bg-surface px-4">
        <span className="inline-flex h-[30px] w-[30px] shrink-0 items-center justify-center rounded-[9px] bg-fg text-canvas">
          <ScanLine aria-hidden="true" className="h-4 w-4" />
        </span>
        <span className="min-w-0 flex-1 leading-tight">
          <span className="block truncate font-display text-[17px] font-semibold text-fg">{pa.title}</span>
          <span className="block truncate text-[11.5px] text-muted">{pa.poweredBy}</span>
        </span>
        <AuthPrefs />
      </div>

      <div className="mx-auto flex w-full max-w-md flex-1 flex-col gap-3.5 px-4 py-4 sm:py-8">
        {state === "loading" && (
          <div className="ui-surface flex justify-center py-12">
            <h1 className="sr-only">{pa.title}</h1>
            <Spinner label={pa.loading} />
          </div>
        )}

        {state === "notfound" && (
          <>
            <article aria-labelledby="public-asset-missing" className="ui-surface flex flex-col items-center px-5 pb-6 pt-7 text-center">
              <span className="inline-flex h-[60px] w-[60px] items-center justify-center rounded-2xl bg-warn-soft text-warn">
                <SearchX aria-hidden="true" className="h-7 w-7" />
              </span>
              <h1 id="public-asset-missing" className="mt-4 font-display text-[21px] font-semibold leading-[1.35] text-fg">{pa.notFoundTitle}</h1>
              <p className="mt-1.5 text-sm text-fg-2">{pa.notFoundDescription}</p>
            </article>
            <section aria-labelledby="public-asset-what-now" className="ui-surface overflow-hidden">
              <h2 id="public-asset-what-now" className="px-[18px] pb-1 pt-3.5 text-[13px] font-semibold text-muted">{pa.whatNow}</h2>
              <ol className="px-[18px] pb-1.5">
                {[pa.tipRescan, pa.tipSearch, pa.tipReport].map((tip, index) => (
                  <li key={tip} className={`flex gap-3 py-2.5 ${index ? "border-t border-line" : ""}`}>
                    <span className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-sunk text-xs font-bold tabular-nums text-fg-2">{index + 1}</span>
                    <span className="text-[13.5px] leading-relaxed text-fg">{tip}</span>
                  </li>
                ))}
              </ol>
            </section>
            {staffLogin}
          </>
        )}

        {state === "ok" && asset && (
          <>
            <p className="flex items-center gap-2 text-[13px] font-semibold text-ok">
              <CircleCheck aria-hidden="true" className="h-4 w-4" />{pa.recognised}
            </p>

            {/* قيم من قاعدة البيانات — لا تُترجم */}
            <article aria-labelledby="public-asset-name" className="ui-surface overflow-hidden">
              <div className="px-[18px] pb-4 pt-[18px]">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-xs text-muted">{pa.tagLabel}</p>
                    <p className="tag mt-0.5 text-[19px] font-medium text-brand-ink">{asset.asset_tag}</p>
                  </div>
                  <div className="flex shrink-0 flex-col items-end gap-1">
                    <p className="text-xs text-muted">{pa.status}</p>
                    <StatusChip tone={asset.status ? ASSET_STATUS_TONE[asset.status] : "neu"}>
                      {asset.status ? (t.status[asset.status] ?? asset.status) : "—"}
                    </StatusChip>
                  </div>
                </div>
                <h1 id="public-asset-name" className="mt-3 font-display text-[21px] font-semibold leading-[1.35] text-fg">{asset.name ?? asset.category ?? "—"}</h1>
              </div>
              <dl className="border-t border-line">
                <Row icon={Tag} label={pa.category} value={asset.category} />
                <Row icon={MapPin} label={pa.location} value={asset.location} bordered />
              </dl>
            </article>

            <section aria-labelledby="public-asset-lock" className="flex gap-3 rounded-card bg-sunk px-4 py-3.5">
              <Lock aria-hidden="true" className="mt-0.5 h-5 w-5 shrink-0 text-fg-2" />
              <div className="leading-relaxed">
                <h2 id="public-asset-lock" className="text-sm font-semibold text-fg">{pa.staffOnlyTitle}</h2>
                <p className="mt-0.5 text-[13px] text-fg-2">{pa.staffOnlyDesc}</p>
              </div>
            </section>

            {staffLogin}

            <p className="flex items-start gap-2 text-xs leading-relaxed text-muted">
              <ShieldCheck aria-hidden="true" className="mt-0.5 h-3.5 w-3.5 shrink-0" />{pa.privacyNote}
            </p>
          </>
        )}

        <p className="mt-auto pt-2 text-center text-xs text-muted">{pa.poweredBy}</p>
      </div>
    </main>
  );
}

function Row({ icon: Icon, label, value, bordered = false }: {
  icon: typeof Tag; label: string; value?: string | null; bordered?: boolean;
}) {
  return (
    <div className={`flex min-h-[54px] items-center gap-3 px-[18px] ${bordered ? "border-t border-line" : ""}`}>
      <dt className="flex flex-1 items-center gap-3 text-[13.5px] text-muted">
        <span className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-[9px] bg-sunk text-fg-2">
          <Icon aria-hidden="true" className="h-4 w-4" />
        </span>
        {label}
      </dt>
      <dd className="text-end text-sm font-semibold text-fg">{value || "—"}</dd>
    </div>
  );
}
