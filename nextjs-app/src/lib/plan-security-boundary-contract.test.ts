import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const sql = readFileSync(resolve(process.cwd(), "migrations/20261011025843_portal_atomic_and_procurement_security.sql"), "utf8");
function definition(name: string) {
  const value = sql.match(new RegExp(`create or replace function public\\.${name}\\([\\s\\S]*?\\$function\\$;`))?.[0];
  if (!value) throw new Error(`Missing contract function: ${name}`);
  return value;
}

describe("portal atomic creation and procurement authorization contract", () => {
  it("authorizes procurement before either operation lookup or writes", () => {
    const fn = definition("procurement_record_external_document");
    const boundary = fn.indexOf("if v_uid is null");
    expect(boundary).toBeGreaterThan(0);
    expect(fn).toContain("public.is_approved() is distinct from true");
    expect(fn).toContain("public.app_user_role() is null");
    expect(boundary).toBeLessThan(fn.indexOf("from public.procurement_operation_results"));
    expect(fn).toContain("p_document_type = 'invoice' and public.is_financial_viewer() is distinct from true");
  });
  it("compares all persisted normalized input fields for old and new operation replays", () => {
    const fn = definition("procurement_record_external_document");
    expect(fn).toContain("where id::text = v_result->>'id' and recorded_by = v_uid");
    for (const field of ["purchase_request_id", "purchase_request_item_id", "document_type", "source_system", "external_reference", "document_status", "stock_transaction_id", "metadata"]) {
      expect(fn).toContain(`v_document.${field} is distinct from`);
    }
    expect(fn).toContain("operation_id_conflict");
    expect(fn).toContain("v_txn_consumable_id is distinct from v_item_consumable_id");
    expect(fn).toContain("goods_receipt_required");
    expect(fn).not.toMatch(/update public\.(?:consumables|purchase_request_items)/i);
  });
  it("rolls back a rejected later portal item before returning a logical error", () => {
    const fn = definition("portal_create_request_atomic");
    expect(fn).toContain("public.portal_create_request(");
    expect(fn).toContain("public.portal_add_item(");
    expect(fn).toContain("errcode = 'P0400'");
    expect(fn).toContain("when sqlstate 'P0400' then");
    expect(fn.indexOf("\n  begin\n")).toBeLessThan(fn.indexOf("public.portal_create_request("));
    expect(fn.indexOf("public.portal_add_item(")).toBeLessThan(fn.indexOf("insert into public.request_operation_results"));
    expect(fn).toContain("'definitive_rollback', true");
    expect(fn.indexOf("'definitive_rollback'")).toBeGreaterThan(fn.indexOf("when sqlstate 'P0400' then"));
    expect(fn).not.toMatch(/when others/i);
  });
  it("keeps portal operation recovery actor and active customer scoped", () => {
    const fn = definition("portal_create_request_atomic");
    expect(fn).toContain("where actor_id = v_uid and operation_id = p_operation_id");
    expect(fn).toContain("r.submitted_by = v_uid and r.request_source = 'client_portal'");
    expect(fn).toContain("'{_operation,input_fingerprint}'");
    expect(fn).toContain("'portal_create', v_request_id, v_result");
    const lookup = definition("request_operation_result_lookup");
    expect(lookup).toContain("o.actor_id = auth.uid()");
    expect(lookup).toContain("r.customer_id = public.portal_customer_id()");
    expect(lookup).toContain("r.submitted_by = auth.uid()");
  });
  it("enforces requester ownership while retaining the project manager submission branch", () => {
    const fn = definition("portal_submit_request");
    expect(fn).toContain("v_role = 'authorized_requester' and v_req.submitted_by is distinct from auth.uid()");
    expect(fn).toContain("v_s.require_project_manager_approval");
    expect(fn).toContain("v_role='project_manager'");
  });
  it("enforces the same attachment setting for Storage and metadata registration", () => {
    for (const name of ["portal_can_upload_request_attachment", "portal_register_request_attachment"]) {
      expect(definition(name)).toContain("allow_attachments is distinct from true");
    }
    expect(definition("portal_can_upload_request_attachment")).toContain("v_request.submitted_by is distinct from auth.uid()");
    const register = definition("portal_register_request_attachment");
    expect(register).toContain("a.uploaded_by = auth.uid() and a.uploaded_by_kind = 'portal'");
    expect(register).toContain("a.functional_type = 'request_attachment' and a.file_name = p_file_name");
    expect(register).toContain("a.mime_type = v_mime and a.size_bytes = v_size");
    expect(register.indexOf("'registered', true")).toBeLessThan(register.indexOf("public._request_add_event("));
  });
  it("adds safe derived draft signals without exposing the submitting identity", () => {
    const fn = definition("portal_get_request");
    expect(fn).toContain("'creation_complete', exists (");
    expect(fn).toContain("'can_submit_draft'");
    expect(fn).not.toContain("'submitted_by'");
  });
  it("pins every privileged function and grants the new RPC only to authenticated", () => {
    const functions = [...sql.matchAll(/create or replace function public\.([a-z_]+)\(/g)].map((match) => match[1]);
    expect(functions).toHaveLength(7);
    for (const name of functions) expect(definition(name)).toMatch(/set search_path (?:to 'public'|= public)/);
    expect(sql).toContain("public.portal_create_request_atomic(uuid,jsonb)");
    expect(sql).toContain("from public, anon;");
    expect(sql).toContain("to authenticated;");
    expect(sql.trim()).toMatch(/commit;$/);
    expect(sql).not.toMatch(/alter table|grant select|delete from|drop table|truncate/i);
  });
  it("requires the atomic RPC without changing the baseline compatibility version", () => {
    expect(sql).toContain("array_append(required_signatures, 'public.portal_create_request_atomic(uuid,jsonb)')");
    expect(sql).toContain("and compatibility_version = 2026073110");
    expect(sql).toContain("portal_atomic_schema_contract_missing");
    expect(sql).not.toMatch(/set compatibility_version/i);
    expect(sql).not.toMatch(/applied_at\s*=/i);
  });
});
