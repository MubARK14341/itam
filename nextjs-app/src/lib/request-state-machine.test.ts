import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  resolve(
    process.cwd(),
    "migrations/20260727145511_request_state_machine_hardening.sql",
  ),
  "utf8",
);
const requestPage = readFileSync(
  resolve(process.cwd(), "src/app/(app)/requests/[id]/page.tsx"),
  "utf8",
);

const states = [
  "draft",
  "under_review",
  "needs_clarification",
  "approved",
  "auto_provisioning",
  "provisioned",
  "stock_shortage",
  "preparing",
  "ready_for_pickup",
  "delivered",
  "partially_returned",
  "returned",
  "completed",
  "cancelled",
  "overdue",
  "rejected",
] as const;

const allowedPairs = [
  ["draft", "under_review"],
  ["draft", "cancelled"],
  ["under_review", "needs_clarification"],
  ["under_review", "approved"],
  ["under_review", "rejected"],
  ["under_review", "cancelled"],
  ["needs_clarification", "under_review"],
  ["needs_clarification", "rejected"],
  ["needs_clarification", "cancelled"],
  ["approved", "auto_provisioning"],
  ["approved", "provisioned"],
  ["approved", "stock_shortage"],
  ["approved", "preparing"],
  ["approved", "cancelled"],
  ["auto_provisioning", "approved"],
  ["auto_provisioning", "provisioned"],
  ["auto_provisioning", "stock_shortage"],
  ["auto_provisioning", "cancelled"],
  ["provisioned", "auto_provisioning"],
  ["provisioned", "preparing"],
  ["provisioned", "stock_shortage"],
  ["provisioned", "cancelled"],
  ["stock_shortage", "auto_provisioning"],
  ["stock_shortage", "provisioned"],
  ["stock_shortage", "cancelled"],
  ["preparing", "auto_provisioning"],
  ["preparing", "provisioned"],
  ["preparing", "stock_shortage"],
  ["preparing", "ready_for_pickup"],
  ["preparing", "cancelled"],
  ["ready_for_pickup", "delivered"],
  ["ready_for_pickup", "completed"],
  ["ready_for_pickup", "cancelled"],
  ["delivered", "partially_returned"],
  ["delivered", "returned"],
  ["delivered", "completed"],
  ["delivered", "overdue"],
  ["partially_returned", "returned"],
  ["partially_returned", "overdue"],
  ["returned", "completed"],
  ["overdue", "partially_returned"],
  ["overdue", "returned"],
] as const;

const allowed = new Set(allowedPairs.map(([from, to]) => `${from}->${to}`));
const pairPattern = /\('([^']+)', '([^']+)'\)/g;
const matrixSql = migration
  .split("from (values", 2)[1]
  ?.split(") as allowed", 1)[0] ?? "";
const sqlPairs = new Set(
  Array.from(matrixSql.matchAll(pairPattern)).map(
    (match) => `${match[1]}->${match[2]}`,
  ),
);

describe("F-003 request transition matrix", () => {
  it("contains exactly the reviewed transition pairs", () => {
    expect(sqlPairs).toEqual(allowed);
  });

  it("classifies every state pair as allowed or denied", () => {
    for (const from of states) {
      for (const to of states) {
        const expected = from === to || allowed.has(`${from}->${to}`);
        const actual = from === to || sqlPairs.has(`${from}->${to}`);
        expect(actual, `${from} -> ${to}`).toBe(expected);
      }
    }
  });

  it("denies unsafe clarification and delivery shortcuts", () => {
    expect(allowed.has("needs_clarification->approved")).toBe(false);
    expect(allowed.has("approved->delivered")).toBe(false);
    expect(allowed.has("preparing->delivered")).toBe(false);
    expect(allowed.has("provisioned->delivered")).toBe(false);
    expect(allowed.has("ready_for_pickup->delivered")).toBe(true);
  });

  it("requires a clarification reply to return to review before approval", () => {
    expect(migration).toContain("if v_request.status <> 'under_review'");
    expect(migration).not.toMatch(
      /request_approve[\s\S]*status in \([^)]*needs_clarification/,
    );
  });

  it("checks readiness and releases reservations on rollback operations", () => {
    expect(migration).toContain("create or replace function public.request_ready_issue");
    expect(migration).toContain("asset_not_reserved");
    expect(migration).toContain("unfulfilled_items");
    expect(migration).toContain("invalid_asset_selection");
    expect(migration).toContain("public._request_release_reservations");
    expect(migration).toContain("set status = 'available'");
    expect(migration).toContain("asset_id = null");
  });

  it("requires asset returns to use the atomic condition-inspection path", () => {
    expect(migration).toContain("create or replace function public.request_return");
    expect(migration).toMatch(
      /request_return\(p_id uuid\)[\s\S]*item_kind = 'asset'[\s\S]*'inspection_required'/,
    );
    expect(migration).toMatch(
      /request_return\(p_id uuid\)[\s\S]*set status = 'returned',[\s\S]*returned_at = now\(\)/,
    );
    expect(migration).toContain("'request_return(uuid)'");
  });

  it("keeps UI actions aligned with the hardened server states", () => {
    expect(requestPage).toContain("requestActionMap({");
    expect(requestPage).toContain('case "confirm_ready"');
    expect(requestPage).toContain('case "deliver"');
    expect(requestPage).toContain("submitRequest(id)");
  });
});
