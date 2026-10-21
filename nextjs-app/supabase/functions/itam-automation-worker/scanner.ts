import { businessDaysBetween, elapsedWeekdayMinutesBetween, calendarDaysUntil, scannerSchedule } from "./calendar.ts";
import { safeUrl } from "./core.ts";
import type { AutomationDb } from "./db.ts";
import type { DigestSection, JsonObject, MessageLanguage, TemplateKey } from "./types.ts";

interface UserRow { id: string; email: string; full_name: string | null; role_id: string; employee_id: string | null; }
interface RoleRow { id: string; key: string; }
interface MaintenanceRow { id: string; asset_id: string; technician_id: string | null; priority: string | null; workflow_stage: string | null; problem_description: string | null; status: string; reported_at: string; updated_at: string; }
interface AssetRow { id: string; asset_tag: string | null; name: string | null; warranty_end: string | null; purchase_date: string | null; lifespan_months: number | null; }
interface RequestRow {
  id: string; request_number: string; status: string; responsible_employee_id: string | null;
  created_by: string | null; beneficiary_employee_id: string | null;
  pickup_date: string | null; return_date: string | null; created_at: string; updated_at: string;
}
interface RequestEventRow { id: string; request_id: string; event_type: string; created_at: string; metadata: JsonObject; }
interface AssignmentRow { id: string; employee_id: string; due_return_date: string | null; status: string; }

export interface ScanMetrics { [key: string]: number; scanned: number; enqueued: number; duplicates: number; skipped: number; }

function isoDate(date: Date): string { return date.toISOString().slice(0, 10); }

export function usefulLifeDate(asset: AssetRow): string | null {
  if (!asset.purchase_date || !asset.lifespan_months) return null;
  const [year, month, day] = asset.purchase_date.split("-").map(Number);
  const targetMonth = month - 1 + asset.lifespan_months;
  const lastDay = new Date(Date.UTC(year, targetMonth + 1, 0)).getUTCDate();
  const value = new Date(Date.UTC(year, targetMonth, Math.min(day, lastDay)));
  return Number.isFinite(value.getTime()) ? isoDate(value) : null;
}

function latestEvent(events: RequestEventRow[], requestId: string, types: string[], targetStatus?: string): string | undefined {
  return events.filter(event => event.request_id === requestId && types.includes(event.event_type)
      && (event.event_type !== "status_changed" || !targetStatus || event.metadata.to === targetStatus))
    .map(event => event.created_at).sort().at(-1);
}

