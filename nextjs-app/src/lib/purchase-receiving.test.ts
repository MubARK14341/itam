import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { validateReceiptQuantity } from "./purchase-receiving";

const migration = readFileSync(
  resolve(
    process.cwd(),
    "migrations/20260727150423_purchase_receiving_bridge_hardening.sql",
  ),
  "utf8",
);

describe("F-004 purchase receiving", () => {
  it("accepts an exact 5/5 receipt", () => {
    expect(validateReceiptQuantity(5, 5, 0)).toEqual({
      quantity: 5,
      remaining: 5,
      error: null,
    });
  });

  it("rejects receiving 8 when only 5 were requested", () => {
    expect(validateReceiptQuantity(8, 5, 0).error).toBe(
      "quantity_exceeds_remaining",
    );
  });

  it("accepts 3 then 2 and rejects 3 then 3", () => {
    expect(validateReceiptQuantity(3, 5, 0).error).toBeNull();
    expect(validateReceiptQuantity(2, 5, 3).error).toBeNull();
    expect(validateReceiptQuantity(3, 5, 3).error).toBe(
      "quantity_exceeds_remaining",
    );
  });

  it("rejects non-finite, fractional, zero, negative, and huge quantities", () => {
    for (const value of [
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
      Number.NaN,
      0,
      -1,
      1.5,
      1e308,
    ]) {
      expect(validateReceiptQuantity(value, 5, 0).error).toBe("bad_qty");
    }
  });

  it("locks receipt rows, caps remaining quantity, and derives header status", () => {
    expect(migration).toMatch(
      /from public\.purchase_request_items[\s\S]*where id = p_item_id[\s\S]*for update;/,
    );
    expect(migration).toContain(
      "v_remaining := v_item.requested_quantity - v_item.received_quantity",
    );
    expect(migration).toContain("if p_qty > v_remaining");
    expect(migration).toContain("received_quantity <= requested_quantity");
    expect(migration).toContain("receipt_status_is_derived");
    expect(migration).toContain(
      "when coalesce(v_all_received, false) then 'received'",
    );
  });

  it("keeps duplicate conversion blocked and reconnects only after real fulfillment", () => {
    expect(migration).toContain("source_request_item_id = p_item_id");
    expect(migration).toContain("'already_converted'");
    expect(migration).toContain("'purchase_not_received'");
    expect(migration).toContain("set status = 'provisioned'");
    expect(migration).toContain("'purchase_received_awaiting_fulfillment'");
    expect(migration).not.toContain("insert into public.assets");
  });
});
