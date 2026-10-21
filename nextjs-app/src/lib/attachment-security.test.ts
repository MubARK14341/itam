import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { sanitizeAttachmentFileName } from "./attachment-files";

const root = process.cwd();
const migration = readFileSync(
  resolve(root, "migrations/20260727144620_attachment_classification_hardening.sql"),
  "utf8",
);
const quarantineMigration = readFileSync(
  resolve(root, "migrations/20260731105203_attachment_quarantine_lifecycle.sql"),
  "utf8",
);
const queries = readFileSync(resolve(root, "src/lib/queries.ts"), "utf8");
const requestAttachments = readFileSync(
  resolve(root, "src/lib/request-attachments.ts"),
  "utf8",
);

describe("F-002/F-008 attachment security contract", () => {
  it("classifies maintenance and other invoices as financial in the database", () => {
    for (const kind of [
      "maintenance_invoice",
      "warranty_invoice",
      "purchase_invoice",
      "consumable_invoice",
      "replenishment_invoice",
    ]) {
      expect(migration).toContain(`'${kind}'`);
    }
    expect(queries).toContain(
      'const normalizedKind = kind === "invoice" ? "maintenance_invoice" : kind;',
    );
    expect(migration).toContain("new.classification := v_expected_classification");
    expect(migration).toContain("financial_attachment_forbidden");
  });

  it("fails closed for unknown legacy classifications at metadata and storage", () => {
    expect(migration).toContain("else public.is_financial_viewer()");
    expect(migration).toContain("else null");
    expect(migration).toContain("invalid_attachment_kind");
    expect(migration).toContain("public.can_read_attachment_object(name)");
  });

  it("enforces private bucket size, MIME, ownership, and generated paths", () => {
    expect(migration).toContain("set public = false");
    expect(migration).toContain("file_size_limit = 10485760");
    expect(migration).toContain("owner_id = auth.uid()::text");
    expect(migration).toContain("invalid_attachment_mime");
    expect(migration).toContain("invalid_attachment_size");
    expect(requestAttachments).toContain("globalThis.crypto.randomUUID()");
    expect(queries).toContain("buildAttachmentObjectName(");
  });

  it("blocks financial request attachments from customer visibility", () => {
    expect(migration).toContain("staff_register_request_attachment_v2");
    expect(migration).toContain("p_classification in ('customer_visible', 'financial')");
    expect(migration).toContain("financial_visibility_forbidden");
    expect(migration).toMatch(
      /staff_set_request_attachment_visibility[\s\S]*v_role not in \('admin', 'it_manager'\)/,
    );
    expect(migration).toContain("ra.classification = 'customer_visible'");
    expect(requestAttachments).toContain("p_classification: classification");
  });

  it("attempts compensating cleanup and reports cleanup failures", () => {
    expect(queries).toContain('.from("attachments")');
    expect(queries).toContain(".remove([path])");
    expect(queries).toContain('"attachment_cleanup_failed"');
    expect(requestAttachments).toContain('"request_attachment_cleanup_failed"');
    expect(requestAttachments).not.toContain("catch { /* orphan");
  });

  it("sanitizes object names so traversal and arbitrary characters cannot survive", () => {
    const sanitized = sanitizeAttachmentFileName("../../فاتورة / q4?.PDF");
    expect(sanitized).not.toContain("/");
    expect(sanitized).not.toContain("..");
    expect(sanitized).toMatch(/^[A-Za-z0-9_-]+\.[a-z0-9]+$/);
  });

  it("quarantines every attachment until a service-only clean verdict", () => {
    expect(quarantineMigration).toContain("alter column scan_status set default 'pending'");
    expect(quarantineMigration).toContain("a.scan_status = 'clean'");
    expect(quarantineMigration).toContain("ra.scan_status = 'clean'");
    expect(quarantineMigration).toContain("auth.role() <> 'service_role'");
    expect(quarantineMigration).toMatch(
      /revoke all on function public\.complete_attachment_scan\([\s\S]*from public, anon, authenticated/,
    );
    expect(quarantineMigration).toContain("to service_role");
    expect(quarantineMigration).not.toMatch(/\bdelete\s+from\b/i);
  });

  it("forces signed URLs to download with a sanitized filename", () => {
    expect(queries).toContain("download: sanitizeAttachmentFileName(");
    expect(requestAttachments).toContain("download: sanitizeAttachmentFileName(");
    expect(requestAttachments).toContain("SIGNED_TTL = 120");
  });
});
