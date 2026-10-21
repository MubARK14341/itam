import { assertNoFinancialFields, escapeHtml, safeUrl } from "./core.ts";
import type {
  CustodyProofPayload,
  DigestPayload,
  DigestSection,
  MaintenancePayload,
  MessageLanguage,
  ReportPayload,
  NotificationPayload,
  SlaPayload,
  TemplateKey,
  TemplatePayloadMap,
  ThresholdPayload,
} from "./types.ts";

export interface RenderedTemplate {
  subject: string;
  html: string;
  text: string;
}

interface TemplateContext {
  baseUrl: string;
  language: MessageLanguage;
}

const COPY = {
  ar: {
    maintenance_opened: "تم فتح سجل صيانة",
    maintenance_idle_reminder: "تذكير بمتابعة الصيانة",
    maintenance_escalated: "تصعيد صيانة متأخرة",
    warehouse_daily_digest: "ملخص المستودع الصباحي",
    management_end_of_day: "تقرير نهاية اليوم",
    custody_delivery_proof: "إثبات تسليم عهدة",
    warranty_threshold: "تنبيه انتهاء الضمان",
    useful_life_threshold: "تنبيه العمر الافتراضي",
    sla_stalled_operation: "تنبيه SLA لعملية متوقفة",
    automation_failure: "تنبيه فشل الأتمتة",
    weekly_warehouse_report: "التقرير الأسبوعي للمستودع",
    weekly_maintenance_report: "التقرير الأسبوعي للصيانة",
    monthly_management_report: "التقرير الشهري للإدارة",
    daily_manager_digest: "مهامك وقراراتك اليوم",
    daily_warehouse_digest: "مهام المستودع اليوم",
    daily_office_employee_digest: "مهامك اليوم",
    portal_request_created_customer: "تم استلام طلبك",
    portal_request_created_internal: "طلب عميل جديد يحتاج مراجعة",
    internal_request_created_requester: "تم استلام طلبك الداخلي",
    internal_request_created_manager: "طلب داخلي جديد يحتاج مراجعة",
    request_needs_clarification: "نحتاج توضيحًا لإكمال طلبك",
    request_approved: "تم اعتماد طلبك",
    request_rejected: "تم رفض طلبك",
    request_cancelled: "تم إلغاء طلبك",
    request_ready_for_pickup: "طلبك جاهز للاستلام",
    additional_quantity_required_internal: "الكمية المتاحة تحتاج مراجعة",
    return_reminder_two_days: "تذكير بإرجاع الأصل",
    return_reminder_due_today: "موعد إرجاع الأصل اليوم",
    return_overdue_internal: "أصل متأخر عن الإرجاع",
    account_pending_user: "تم إنشاء حسابك وهو بانتظار الموافقة",
    account_pending_manager: "طلب حساب جديد ينتظر الموافقة",
    account_approved: "تمت الموافقة على حسابك",
    account_rejected: "تم رفض طلب الوصول",
    email_staging_test: "رسالة اختبار Staging",
    email_production_test: "رسالة اختبار Production",
    open: "فتح في ITAM",
    footer: "رسالة آلية من نظام إدارة أصول تقنية المعلومات.",
  },
  en: {
    maintenance_opened: "Maintenance record opened",
    maintenance_idle_reminder: "Maintenance follow-up reminder",
    maintenance_escalated: "Overdue maintenance escalation",
    warehouse_daily_digest: "Warehouse morning digest",
    management_end_of_day: "End-of-day report",
    custody_delivery_proof: "Asset custody delivery proof",
    warranty_threshold: "Warranty expiry alert",
    useful_life_threshold: "Useful-life threshold alert",
    sla_stalled_operation: "Stalled-operation SLA alert",
    automation_failure: "Automation failure alert",
    weekly_warehouse_report: "Weekly warehouse report",
    weekly_maintenance_report: "Weekly maintenance report",
    monthly_management_report: "Monthly management report",
    daily_manager_digest: "Your Tasks and Decisions Today",
    daily_warehouse_digest: "Warehouse Tasks Today",
    daily_office_employee_digest: "Your Tasks Today",
    portal_request_created_customer: "We Received Your Request",
    portal_request_created_internal: "New customer request needs review",
    internal_request_created_requester: "We received your internal request",
    internal_request_created_manager: "New internal request needs review",
    request_needs_clarification: "Clarification Needed for Request",
    request_approved: "Your request has been approved",
    request_rejected: "Your Request Was Rejected",
    request_cancelled: "Your Request Was Cancelled",
    request_ready_for_pickup: "Your Request Is Ready for Pickup",
    additional_quantity_required_internal: "Available quantity needs review",
    return_reminder_two_days: "Asset return reminder",
    return_reminder_due_today: "Asset return is due today",
    return_overdue_internal: "Asset return is overdue",
    account_pending_user: "Your account was created and is pending approval",
    account_pending_manager: "A new account request is awaiting approval",
    account_approved: "Your account has been approved",
    account_rejected: "Your access request was rejected",
    email_staging_test: "Staging Test Email",
    email_production_test: "Production Test Email",
    open: "Open in ITAM",
    footer: "Automated message from the IT Asset Management system.",
  },
} as const;

