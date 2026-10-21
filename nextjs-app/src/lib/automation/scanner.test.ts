import { describe, expect, it } from "vitest";
import type { AutomationDb } from "../../../supabase/functions/itam-automation-worker/db.ts";
import { runScanner, usefulLifeDate } from "../../../supabase/functions/itam-automation-worker/scanner.ts";
import type { JsonObject } from "../../../supabase/functions/itam-automation-worker/types.ts";

describe("ADR-004 scanner recipient thresholds", () => {
  it("routes 2/6/10-day maintenance reminders once per recipient and threshold", async () => {
    const enqueued: JsonObject[] = [];
    const tables: Record<string, unknown[]> = {
      roles: [
        { id: "r-tech", key: "technician" }, { id: "r-warehouse", key: "warehouse_manager" },
        { id: "r-manager", key: "it_manager" }, { id: "r-admin", key: "admin" },
      ],
      app_users: [
        { id: "u-tech", email: "tech@example.com", full_name: "Tech", role_id: "r-tech", employee_id: "e-tech" },
        { id: "u-warehouse", email: "warehouse@example.com", full_name: "Warehouse", role_id: "r-warehouse", employee_id: "e-warehouse" },
        { id: "u-manager", email: "manager@example.com", full_name: "Manager", role_id: "r-manager", employee_id: "e-manager" },
      ],
      maintenance_records: [
        { id: "m-2", asset_id: "a-1", technician_id: "u-tech", priority: "high", workflow_stage: "open", problem_description: "Screen", status: "open", reported_at: "2026-07-21T21:00:00.000Z", updated_at: "2026-07-21T21:00:00.000Z" },
        { id: "m-6", asset_id: "a-1", technician_id: "u-tech", priority: "high", workflow_stage: "open", problem_description: "Screen", status: "open", reported_at: "2026-07-15T21:00:00.000Z", updated_at: "2026-07-15T21:00:00.000Z" },
        { id: "m-10", asset_id: "a-1", technician_id: "u-tech", priority: "high", workflow_stage: "open", problem_description: "Screen", status: "open", reported_at: "2026-07-11T21:00:00.000Z", updated_at: "2026-07-11T21:00:00.000Z" },
      ],
      assets: [{ id: "a-1", asset_tag: "A-1", name: "Laptop", warranty_end: null, purchase_date: null, lifespan_months: null }],
      requests: [], request_events: [],
    };
    const fakeDb = {
      select: async <T>(table: string): Promise<T[]> => (tables[table] ?? []) as T[],
      selectAll: async <T>(table: string): Promise<T[]> => (tables[table] ?? []) as T[],
      enqueue: async (args: JsonObject): Promise<string> => { enqueued.push(args); return `outbox-${enqueued.length}`; },
    } as unknown as AutomationDb;

    const result = await runScanner(fakeDb, new Date("2026-07-23T21:00:00.000Z"), "https://itam.example.com");
    expect(result.enqueued).toBe(4);
    expect(enqueued.map(item => item.p_event_key)).toEqual([
      "maintenance:m-2:idle:2:u-tech",
      "maintenance:m-6:idle:6:u-tech",
      "maintenance:m-6:idle:6:u-warehouse",
      "maintenance:m-10:idle:10:u-manager",
    ]);
    expect(JSON.stringify(enqueued)).not.toMatch(/cost|price|amount|currency|invoice/i);
  });

  it("clamps month-end useful-life dates", () => {
    expect(usefulLifeDate({ id: "a", asset_tag: null, name: null, warranty_end: null, purchase_date: "2026-01-31", lifespan_months: 1 })).toBe("2026-02-28");
    expect(usefulLifeDate({ id: "a", asset_tag: null, name: null, warranty_end: null, purchase_date: "2024-01-31", lifespan_months: 1 })).toBe("2024-02-29");
  });

  it("maps request responsibility through app_users.employee_id and uses the matching status event", async () => {
    const enqueued: JsonObject[] = [];
    const tables: Record<string, unknown[]> = {
      roles: [
        { id: "r-warehouse", key: "warehouse_manager" },
        { id: "r-manager", key: "it_manager" },
      ],
      app_users: [
        { id: "u-responsible", email: "responsible@example.com", full_name: "Responsible", role_id: "r-manager", employee_id: "e-responsible" },
        { id: "u-warehouse", email: "warehouse@example.com", full_name: "Warehouse", role_id: "r-warehouse", employee_id: "e-warehouse" },
      ],
      maintenance_records: [],
      assets: [],
      requests: [{ id: "req-1", request_number: "REQ-1", status: "approved", responsible_employee_id: "e-responsible", created_at: "2026-07-01T00:00:00.000Z", updated_at: "2026-07-12T20:00:00.000Z" }],
      request_events: [
        { id: "ev-1", request_id: "req-1", event_type: "approved", created_at: "2026-07-11T21:00:00.000Z", metadata: {} },
        { id: "ev-2", request_id: "req-1", event_type: "status_changed", created_at: "2026-07-12T20:00:00.000Z", metadata: { to: "preparing" } },
      ],
    };
    const fakeDb = {
      selectAll: async <T>(table: string): Promise<T[]> => (tables[table] ?? []) as T[],
      enqueue: async (args: JsonObject): Promise<string> => { enqueued.push(args); return `outbox-${enqueued.length}`; },
      recordHealth: async (): Promise<string> => "health-1",
    } as unknown as AutomationDb;

    await runScanner(fakeDb, new Date("2026-07-12T21:00:00.000Z"), "https://itam.example.com");
    expect(enqueued.map(item => item.p_recipient_ref)).toEqual(["u-responsible", "u-warehouse"]);
    expect(enqueued[0]?.p_payload).toMatchObject({ elapsed_minutes_excluding_weekends: 1440 });
  });

  it("keeps a threshold event payload stable when the scanner runs again", async () => {
    const enqueued: JsonObject[] = [];
    const tables: Record<string, unknown[]> = {
      roles: [{ id: "r-tech", key: "technician" }],
      app_users: [{ id: "u-tech", email: "tech@example.com", full_name: "Tech", role_id: "r-tech", employee_id: "e-tech" }],
      maintenance_records: [{ id: "m-stable", asset_id: "a-1", technician_id: "u-tech", priority: "high", workflow_stage: "open", problem_description: "Screen", status: "open", reported_at: "2026-07-10T21:00:00.000Z", updated_at: "2026-07-10T21:00:00.000Z" }],
      assets: [{ id: "a-1", asset_tag: "A-1", name: "Laptop", warranty_end: null, purchase_date: null, lifespan_months: null }],
      requests: [], request_events: [],
    };
    const fakeDb = {
      select: async <T>(table: string): Promise<T[]> => (tables[table] ?? []) as T[],
      selectAll: async <T>(table: string): Promise<T[]> => (tables[table] ?? []) as T[],
      enqueue: async (args: JsonObject): Promise<string> => { enqueued.push(args); return `outbox-${enqueued.length}`; },
      recordHealth: async (): Promise<string> => "health-1",
    } as unknown as AutomationDb;

    await runScanner(fakeDb, new Date("2026-07-14T21:00:00.000Z"), "https://itam.example.com");
    await runScanner(fakeDb, new Date("2026-07-15T21:00:00.000Z"), "https://itam.example.com");

    expect(enqueued).toHaveLength(2);
    expect(enqueued[0]?.p_event_key).toBe(enqueued[1]?.p_event_key);
    expect(enqueued[0]?.p_payload).toEqual(enqueued[1]?.p_payload);
  });

  it("keeps a stalled-request payload stable when the scanner runs again", async () => {
    const enqueued: JsonObject[] = [];
    const tables: Record<string, unknown[]> = {
      roles: [{ id: "r-manager", key: "it_manager" }, { id: "r-warehouse", key: "warehouse_manager" }],
      app_users: [
        { id: "u-manager", email: "manager@example.com", full_name: "Manager", role_id: "r-manager", employee_id: "e-manager" },
        { id: "u-warehouse", email: "warehouse@example.com", full_name: "Warehouse", role_id: "r-warehouse", employee_id: "e-warehouse" },
      ],
      maintenance_records: [], assets: [],
      requests: [{ id: "req-stable", request_number: "REQ-STABLE", status: "under_review", responsible_employee_id: "e-manager", created_at: "2026-07-10T00:00:00.000Z", updated_at: "2026-07-10T00:00:00.000Z" }],
      request_events: [{ id: "ev-stable", request_id: "req-stable", event_type: "submitted", created_at: "2026-07-10T00:00:00.000Z", metadata: {} }],
    };
    const fakeDb = {
      selectAll: async <T>(table: string): Promise<T[]> => (tables[table] ?? []) as T[],
      enqueue: async (args: JsonObject): Promise<string> => { enqueued.push(args); return `outbox-${enqueued.length}`; },
      recordHealth: async (): Promise<string> => "health-1",
    } as unknown as AutomationDb;

    await runScanner(fakeDb, new Date("2026-07-14T00:00:00.000Z"), "https://itam.example.com");
    await runScanner(fakeDb, new Date("2026-07-15T00:00:00.000Z"), "https://itam.example.com");

    expect(enqueued).toHaveLength(4);
    expect(enqueued[0]?.p_event_key).toBe(enqueued[2]?.p_event_key);
    expect(enqueued[1]?.p_event_key).toBe(enqueued[3]?.p_event_key);
    expect(enqueued[0]?.p_payload).toEqual(enqueued[2]?.p_payload);
    expect(enqueued[1]?.p_payload).toEqual(enqueued[3]?.p_payload);
  });
});
