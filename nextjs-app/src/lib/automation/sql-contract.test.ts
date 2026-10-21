import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const schema = readFileSync(resolve(root, "migrations/20260714100000_email_automation_schema.sql"), "utf8");
const enqueue = readFileSync(resolve(root, "migrations/20260714100100_email_automation_enqueue.sql"), "utf8");
const enqueuePriorityFix = readFileSync(
  resolve(root, "migrations/20260715050000_fix_automation_enqueue_priority_cast.sql"),
  "utf8",
);
const enqueuePriorityRollback = readFileSync(
  resolve(root, "migrations/rollback/20260715050000_fix_automation_enqueue_priority_cast_rollback.sql"),
  "utf8",
);
const cron = readFileSync(resolve(root, "migrations/20260714100200_email_automation_cron.sql"), "utf8");

describe("ADR-004 SQL static contract", () => {
  it("creates exactly three private automation tables", () => {
    expect(schema.match(/create table if not exists public\.automation_/gi)).toHaveLength(3);
    expect(schema.match(/enable row level security/gi)).toHaveLength(3);
    expect(schema.match(/force row level security/gi)).toHaveLength(3);
    expect(schema).toContain("from public, anon, authenticated");
    expect(schema).toContain("for update skip locked");
  });

  it("preserves the approved status and dedupe contracts", () => {
    for (const status of ["pending", "processing", "sent", "failed", "cancelled", "delivery_unknown"]) expect(schema).toContain(`'${status}'`);
    expect(schema).toContain("unique (event_key)");
    expect(schema).toContain("automation_event_key_conflict");
    expect(schema).toContain("p_outcome = 'release'");
    expect(schema).toContain("automation_payload_has_financial_field");
    expect(schema).toContain("financial_payload_blocked");
    expect(enqueue).toContain("automation_maintenance_opened_enqueue");
    expect(enqueue).toContain("automation_custody_delivery_enqueue");
    expect(enqueue).not.toMatch(/purchase_cost|unit_price|total_price/i);
  });

  it("casts enqueue priority to smallint so trigger inserts do not abort (regression)", () => {
    // p_priority is smallint; passing bare int literals (40 / 80) made function
    // resolution fail with 42883 and rolled back every request_deliver / custody
    // / maintenance-open INSERT. The fix migration must re-define BOTH trigger
    // functions with explicit ::smallint casts and no bare integer priority.
    expect(enqueuePriorityFix).toContain("automation_maintenance_opened_enqueue");
    expect(enqueuePriorityFix).toContain("automation_custody_delivery_enqueue");
    expect(enqueuePriorityFix).toContain("40::smallint");
    expect(enqueuePriorityFix).toContain("80::smallint");
    // no bare integer priority literal survives on the argument line
    expect(enqueuePriorityFix).not.toMatch(/\n\s*40,\s*\n/);
    expect(enqueuePriorityFix).not.toMatch(/\n\s*80,\s*\n/);
  });

  it("keeps the smallint casts when rolling the trigger functions back", () => {
    expect(enqueuePriorityRollback).toContain("40::smallint");
    expect(enqueuePriorityRollback).toContain("80::smallint");
    expect(enqueuePriorityRollback).not.toMatch(/\n\s*40,\s*\n/);
    expect(enqueuePriorityRollback).not.toMatch(/\n\s*80,\s*\n/);
  });

  it("schedules exactly three jobs against one worker", () => {
    expect(cron.match(/cron\.schedule\(/g)).toHaveLength(3);
    expect(cron).toContain("create extension if not exists pg_cron");
    expect(cron).toContain("create extension if not exists pg_net");
    expect(cron).toContain("/itam-automation-worker/scan");
    expect(cron).toContain("/itam-automation-worker/send");
    expect(cron).toContain("/itam-automation-worker/health");
    expect(readdirSync(resolve(root, "supabase/functions"), { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => entry.name)).toEqual(["itam-automation-worker"]);
  });
});