function value(input: unknown): string {
  if (input == null || input === "") return "—";
  if (Array.isArray(input)) return input.map(valueItem => value(valueItem)).join(", ");
  if (typeof input === "object") return JSON.stringify(input);
  return String(input);
}

function rows(items: Array<[string, unknown]>): { html: string; text: string } {
  const filtered = items.filter(([, itemValue]) => itemValue != null && itemValue !== "");
  return {
    html: filtered.map(([label, itemValue]) => `<tr><th style="padding:8px;text-align:start;border-bottom:1px solid #e5e7eb">${escapeHtml(label)}</th><td style="padding:8px;border-bottom:1px solid #e5e7eb">${escapeHtml(value(itemValue))}</td></tr>`).join(""),
    text: filtered.map(([label, itemValue]) => `${label}: ${value(itemValue)}`).join("\n"),
  };
}

function digestSections(sections: DigestSection[]): { html: string; text: string } {
  const nonZero = sections.filter(section => Number(section.count) > 0);
  return {
    html: nonZero.map(section => {
      const items = (section.items ?? []).slice(0, 5).map(item => `<li>${escapeHtml(item.label)}${item.detail ? ` — ${escapeHtml(item.detail)}` : ""}</li>`).join("");
      return `<section style="margin:16px 0"><h3>${escapeHtml(section.title)} (${section.count})</h3>${items ? `<ul>${items}</ul>` : ""}</section>`;
    }).join(""),
    text: nonZero.map(section => `${section.title} (${section.count})${(section.items ?? []).slice(0, 5).map(item => `\n- ${item.label}${item.detail ? ` — ${item.detail}` : ""}`).join("")}`).join("\n\n"),
  };
}

