"use client";

// استيراد المخزون من CSV — معالج: رفع → فحص (dry-run) → مراجعة → اعتماد.
// لا كتابة قبل الاعتماد. الأمان في RPC import_inventory (يعيد التحقق + يصفّر الماليات).

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  Upload, Download, ArrowRight, CheckCircle2, AlertTriangle, FileWarning, FileSpreadsheet, FileText, Lock, Check, Info,
} from "lucide-react";
import { Card } from "@/components/ui/card";
import { Button, buttonClass } from "@/components/ui/button";
import { PageHeader } from "@/components/ui/page-header";
import { inputClass } from "@/components/ui/form";
import { EmptyState } from "@/components/ui/empty-state";
import { Spinner } from "@/components/ui/spinner";
import { Toast, type ToastState } from "@/components/ui/toast";
import { useSession, canCreateAsset, canSeeFinancial, useCan } from "@/lib/session";
import { useAppPreferences } from "@/components/providers/app-preferences-provider";
import { getFormOptions, getExistingIdentifiers, importInventory } from "@/lib/queries";
import { downloadCSV } from "@/lib/export";
import { interpolate } from "@/lib/i18n";
import {
  parseCsv, validateImport, TEMPLATE_HEADERS,
  type ImportValidation, type ImportMessages, type ImportRefs, type NormalizedItem, type CanonField,
} from "@/lib/csv-import";
import { inferColumnMapping, mappedImportRecords, importTemplateExamples, issueRowsPage, type ColumnMapping } from "@/lib/csv-column-mapping";

type Step = "upload" | "review" | "done";
type WizardStep = "upload" | "validate" | "review" | "import";
const WIZARD: WizardStep[] = ["upload", "validate", "review", "import"];

