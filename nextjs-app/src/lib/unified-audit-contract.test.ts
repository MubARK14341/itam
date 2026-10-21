import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "../..");
const migration = readFileSync(
  resolve(root, "migrations/20260731170000_unified_audit_ledger.sql"),
  "utf8",
);

describe("unified audit ledger contract", () => {
  it("defines required attribution and evidence fields", () => {
    for (const field of [
      "actor_type",
      "actor_id",
      "system_principal",
      "event_type",
      "entity_type",
      "entity_id",
      "before_state",
      "after_state",
      "reason",
      "source",
      "occurred_at",
      "outcome",
      "attribution_status",
    ]) {
      expect(migration).toContain(field);
    }
  });

  it("is append-only and gives auditor select without mutation grants", () => {
    expect(migration).toContain("trg_audit_events_v2_append_only");
    expect(migration).toContain("before update or delete on public.audit_events_v2");
    expect(migration).toContain("raise exception 'audit_events_append_only'");
    expect(migration).toContain("'admin', 'it_manager', 'auditor'");
    expect(migration).toContain("grant select on public.audit_events_v2 to authenticated");
    expect(migration).not.toMatch(
      /grant\s+(?:update|delete)[\s\S]{0,80}audit_events_v2\s+to authenticated/i,
    );
  });

  it("redacts credential, financial, PII, and free-text snapshot keys", () => {
    for (const marker of [
      "secret",
      "token",
      "password",
      "authorization",
      "purchase[_-]?cost",
      "unit[_-]?price",
      "invoice",
      "email",
      "phone",
      "storage[_-]?path",
      "notes?",
      "message",
      "description",
      "[REDACTED]",
    ]) {
      expect(migration).toContain(marker);
    }
  });

  it("records denied high-risk authorization changes", () => {
    expect(migration).toContain("'role_capability_change_attempt'");
    expect(migration).toContain("'user_capability_change_attempt'");
    expect(migration).toContain("'denied'");
    expect(migration).toContain("'rpc:authorization_admin'");
  });

  it("keeps legacy rows unchanged and labels missing attribution at query time", () => {
    expect(migration).toContain("create or replace function public.audit_legacy_events");
    expect(migration).toContain("'legacy_unattributed'");
    expect(migration).not.toMatch(/update\s+public\.audit_logs/i);
    expect(migration).not.toMatch(/update\s+public\.request_events/i);
  });

  it("builds a non-financial request evidence bundle", () => {
    const evidence = migration.slice(
      migration.indexOf("create or replace function public.audit_request_evidence"),
      migration.indexOf("create or replace function public.audit_legacy_events"),
    );
    for (const section of [
      "'request'",
      "'items'",
      "'approvals'",
      "'movements'",
      "'custody'",
      "'attachments'",
      "'events'",
      "'audit'",
    ]) {
      expect(evidence).toContain(section);
    }
    expect(evidence).not.toContain("'unit_price'");
    expect(evidence).not.toContain("'total_price'");
    expect(evidence).not.toContain("'storage_path'");
  });
});
