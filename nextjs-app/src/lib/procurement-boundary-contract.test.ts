import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = process.cwd();
const migration = readFileSync(
  resolve(root, "migrations/20260731220000_procurement_boundary.sql"),
  "utf8",
);
const purchasing = readFileSync(
  resolve(root, "src/lib/purchase-requests.ts"),
  "utf8",
);
const ar = readFileSync(resolve(root, "src/lib/translations/ar.ts"), "utf8");
const en = readFileSync(resolve(root, "src/lib/translations/en.ts"), "utf8");

describe("procurement integration boundary", () => {
  it("models external documents separately from the purchase request", () => {
    expect(migration).toContain("create table public.procurement_document_refs");
    for (const documentType of [
      "purchase_order",
      "goods_receipt",
      "invoice",
      "stock_receipt",
    ]) {
      expect(migration).toContain(`'${documentType}'`);
    }
    expect(purchasing).toContain('"procurement_record_external_document"');
  });

  it("requires a matching stock transaction after a goods receipt", () => {
    expect(migration).toContain("stock_receipt_links_required");
    expect(migration).toContain("invalid_stock_transaction");
    expect(migration).toContain("goods_receipt_required");
    expect(migration).toContain("v_txn_type <> 'in'");
    expect(migration).toContain(
      "v_txn_consumable_id is distinct from v_item_consumable_id",
    );
  });

  it("declares legacy received quantities as no-stock events", () => {
    expect(migration).toContain("'goods_receipt_quantity_tracked'");
    expect(migration).toContain("'stock_effect', false");
    expect(migration).toContain("'goods_receipt_tracking_only'");
    expect(ar).toContain("دون أثر مخزني");
    expect(en).toContain("no stock effect");
  });

  it("keeps invoice references financial and all writes RPC-only", () => {
    expect(migration).toContain(
      "document_type <> 'invoice' or public.is_financial_viewer()",
    );
    expect(migration).toContain(
      "p_document_type = 'invoice' and not public.is_financial_viewer()",
    );
    expect(migration).toContain(
      "revoke all on public.procurement_document_refs from public, anon, authenticated",
    );
    expect(migration).not.toContain(
      "grant insert on public.procurement_document_refs to authenticated",
    );
  });
});