export default function ImportInventoryPage() {
  const { role } = useSession();
  const { t } = useAppPreferences();
  const ti = t.import;
  const L = ti.ledger;
  const mappingText = t.importTools;
  const can = useCan();
  const write = can("asset.import") && can("asset.create");
  const canFin = canSeeFinancial(role);

  const [step, setStep] = useState<Step>("upload");
  const [busy, setBusy] = useState(false);
  const [fileName, setFileName] = useState("");
  const [validation, setValidation] = useState<ImportValidation | null>(null);
  const [result, setResult] = useState<{ assets: number; consumables: number } | null>(null);
  const [toast, setToast] = useState<ToastState>(null);
  const [dragOver, setDragOver] = useState(false);
  const [sourceRecords, setSourceRecords] = useState<string[][]>([]);
  const [referenceData, setReferenceData] = useState<ImportRefs | null>(null);
  const [mapping, setMapping] = useState<ColumnMapping>([]);
  const [issuePage, setIssuePage] = useState(0);
  const [templateBusy, setTemplateBusy] = useState(false);
  // A file chosen before hydration cannot be replayed by React. Keep the native
  // picker disabled until its file/change handlers are attached.
  const [interactive, setInteractive] = useState(false);
  useEffect(() => setInteractive(true), []);

  const messages = useMemo<ImportMessages>(() => ({ ...ti.errors }), [ti.errors]);

  if (!write) {
    return (
      <Card>
        <EmptyState icon={Lock} title={ti.noPermission}
          action={<Link href="/assets" className={buttonClass("outline", "sm")}>{ti.backToAssets}</Link>} />
      </Card>
    );
  }

  async function downloadTemplate() {
    setTemplateBusy(true);
    try {
      const options = await getFormOptions();
      if (options.error) throw options.error;
      const example = importTemplateExamples(options, { asset: mappingText.templateAsset, consumable: mappingText.templateConsumable });
      downloadCSV("inventory-import-template.csv", TEMPLATE_HEADERS as string[], example);
    } catch {
      setToast({ type: "error", message: ti.readError });
    } finally { setTemplateBusy(false); }
  }

  function validateMapped(records: string[][], targets: ColumnMapping, refs: ImportRefs) {
    return validateImport(mappedImportRecords(records, targets), refs, {
      canFinancial: canFin, canCreateAssets: canCreateAsset(role), assetCreationDeniedMessage: ti.noPermission,
    }, messages);
  }

  function changeMapping(index: number, value: string) {
    const target = value === "" ? null : value as CanonField;
    if (target && mapping.some((field, column) => column !== index && field === target)) return;
    const next = mapping.map((field, column) => column === index ? target : field);
    setMapping(next);
    setIssuePage(0);
    if (referenceData) setValidation(validateMapped(sourceRecords, next, referenceData));
  }

  async function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    await processFile(file);
  }

  // نفس مسار القراءة والفحص سواء اختير الملف أو أُفلت في منطقة الرفع.
  async function processFile(file: File) {
    setFileName(file.name);
    setBusy(true);
    try {
      const text = await file.text();
      const records = parseCsv(text);
      const [opts, ids] = await Promise.all([getFormOptions(), getExistingIdentifiers()]);
      if (opts.error) throw opts.error;
      const refs: ImportRefs = {
        categories: opts.categories as ImportRefs["categories"],
        locations: opts.locations as ImportRefs["locations"],
        companies: opts.companies,
        suppliers: opts.suppliers as ImportRefs["suppliers"],
        existingSerials: ids.serials,
        existingRfids: ids.rfids,
        existingSkus: ids.skus,
      };
      const targets = inferColumnMapping(records[0] ?? []);
      const v = validateMapped(records, targets, refs);
      setSourceRecords(records); setReferenceData(refs); setMapping(targets); setIssuePage(0);
      setValidation(v);
      setStep("review");
    } catch {
      setToast({ type: "error", message: ti.readError });
    } finally {
      setBusy(false);
    }
  }

  function onDrop(e: React.DragEvent<HTMLLabelElement>) {
    e.preventDefault();
    setDragOver(false);
    if (busy || !interactive) return;
    const file = e.dataTransfer.files?.[0];
    if (file) void processFile(file);
  }

  function downloadErrors() {
    if (!validation) return;
    const rows = validation.rows
      .filter((r) => r.errors.length || r.warnings.length)
      .map((r) => [r.rowNumber, r.display, r.errors.join(" | "), r.warnings.join(" | ")]);
    downloadCSV("import-errors.csv", [ti.rowCol, ti.itemCol, ti.errorsCol, ti.warningsCol], rows);
  }

  async function confirm() {
    if (!validation || validation.error > 0) return;
    const items = validation.rows.map((r) => r.normalized).filter(Boolean) as NormalizedItem[];
    if (!items.length) return;
    setBusy(true);
    const res = await importInventory(items);
    setBusy(false);
    if (!res.ok) { setToast({ type: "error", message: ti.rpcError + (res.error ?? "") }); return; }
    setResult({ assets: res.assets, consumables: res.consumables });
    setStep("done");
  }

  function reset() {
    setValidation(null); setResult(null); setFileName(""); setStep("upload");
    setSourceRecords([]); setReferenceData(null); setMapping([]); setIssuePage(0);
  }

  const issueRows = validation?.rows.filter((r) => r.errors.length || r.warnings.length) ?? [];
  const issues = issueRowsPage(issueRows, issuePage);
  const canConfirm = !!validation && validation.error === 0 && (validation.valid + validation.warning) > 0;

  // مؤشّر الخطوات يلتفّ على حالة المعالج الحالية دون أي حالة جديدة:
  // رفع (بانتظار ملف) → فحص (أثناء القراءة) → مراجعة (نتيجة الفحص) → استيراد (أثناء الاعتماد / بعده).
  const current: WizardStep =
    step === "upload" ? (busy ? "validate" : "upload")
    : step === "review" ? (busy ? "import" : "review")
    : "import";
  const currentIndex = WIZARD.indexOf(current);
  const allDone = step === "done";

  return (
    <div>
      <PageHeader
        title={ti.title}
        description={ti.subtitle}
        actions={
          <Link href="/assets" className={buttonClass("outline", "md")}>
            <ArrowRight aria-hidden="true" className="h-4 w-4 ltr:rotate-180" />{ti.backToAssets}
          </Link>
        }
      />

      <div className="grid grid-cols-1 items-start gap-5 lg:grid-cols-[minmax(0,1fr)_320px]">
        <section aria-label={L.wizardLabel} className="ui-surface min-w-0 overflow-hidden">
          {/* مؤشّر الخطوات */}
          <ol aria-label={L.stepsLabel} className="grid grid-cols-2 gap-4 border-b border-line bg-surface-2 px-5 py-5 sm:grid-cols-4">
            {WIZARD.map((key, i) => {
              const done = allDone || i < currentIndex;
              const isCurrent = !allDone && i === currentIndex;
              return (
                <li key={key} aria-current={isCurrent ? "step" : undefined} className="flex min-w-0 items-center gap-2.5">
                  <span
                    aria-hidden="true"
                    className={`inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-[12.5px] font-semibold tabular-nums ${
                      done ? "tone-ok" : isCurrent ? "bg-brand text-brand-on" : "bg-sunk text-muted"
                    }`}
                  >
                    {done ? <Check className="h-4 w-4" /> : i + 1}
                  </span>
                  <span className="flex min-w-0 flex-col leading-tight">
                    <span className={`truncate text-[13px] font-semibold ${isCurrent ? "text-fg" : done ? "text-fg-2" : "text-muted"}`}>{L.steps[key]}</span>
                    <span className="truncate text-[11.5px] text-muted">{L.stepSubs[key]}</span>
                  </span>
                </li>
              );
            })}
          </ol>

          <div className="px-5 py-6 sm:px-6">
            {step === "upload" && (
              <div className="flex flex-col gap-4">
                <div>
                  <h2 className="font-display text-[17px] font-semibold text-fg">{L.uploadTitle}</h2>
                  <p className="mt-0.5 text-[13px] text-muted">{L.uploadDesc}</p>
                </div>

                <label
                  onDragOver={(e) => { e.preventDefault(); if (!busy && interactive) setDragOver(true); }}
                  onDragLeave={() => setDragOver(false)}
                  onDrop={onDrop}
                  className={`flex flex-col items-center justify-center gap-2 rounded-card border-[1.5px] border-dashed px-6 py-10 text-center transition-colors focus-within:ring-2 focus-within:ring-brand ${
                    busy ? "cursor-wait border-line-strong bg-surface-2" : dragOver ? "cursor-pointer border-brand bg-brand-soft" : "cursor-pointer border-line-strong bg-surface-2 hover:border-brand"
                  }`}
                >
                  {busy ? (
                    <>
                      <Spinner label={L.validatingTitle} />
                      <span className="max-w-md text-[12.5px] text-muted">{L.validatingDesc}</span>
                    </>
                  ) : (
                    <>
                      <span aria-hidden="true" className="inline-flex h-12 w-12 items-center justify-center rounded-xl border border-line bg-surface text-fg-2">
                        <Upload className="h-5 w-5" />
                      </span>
                      <span className="font-display text-[15px] font-semibold text-fg">{L.dropTitle}</span>
                      <span className="text-[12.5px] text-muted">{L.dropOr}</span>
                      <span className={buttonClass("primary", "md", "mt-1")}>
                        <FileSpreadsheet aria-hidden="true" className="h-4 w-4" />{ti.chooseFile}
                      </span>
                      <span className="text-xs text-muted">{ti.fileHint}</span>
                    </>
                  )}
                  <input type="file" accept=".csv,text/csv" className="sr-only" disabled={busy || !interactive} onChange={onFile} />
                </label>

                <div className="flex flex-wrap items-center gap-3 rounded-xl border border-line px-4 py-3">
                  <span aria-hidden="true" className="tone-info inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-[10px]">
                    <FileText className="h-4 w-4" />
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="text-[13.5px] font-semibold text-fg">{L.templateTitle}</p>
                    <p className="text-[12.5px] text-muted">{interpolate(L.templateDesc, { n: TEMPLATE_HEADERS.length })}</p>
                  </div>
                  <Button variant="outline" size="sm" onClick={() => void downloadTemplate()} disabled={templateBusy}><Download aria-hidden="true" className="h-4 w-4" />{ti.downloadTemplate}</Button>
                </div>
                <p className="text-xs leading-relaxed text-muted">{mappingText.templateHint}</p>

                {!canFin && (
                  <p role="note" className="flex items-start gap-2 rounded-xl bg-warn-soft px-3.5 py-2.5 text-[12.5px] text-warn">
                    <Info aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0" />{ti.financialHint}
                  </p>
                )}
              </div>
            )}

            {step === "review" && validation && (
              <div className="flex flex-col gap-4">
                <div>
                  <h2 className="font-display text-[17px] font-semibold text-fg">{L.reviewTitle}</h2>
                  <p className="mt-0.5 text-[13px] tabular-nums text-muted">{interpolate(L.reviewDesc, { n: validation.rows.length })}</p>
                </div>

                {sourceRecords[0]?.length > 0 && (
                  <fieldset className="min-w-0 rounded-xl border border-line p-4" disabled={busy}>
                    <legend className="px-1 text-sm font-semibold text-fg">{mappingText.title}</legend>
                    <p className="mb-3 text-xs leading-relaxed text-muted">{mappingText.hint}</p>
                    <div className="grid gap-3 sm:grid-cols-2">
                      {sourceRecords[0].map((header, index) => (
                        <label key={index} className="flex min-w-0 flex-col gap-1.5 text-xs text-fg-2">
                          <span className="truncate">{header || interpolate(mappingText.column, { n: index + 1 })}</span>
                          <select aria-label={interpolate(mappingText.mapColumn, { column: header || String(index + 1) })}
                            className={inputClass} value={mapping[index] ?? ""} onChange={(event) => changeMapping(index, event.target.value)}>
                            <option value="">{mappingText.ignore}</option>
                            {TEMPLATE_HEADERS.map((field) => <option key={field} value={field}
                              disabled={mapping.some((target, column) => column !== index && target === field)}>{mappingText.fields[field]}</option>)}
                          </select>
                        </label>
                      ))}
                    </div>
                  </fieldset>
                )}

                {validation.headerError ? (
                  <div role="alert" className="flex items-start gap-3 rounded-xl bg-bad-soft px-4 py-3.5">
                    <AlertTriangle aria-hidden="true" className="mt-0.5 h-5 w-5 shrink-0 text-bad" />
                    <div>
                      <p className="text-[13.5px] font-semibold text-bad">{ti.headerErrorTitle}</p>
                      <p className="mt-1 text-[13px] text-fg-2">{validation.headerError}</p>
                    </div>
                  </div>
                ) : (
                  <>
                    <dl className="grid grid-cols-1 gap-px overflow-hidden rounded-xl border border-line bg-line sm:grid-cols-3">
                      <SummaryCell tone="ok" n={validation.valid} label={ti.summaryValid} icon={CheckCircle2} />
                      <SummaryCell tone="warn" n={validation.warning} label={ti.summaryWarning} icon={AlertTriangle} />
                      <SummaryCell tone="bad" n={validation.error} label={ti.summaryError} icon={FileWarning} />
                    </dl>

                    {validation.error > 0 && (
                      <div role="alert" className="flex items-center gap-2 rounded-xl bg-bad-soft px-4 py-3 text-[13px] text-bad">
                        <FileWarning aria-hidden="true" className="h-4 w-4 shrink-0" /> {ti.fatalBlock}
                      </div>
                    )}

                    {issueRows.length > 0 ? (
                      <div className="overflow-hidden rounded-xl border border-line">
                        <div tabIndex={0} className="overflow-x-auto">
                          <table className="ui-table">
                            <caption className="sr-only">{L.issuesCaption}</caption>
                            <thead>
                              <tr>
                                <th scope="col">{ti.rowCol}</th>
                                <th scope="col">{ti.itemCol}</th>
                                <th scope="col">{ti.issuesCol}</th>
                              </tr>
                            </thead>
                            <tbody>
                              {issues.rows.map((r) => (
                                <tr key={r.rowNumber} className="align-top">
                                  <td className="tabular-nums text-muted" dir="ltr">{r.rowNumber}</td>
                                  <td className="text-fg">{r.display}</td>
                                  <td>
                                    <ul className="flex flex-col gap-1">
                                      {r.errors.map((e, i) => (
                                        <li key={`e${i}`} className="flex items-start gap-1.5 text-bad">
                                          <span aria-hidden="true" className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-current" />{e}
                                        </li>
                                      ))}
                                      {r.warnings.map((w, i) => (
                                        <li key={`w${i}`} className="flex items-start gap-1.5 text-warn">
                                          <span aria-hidden="true" className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-current" />{w}
                                        </li>
                                      ))}
                                    </ul>
                                  </td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                        <nav aria-label={mappingText.issuePages} className="flex flex-wrap items-center justify-between gap-2 border-t border-line px-4 py-3">
                          <span role="status" className="text-xs tabular-nums text-muted">{interpolate(mappingText.pageSummary, { from: issues.from, to: issues.to, total: issueRows.length, page: issues.page + 1, pages: issues.pages })}</span>
                          <div className="flex gap-2">
                            <Button variant="outline" size="sm" onClick={() => setIssuePage(issues.page - 1)} disabled={issues.page === 0}>{mappingText.previous}</Button>
                            <Button variant="outline" size="sm" onClick={() => setIssuePage(issues.page + 1)} disabled={issues.page + 1 >= issues.pages}>{mappingText.next}</Button>
                          </div>
                        </nav>
                      </div>
                    ) : (
                      <p role="status" className="flex items-center gap-2 rounded-xl bg-ok-soft px-4 py-3 text-[13px] text-ok">
                        <CheckCircle2 aria-hidden="true" className="h-4 w-4 shrink-0" />{L.noIssues}
                      </p>
                    )}
                  </>
                )}
              </div>
            )}

            {step === "done" && result && (
              <EmptyState
                icon={CheckCircle2}
                title={ti.doneTitle}
                description={<span className="tabular-nums">{ti.doneSummary.replace("{a}", String(result.assets)).replace("{c}", String(result.consumables))}</span>}
                action={
                  <>
                    <Link href="/assets" className={buttonClass("primary", "md")}>{ti.backToAssets}</Link>
                    <Button variant="outline" onClick={reset}>{ti.importAnother}</Button>
                  </>
                }
              />
            )}
          </div>

          {step === "review" && validation && (
            <div className="flex flex-wrap items-center justify-end gap-2 border-t border-line bg-surface-2 px-5 py-3.5">
              <Button variant="outline" onClick={reset}><ArrowRight aria-hidden="true" className="h-4 w-4 ltr:rotate-180" />{ti.back}</Button>
              {issueRows.length > 0 && <Button variant="outline" onClick={downloadErrors}><Download aria-hidden="true" className="h-4 w-4" />{ti.downloadErrors}</Button>}
              {canConfirm && (
                <Button onClick={confirm} disabled={busy}>
                  <CheckCircle2 aria-hidden="true" className="h-4 w-4" />
                  {busy ? ti.confirming : ti.confirm.replace("{n}", String(validation.valid + validation.warning))}
                </Button>
              )}
            </div>
          )}
        </section>

        <aside aria-label={L.fileCardTitle} className="flex min-w-0 flex-col gap-4">
          <section aria-labelledby="import-file-title" className="ui-surface flex flex-col gap-3 px-[18px] py-4">
            <h2 id="import-file-title" className="font-display text-sm font-semibold text-fg">{L.fileCardTitle}</h2>
            {fileName ? (
              <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-2 text-[13px]">
                <dt className="text-muted">{L.fileName}</dt>
                <dd className="truncate font-mono text-fg [unicode-bidi:isolate]" dir="ltr">{fileName}</dd>
                {validation && (
                  <>
                    <dt className="text-muted">{L.fileRows}</dt>
                    <dd className="tabular-nums text-fg">{validation.rows.length}</dd>
                    <dt className="text-muted">{L.fileIssues}</dt>
                    <dd className="tabular-nums text-fg">{issueRows.length}</dd>
                  </>
                )}
              </dl>
            ) : (
              <div className="flex flex-col items-center gap-1 rounded-xl border border-dashed border-line-strong bg-surface-2 px-4 py-5 text-center">
                <FileSpreadsheet aria-hidden="true" className="h-5 w-5 text-muted" />
                <p className="text-[13px] font-semibold text-fg-2">{L.noFile}</p>
                <p className="text-xs text-muted">{L.noFileHint}</p>
              </div>
            )}
          </section>

          <section aria-labelledby="import-how-title" className="ui-surface flex flex-col gap-3 px-[18px] py-4">
            <h2 id="import-how-title" className="font-display text-sm font-semibold text-fg">{ti.howToTitle}</h2>
            <ol className="flex flex-col gap-2.5">
              {[ti.how1, ti.how2, ti.how3].map((line, i) => (
                <li key={i} className="flex items-start gap-2.5 text-[13px] leading-relaxed text-fg-2">
                  <span aria-hidden="true" className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-sunk text-[11px] font-semibold tabular-nums text-fg-2">{i + 1}</span>
                  <span>{line}</span>
                </li>
              ))}
            </ol>
          </section>
        </aside>
      </div>

      <Toast toast={toast} onDone={() => setToast(null)} />
    </div>
  );
}

function SummaryCell({ tone, n, label, icon: Icon }: { tone: "ok" | "warn" | "bad"; n: number; label: string; icon: typeof CheckCircle2 }) {
  const tile = tone === "ok" ? "tone-ok" : tone === "warn" ? "tone-warn" : "tone-bad";
  return (
    <div className="flex items-center gap-3 bg-surface px-4 py-3.5">
      <span aria-hidden="true" className={`inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-[10px] ${tile}`}>
        <Icon className="h-4 w-4" />
      </span>
      <div className="flex min-w-0 flex-col-reverse">
        <dt className="text-[12.5px] text-muted">{label}</dt>
        <dd className={`font-display text-[22px] font-semibold leading-7 tabular-nums ${tone === "bad" && n > 0 ? "text-bad" : "text-fg"}`}>{n}</dd>
      </div>
    </div>
  );
}