function bodyFor<K extends TemplateKey>(key: K, payload: TemplatePayloadMap[K], language: MessageLanguage): { html: string; text: string; link: string } {
  if (key === "maintenance_opened" || key === "maintenance_idle_reminder" || key === "maintenance_escalated") {
    const p = payload as MaintenancePayload;
    const table = rows(language === "ar" ? [
      ["رقم الصيانة", p.maintenance_id], ["الأصل", p.asset_tag], ["الأولوية", p.priority],
      ["المرحلة", p.workflow_stage], ["الوصف", p.problem_description], ["أيام العمل", p.business_days],
    ] : [
      ["Maintenance ID", p.maintenance_id], ["Asset", p.asset_tag], ["Priority", p.priority],
      ["Stage", p.workflow_stage], ["Description", p.problem_description], ["Business days", p.business_days],
    ]);
    return { html: `<table style="width:100%;border-collapse:collapse">${table.html}</table>`, text: table.text, link: p.link };
  }
  if (key === "warehouse_daily_digest" || key === "management_end_of_day") {
    const p = payload as DigestPayload;
    const sections = digestSections(p.sections);
    return { html: sections.html, text: sections.text, link: p.link };
  }
  if (key === "custody_delivery_proof") {
    const p = payload as CustodyProofPayload;
    const table = rows(language === "ar" ? [
      ["رقم الإثبات", p.proof_number], ["المستلم", p.recipient_name], ["وقت التسليم", p.assigned_at],
      ["رمز الأصل", p.asset_tag], ["الأصل", p.asset_name], ["الشركة/الموديل", [p.brand, p.model].filter(Boolean).join(" ")],
      ["الرقم التسلسلي", p.serial_number], ["الحالة", p.condition], ["الملحقات", p.accessories],
      ["الموقع", p.location], ["تاريخ الإرجاع", p.return_date], ["رقم الطلب", p.request_number],
    ] : [
      ["Proof number", p.proof_number], ["Recipient", p.recipient_name], ["Delivered at", p.assigned_at],
      ["Asset tag", p.asset_tag], ["Asset", p.asset_name], ["Brand/model", [p.brand, p.model].filter(Boolean).join(" ")],
      ["Serial", p.serial_number], ["Condition", p.condition], ["Accessories", p.accessories],
      ["Location", p.location], ["Return date", p.return_date], ["Request", p.request_number],
    ]);
    return { html: `<table style="width:100%;border-collapse:collapse">${table.html}</table>`, text: table.text, link: p.link };
  }
  if (key === "warranty_threshold" || key === "useful_life_threshold") {
    const p = payload as ThresholdPayload;
    const items = p.assets.map(asset => `<li>${escapeHtml(asset.asset_tag ?? asset.name ?? asset.asset_id)} — ${escapeHtml(asset.target_date)} (${asset.threshold_days})</li>`).join("");
    const text = p.assets.map(asset => `- ${asset.asset_tag ?? asset.name ?? asset.asset_id} — ${asset.target_date} (${asset.threshold_days})`).join("\n");
    return { html: `<ul>${items}</ul>`, text, link: p.link };
  }
  if (key === "sla_stalled_operation") {
    const p = payload as SlaPayload;
    const table = rows(language === "ar" ? [
      ["الطلب", p.request_number], ["الحالة", p.status], ["قاعدة SLA", p.rule], ["الدقائق المنقضية دون الجمعة والسبت", p.elapsed_minutes_excluding_weekends],
    ] : [
      ["Request", p.request_number], ["Status", p.status], ["SLA rule", p.rule], ["Elapsed minutes excluding Friday/Saturday", p.elapsed_minutes_excluding_weekends],
    ]);
    return { html: `<table style="width:100%;border-collapse:collapse">${table.html}</table>`, text: table.text, link: p.link };
  }
  if (key === "automation_failure") {
    const p = payload as TemplatePayloadMap["automation_failure"];
    const table = rows(language === "ar" ? [["المشكلة", p.issue], ["الشدة", p.severity], ["وقت الرصد", p.observed_at]] : [["Issue", p.issue], ["Severity", p.severity], ["Observed at", p.observed_at]]);
    return { html: `<table style="width:100%;border-collapse:collapse">${table.html}</table>`, text: table.text, link: p.link };
  }
  if ([
    "daily_manager_digest", "daily_warehouse_digest", "daily_office_employee_digest",
    "portal_request_created_customer", "portal_request_created_internal",
    "internal_request_created_requester", "internal_request_created_manager",
    "request_needs_clarification", "request_approved", "request_rejected",
    "request_cancelled", "request_ready_for_pickup", "additional_quantity_required_internal",
    "return_reminder_two_days", "return_reminder_due_today", "return_overdue_internal",
    "account_pending_user", "account_pending_manager", "account_approved", "account_rejected", "email_staging_test", "email_production_test",
  ].includes(key)) {
    const p = payload as NotificationPayload;
    const details = rows(language === "ar" ? [
      ["الطلب", p.request_number], ["المشروع", p.project_name], ["المدينة", p.city],
      ["موعد الاستلام", p.pickup_date], ["موعد الإرجاع", p.return_date],
      ["التفاصيل", p.summary], ["السبب", p.reason],
    ] : [
      ["Request", p.request_number], ["Project", p.project_name], ["City", p.city],
      ["Pickup date", p.pickup_date], ["Return date", p.return_date],
      ["Details", p.summary], ["Reason", p.reason],
    ]);
    const sections = p.sections?.length ? digestSections(p.sections) : { html: "", text: "" };
    const greeting = p.recipient_name
      ? `<p>${escapeHtml(language === "ar" ? `صباح الخير ${p.recipient_name}` : `Hello ${p.recipient_name}`)}</p>`
      : "";
    return { html: `${greeting}<table style="width:100%;border-collapse:collapse">${details.html}</table>${sections.html}`, text: `${p.recipient_name ? `${language === "ar" ? "صباح الخير" : "Hello"} ${p.recipient_name}\n\n` : ""}${details.text}${sections.text ? `\n\n${sections.text}` : ""}`, link: p.link };
  }
  const p = payload as ReportPayload;
  const sections = digestSections(p.sections);
  const period = rows(language === "ar" ? [["بداية الفترة", p.period_start], ["نهاية الفترة", p.period_end]] : [["Period start", p.period_start], ["Period end", p.period_end]]);
  return { html: `<table style="width:100%;border-collapse:collapse">${period.html}</table>${sections.html}`, text: `${period.text}\n\n${sections.text}`, link: p.link };
}

export function renderTemplate<K extends TemplateKey>(key: K, payload: TemplatePayloadMap[K], context: TemplateContext): RenderedTemplate {
  assertNoFinancialFields(payload);
  const copy = COPY[context.language];
  const title = copy[key];
  const body = bodyFor(key, payload, context.language);
  const url = safeUrl(context.baseUrl, body.link);
  const dir = context.language === "ar" ? "rtl" : "ltr";
  const requestNumber = (payload as NotificationPayload).request_number;
  const subject = requestNumber ? `${title} ${requestNumber}` : title;
  const html = `<!doctype html><html lang="${context.language}" dir="${dir}"><body style="margin:0;background:#f3f4f6;font-family:Arial,sans-serif;color:#111827"><main style="max-width:640px;margin:24px auto;background:#fff;border-radius:12px;padding:24px"><h1 style="font-size:22px;margin:0 0 20px">${escapeHtml(subject)}</h1>${body.html}<p style="margin:24px 0"><a href="${escapeHtml(url)}" style="display:inline-block;padding:10px 16px;background:#2563eb;color:#fff;text-decoration:none;border-radius:8px">${escapeHtml(copy.open)}</a></p><footer style="margin-top:24px;padding-top:16px;border-top:1px solid #e5e7eb;color:#6b7280;font-size:12px">${escapeHtml(copy.footer)}</footer></main></body></html>`;
  const text = `${subject}\n\n${body.text}\n\n${copy.open}: ${url}\n\n${copy.footer}`;
  return { subject, html, text };
}