export async function runScanner(db: AutomationDb, now: Date, appBaseUrl: string, language: MessageLanguage = "ar", dailyDigestEnabled = true): Promise<ScanMetrics> {
  const metrics: ScanMetrics = { scanned: 0, enqueued: 0, duplicates: 0, skipped: 0 };
  const [roles, users, maintenance, assets, requests, assignments] = await Promise.all([
    db.selectAll<RoleRow>("roles", "select=id,key&key=in.(employee,technician,warehouse_manager,it_manager,admin)&order=id.asc"),
    db.selectAll<UserRow>("app_users", "select=id,email,full_name,role_id,employee_id&is_active=eq.true&approval_status=eq.approved&email=not.is.null&order=id.asc"),
    db.selectAll<MaintenanceRow>("maintenance_records", "select=id,asset_id,technician_id,priority,workflow_stage,problem_description,status,reported_at,updated_at&status=in.(open,in_progress)&order=id.asc"),
    db.selectAll<AssetRow>("assets", "select=id,asset_tag,name,warranty_end,purchase_date,lifespan_months&is_active=eq.true&order=id.asc"),
    // This is the same operational request-state source used by My Daily
    // Tasks and the Manager decision queue; the email only aggregates it.
    db.selectAll<RequestRow>("requests", "select=id,request_number,status,responsible_employee_id,created_by,beneficiary_employee_id,pickup_date,return_date,created_at,updated_at&status=in.(under_review,approved,auto_provisioning,provisioned,stock_shortage,preparing,ready_for_pickup,delivered,partially_returned,overdue,returned,needs_clarification)&order=id.asc"),
    db.selectAll<AssignmentRow>("asset_assignments", "select=id,employee_id,due_return_date,status&status=eq.active&due_return_date=not.is.null&order=id.asc"),
  ]);
  const events: RequestEventRow[] = [];
  for (let offset = 0; offset < requests.length; offset += 100) {
    const requestIds = requests.slice(offset, offset + 100).map(request => request.id).join(",");
    events.push(...await db.selectAll<RequestEventRow>("request_events", `select=id,request_id,event_type,created_at,metadata&request_id=in.(${requestIds})&event_type=in.(submitted,approved,status_changed,inspected_return)&order=created_at.asc,id.asc`));
  }
  metrics.scanned = maintenance.length + assets.length + requests.length + assignments.length;

  const roleKeyById = new Map(roles.map(role => [role.id, role.key]));
  const usersByRole = (key: string) => users.filter(user => roleKeyById.get(user.role_id) === key);
  const userById = new Map(users.map(user => [user.id, user]));
  const userByEmployeeId = new Map(users.filter(user => user.employee_id).map(user => [user.employee_id!, user]));
  const assetById = new Map(assets.map(asset => [asset.id, asset]));
  const managers = usersByRole("it_manager").length ? usersByRole("it_manager") : usersByRole("admin");
  const warehouse = usersByRole("warehouse_manager");
  const office = usersByRole("employee");
  const warehouseWithFallback = warehouse.length ? warehouse : managers;
  const schedule = scannerSchedule(now);

  const enqueue = async (template: TemplateKey, eventType: string, eventKey: string, recipient: UserRow, referenceType: string, referenceId: string | null, payload: JsonObject, priority = 0) => {
    const id = await db.enqueue({
      p_logical_message_key: `${eventKey}:${recipient.id}`, p_event_key: `${eventKey}:${recipient.id}`,
      p_event_type: eventType, p_recipient_type: roleKeyById.get(recipient.role_id) ?? "user",
      p_recipient_ref: recipient.id, p_recipient_email: recipient.email,
      p_reference_type: referenceType, p_reference_id: referenceId,
      p_template_key: template, p_language: language, p_payload: payload,
      p_priority: priority, p_scheduled_for: now.toISOString(),
    });
    if (id) metrics.enqueued += 1; else metrics.duplicates += 1;
  };

  for (const record of maintenance) {
    const days = businessDaysBetween(new Date(record.updated_at || record.reported_at), now);
    const asset = assetById.get(record.asset_id);
    const threshold = [10, 6, 2].find(candidate => days >= candidate);
    const basePayload: JsonObject = {
      maintenance_id: record.id, asset_id: record.asset_id, asset_tag: asset?.asset_tag ?? null,
      priority: record.priority, workflow_stage: record.workflow_stage, problem_description: record.problem_description,
      // Keep the idempotency payload stable for the life of this threshold event.
      // The same event key is intentionally revisited by each hourly scan; using
      // the continuously increasing elapsed-day value here would turn a safe
      // duplicate into an event-key conflict after the first enqueue.
      reported_at: record.reported_at, business_days: threshold, link: `/maintenance?record=${record.id}`,
    };
    if (threshold) {
      const recipients = threshold === 2
        ? [record.technician_id ? userById.get(record.technician_id) : undefined]
        : threshold === 6
          ? [record.technician_id ? userById.get(record.technician_id) : undefined, ...warehouse]
          : managers;
      for (const recipient of recipients.filter((value): value is UserRow => Boolean(value))) {
        await enqueue(threshold === 10 ? "maintenance_escalated" : "maintenance_idle_reminder", "maintenance_idle", `maintenance:${record.id}:idle:${threshold}`, recipient, "maintenance_record", record.id, { ...basePayload, threshold_days: threshold }, threshold);
      }
      if (recipients.filter(Boolean).length === 0) await db.recordHealth(`missing-maintenance-recipient:${record.id}:${threshold}`, "missing_recipient_email", threshold === 10 ? "critical" : "warning", { reference_type: "maintenance_record", reference_id: record.id, threshold_days: threshold });
    }
  }

  for (const request of requests) {
    let rule: "under_review" | "accepted_not_preparing" | "return_inspection_pending" | null = null;
    let threshold = 0;
    let startedAt = request.updated_at || request.created_at;
    if (request.status === "under_review") { rule = "under_review"; threshold = 1440; startedAt = latestEvent(events, request.id, ["submitted", "status_changed"], "under_review") ?? startedAt; }
    if (request.status === "approved") { rule = "accepted_not_preparing"; threshold = 1440; startedAt = latestEvent(events, request.id, ["approved", "status_changed"], "approved") ?? startedAt; }
    if (request.status === "returned" && !events.some(event => event.request_id === request.id && event.event_type === "inspected_return")) { rule = "return_inspection_pending"; threshold = 480; startedAt = latestEvent(events, request.id, ["status_changed"], "returned") ?? startedAt; }
    if (!rule) continue;
    const minutes = elapsedWeekdayMinutesBetween(new Date(startedAt), now);
    if (minutes < threshold) continue;
    const responsible = request.responsible_employee_id && userByEmployeeId.has(request.responsible_employee_id) ? [userByEmployeeId.get(request.responsible_employee_id)!] : [];
    const recipients = Array.from(new Map([...responsible, ...warehouse].map(recipient => [recipient.id, recipient])).values());
    if (recipients.length === 0) recipients.push(...managers);
    if (recipients.length === 0) await db.recordHealth(`missing-sla-recipient:${request.id}:${rule}`, "missing_recipient_email", "critical", { reference_type: "request", reference_id: request.id, rule });
    // A stalled-operation notification is emitted once per rule threshold. Keep
    // its payload stable across hourly rescans so the outbox dedupe is a true
    // duplicate rather than a conflicting reuse of the same event key.
    for (const recipient of recipients) await enqueue("sla_stalled_operation", "sla_stalled", `request:${request.id}:sla:${rule}:${threshold}`, recipient, "request", request.id, { rule, request_id: request.id, request_number: request.request_number, status: request.status, elapsed_minutes_excluding_weekends: threshold, link: `/requests/${request.id}` }, 8);
  }

  for (const kind of ["warranty", "useful_life"] as const) {
    const thresholds = kind === "warranty" ? [90, 30, 7, 0] : [90, 0];
    for (const asset of assets) {
      const target = kind === "warranty" ? asset.warranty_end : usefulLifeDate(asset);
      if (!target) continue;
      const days = calendarDaysUntil(target, now);
      if (!thresholds.includes(days)) continue;
      const recipients = kind === "warranty"
        ? Array.from(new Map([...(warehouse.length ? warehouse : managers), ...(days <= 7 ? managers : [])].map(recipient => [recipient.id, recipient])).values())
        : managers;
      if (recipients.length === 0) await db.recordHealth(`missing-${kind}-recipient:${asset.id}:${days}`, "missing_recipient_email", "warning", { reference_type: "asset", reference_id: asset.id, threshold_days: days });
      for (const recipient of recipients) await enqueue(kind === "warranty" ? "warranty_threshold" : "useful_life_threshold", `${kind}_threshold`, `asset:${asset.id}:${kind}:${days}:${target}`, recipient, "asset", asset.id, { kind, assets: [{ asset_id: asset.id, asset_tag: asset.asset_tag, name: asset.name, threshold_days: days, target_date: target, link: `/assets/${asset.id}` }], link: "/assets" }, 5);
    }
  }

  // Return reminders are date-keyed, so an hourly scanner cannot duplicate a
  // reminder for the same assignment/recipient/day.  They use assignment data
  // (the authoritative durable-custody source), not a copied task state.
  for (const assignment of assignments) {
    if (!assignment.due_return_date) continue;
    const days = calendarDaysUntil(assignment.due_return_date, now);
    const recipient = userByEmployeeId.get(assignment.employee_id);
    if (recipient && (days === 2 || days === 0)) {
      const template = days === 2 ? "return_reminder_two_days" : "return_reminder_due_today";
      const event = days === 2 ? "return-reminder-2d" : "return-reminder-due";
      await enqueue(template, event, `${event}/${assignment.id}/${schedule.dateKey}`, recipient, "asset_assignment", assignment.id, {
        return_date: assignment.due_return_date, summary: language === "ar" ? "يرجى ترتيب إعادة الأصل في الموعد المحدد." : "Please arrange return of the assigned asset by the due date.", link: "/my-assets",
      }, 15);
    }
    if (days < 0) {
      for (const recipient of warehouseWithFallback) await enqueue("return_overdue_internal", "return-overdue-internal", `return-overdue-internal/${assignment.id}/${schedule.dateKey}`, recipient, "asset_assignment", assignment.id, {
        return_date: assignment.due_return_date, summary: language === "ar" ? "أصل متأخر عن الإرجاع يحتاج متابعة." : "An assigned asset is overdue for return and needs follow-up.", link: "/my-tasks",
      }, 18);
    }
  }

  const section = (title: string, count: number): DigestSection => ({ title, count });
  const activeMaintenance = maintenance.length;
  const stalled = requests.length;
  const sendReport = async (template: TemplateKey, recipients: UserRow[], event: string, sections: DigestSection[], periodStart = schedule.dateKey) => {
    if (sections.every(item => item.count === 0)) { metrics.skipped += 1; return; }
    if (recipients.length === 0) await db.recordHealth(`missing-report-recipient:${event}:${schedule.dateKey}`, "missing_recipient_email", "warning", { reference_type: "automation_report", report_date: schedule.dateKey });
    for (const recipient of recipients) await enqueue(template, event, `${event}:${schedule.dateKey}`, recipient, "automation_report", null, template.startsWith("weekly") || template.startsWith("monthly") ? { period_start: periodStart, period_end: schedule.dateKey, sections, link: "/dashboard" } : { report_date: schedule.dateKey, sections, link: "/dashboard" });
  };
  const labels = language === "ar"
    ? { activeMaintenance: "الصيانة النشطة", openOperations: "العمليات المفتوحة", stalledOperations: "العمليات المتعثرة", assetsMonitored: "الأصول الخاضعة للمتابعة" }
    : { activeMaintenance: "Active maintenance", openOperations: "Open operations", stalledOperations: "Stalled operations", assetsMonitored: "Assets monitored" };
  // EDIT 5: exactly one consolidated 09:00 Riyadh digest per eligible user.
  // Rows use the same current authoritative request states as the corresponding
  // in-app work queues; completed/terminal rows are excluded above.
  if (dailyDigestEnabled && schedule.morningDigest) {
    const enqueueDaily = async (template: TemplateKey, event: string, recipient: UserRow, sections: DigestSection[], link: string) => {
      if (sections.every(item => item.count === 0)) { metrics.skipped += 1; return; }
      await enqueue(template, event, `${event}:${schedule.dateKey}`, recipient, "daily_tasks", null, {
        recipient_name: recipient.full_name ?? undefined,
        sections,
        link,
      }, 2);
    };
    for (const recipient of managers) {
      const approvals = requests.filter(r => r.status === "under_review").length;
      const shortages = requests.filter(r => r.status === "stock_shortage").length;
      await enqueueDaily("daily_manager_digest", "daily-manager-digest", recipient, [
        section(language === "ar" ? "طلبات تنتظر الاعتماد" : "Requests awaiting approval", approvals),
        section(language === "ar" ? "طلبات تحتاج توفير كمية إضافية" : "Requests needing additional quantity", shortages),
        section(language === "ar" ? "حالات صيانة تحتاج متابعة" : "Maintenance cases needing attention", activeMaintenance),
      ], "/alerts");
    }
    for (const recipient of warehouseWithFallback) {
      const preparing = requests.filter(r => ["approved", "auto_provisioning", "provisioned", "stock_shortage", "preparing"].includes(r.status)).length;
      const ready = requests.filter(r => r.status === "ready_for_pickup").length;
      const returns = requests.filter(r => ["delivered", "partially_returned", "overdue"].includes(r.status)).length;
      await enqueueDaily("daily_warehouse_digest", "daily-warehouse-digest", recipient, [
        section(language === "ar" ? "طلبات تنتظر التجهيز" : "Requests awaiting preparation", preparing),
        section(language === "ar" ? "طلبات جاهزة للتسليم" : "Requests ready for pickup", ready),
        section(language === "ar" ? "مرتجعات تحتاج متابعة" : "Returns needing follow-up", returns),
      ], "/my-tasks");
    }
    for (const recipient of office) {
      const own = requests.filter(r => r.created_by === recipient.id || (recipient.employee_id && r.beneficiary_employee_id === recipient.employee_id));
      const clarification = own.filter(r => r.status === "needs_clarification").length;
      const ready = own.filter(r => r.status === "ready_for_pickup").length;
      const returns = own.filter(r => ["delivered", "partially_returned", "overdue"].includes(r.status)).length;
      await enqueueDaily("daily_office_employee_digest", "daily-office-digest", recipient, [
        section(language === "ar" ? "طلبات تحتاج توضيحًا" : "Requests needing clarification", clarification),
        section(language === "ar" ? "طلبات جاهزة للاستلام" : "Requests ready for pickup", ready),
        section(language === "ar" ? "أصول أو طلبات إرجاع تحتاج إجراء" : "Return items needing action", returns),
      ], "/my-tasks");
    }
  }
  if (schedule.endOfDay) await sendReport("management_end_of_day", managers, "management-eod", [section(labels.activeMaintenance, activeMaintenance), section(labels.stalledOperations, stalled)]);
  if (schedule.weekly) {
    const weekStart = isoDate(new Date(now.getTime() - 6 * 86_400_000));
    await sendReport("weekly_warehouse_report", warehouseWithFallback, "warehouse-weekly", [section(labels.activeMaintenance, activeMaintenance)], weekStart);
    await sendReport("weekly_maintenance_report", managers, "maintenance-weekly", [section(labels.activeMaintenance, activeMaintenance)], weekStart);
  }
  if (schedule.monthly) await sendReport("monthly_management_report", managers, "management-monthly", [section(labels.assetsMonitored, assets.length), section(labels.activeMaintenance, activeMaintenance)], isoDate(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1))));

  safeUrl(appBaseUrl, "/dashboard");
  return metrics;
}
