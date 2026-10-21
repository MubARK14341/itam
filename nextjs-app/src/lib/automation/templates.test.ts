import { describe, expect, it } from "vitest";
import { renderTemplate } from "../../../supabase/functions/itam-automation-worker/templates.ts";
import { TEMPLATE_KEYS } from "../../../supabase/functions/itam-automation-worker/types.ts";
import type { TemplateKey, TemplatePayloadMap } from "../../../supabase/functions/itam-automation-worker/types.ts";

const fixtures: Record<TemplateKey, TemplatePayloadMap[TemplateKey]> = {
  maintenance_opened: { maintenance_id: "M-1", link: "/maintenance" },
  maintenance_idle_reminder: { maintenance_id: "M-1", business_days: 2, link: "/maintenance" },
  maintenance_escalated: { maintenance_id: "M-1", business_days: 10, link: "/maintenance" },
  warehouse_daily_digest: { report_date: "2026-07-14", sections: [{ title: "Open", count: 1 }], link: "/dashboard" },
  management_end_of_day: { report_date: "2026-07-14", sections: [{ title: "Open", count: 1 }], link: "/dashboard" },
  custody_delivery_proof: { proof_number: "P-1", assignment_id: "AS-1", assigned_at: "2026-07-14T00:00:00Z", asset_id: "A-1", link: "/assets/A-1" },
  warranty_threshold: { kind: "warranty", assets: [{ asset_id: "A-1", threshold_days: 30, target_date: "2026-08-13", link: "/assets/A-1" }], link: "/assets" },
  useful_life_threshold: { kind: "useful_life", assets: [{ asset_id: "A-1", threshold_days: 0, target_date: "2026-07-14", link: "/assets/A-1" }], link: "/assets" },
  sla_stalled_operation: { rule: "under_review", request_id: "R-1", request_number: "REQ-1", status: "under_review", elapsed_minutes_excluding_weekends: 1440, link: "/requests/R-1" },
  automation_failure: { issue: "Backlog", severity: "critical", observed_at: "2026-07-14T00:00:00Z", link: "/settings" },
  weekly_warehouse_report: { period_start: "2026-07-08", period_end: "2026-07-14", sections: [{ title: "Open", count: 1 }], link: "/dashboard" },
  weekly_maintenance_report: { period_start: "2026-07-08", period_end: "2026-07-14", sections: [{ title: "Open", count: 1 }], link: "/dashboard" },
  monthly_management_report: { period_start: "2026-06-01", period_end: "2026-06-30", sections: [{ title: "Open", count: 1 }], link: "/dashboard" },
  daily_manager_digest: { sections: [{ title: "Open", count: 1 }], link: "/alerts" },
  daily_warehouse_digest: { sections: [{ title: "Open", count: 1 }], link: "/my-tasks" },
  daily_office_employee_digest: { sections: [{ title: "Open", count: 1 }], link: "/my-tasks" },
  portal_request_created_customer: { request_number: "REQ-1", link: "/client-portal/requests/1" },
  portal_request_created_internal: { request_number: "REQ-1", link: "/requests/1" },
  internal_request_created_requester: { request_number: "REQ-1", link: "/my-requests" },
  internal_request_created_manager: { request_number: "REQ-1", link: "/alerts" },
  request_needs_clarification: { request_number: "REQ-1", link: "/my-requests" },
  request_approved: { request_number: "REQ-1", link: "/my-requests" },
  request_rejected: { request_number: "REQ-1", link: "/my-requests" },
  request_cancelled: { request_number: "REQ-1", link: "/my-requests" },
  request_ready_for_pickup: { request_number: "REQ-1", link: "/my-requests" },
  additional_quantity_required_internal: { request_number: "REQ-1", link: "/requests/1" },
  return_reminder_two_days: { request_number: "REQ-1", link: "/my-assets" },
  return_reminder_due_today: { request_number: "REQ-1", link: "/my-assets" },
  return_overdue_internal: { request_number: "REQ-1", link: "/requests/1" },
  account_pending_user: { link: "/login" },
  account_pending_manager: { link: "/settings" },
  account_approved: { link: "/dashboard" },
  account_rejected: { link: "/login" },
  email_staging_test: { summary: "Manager-initiated Staging Test Mode verification.", link: "/settings" },
  email_production_test: { summary: "Controlled Production email activation verification.", link: "/settings" },
};

describe("ADR-004 central templates", () => {
  it("renders RTL Arabic and escapes untrusted values", () => {
    const output = renderTemplate("maintenance_opened", { maintenance_id: "M-1", problem_description: "<script>alert(1)</script>", link: "/maintenance" }, { baseUrl: "https://itam.example.com", language: "ar" });
    expect(output.html).toContain('dir="rtl"');
    expect(output.subject).toBe("تم فتح سجل صيانة");
    expect(output.subject).not.toMatch(/[ØÙ]/);
    expect(output.html).toContain("&lt;script&gt;");
    expect(output.html).not.toContain("<script>");
    expect((output.html.match(/<a /g) ?? [])).toHaveLength(1);
  });

  it("renders LTR English and omits zero digest sections", () => {
    const output = renderTemplate("warehouse_daily_digest", { report_date: "2026-07-14", sections: [{ title: "Empty", count: 0 }, { title: "Open", count: 2 }], link: "/dashboard" }, { baseUrl: "https://itam.example.com", language: "en" });
    expect(output.html).toContain('dir="ltr"');
    expect(output.html).not.toContain("Empty");
    expect(output.html).toContain("Open (2)");
  });

  it("rejects financial content before rendering", () => {
    for (const key of TEMPLATE_KEYS) {
      expect(() => renderTemplate(key, { ...fixtures[key], total_price: 10 } as never, { baseUrl: "https://itam.example.com", language: "en" })).toThrow("financial_field_forbidden");
    }
  });

  it("renders every approved template in Arabic and English", () => {
    for (const key of TEMPLATE_KEYS) {
      for (const language of ["ar", "en"] as const) {
        const output = renderTemplate(key, fixtures[key] as never, { baseUrl: "https://itam.example.com", language });
        expect(output.subject.length).toBeGreaterThan(3);
        expect(output.html).toContain(`dir="${language === "ar" ? "rtl" : "ltr"}"`);
        expect(output.html).not.toMatch(/undefined|NaN/);
      }
    }
  });
});
