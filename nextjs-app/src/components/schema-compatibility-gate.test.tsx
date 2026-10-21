import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createClient as createSdkClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";
import { evaluateSchemaCompatibility, EXPECTED_SCHEMA_COMPATIBILITY_VERSION, type SchemaCompatibilityResult } from "@/lib/schema-compatibility";
import { INITIAL_CONTEXT_HEADER } from "@/lib/initial-context-header";

const mocks = vi.hoisted(() => ({ headers: vi.fn(), cookies: vi.fn(), createClient: vi.fn() }));
vi.mock("next/headers", () => ({ headers: mocks.headers, cookies: mocks.cookies }));
vi.mock("@/lib/supabase/server", () => ({ createClient: mocks.createClient }));
import { SchemaCompatibilityGate } from "./schema-compatibility-gate";

const payload = { contract: "itam_app", version: EXPECTED_SCHEMA_COMPATIBILITY_VERSION, compatible: true, missing: [] };
const session = { userId: "TEST-user", email: null, role: "viewer", approvalStatus: "approved", capabilities: [], exposure: null };
function context(result: unknown, userId = session.userId) {
  return Buffer.from(JSON.stringify({ session, schemaCompatibility: { userId, result } }), "utf8").toString("base64url");
}
function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
}

describe("request-scoped schema gate handoff with the installed RPC SDK", () => {
  let fetcher: ReturnType<typeof vi.fn<typeof fetch>>;
  const children = createElement("div", { "data-test-child": "true" }, "TEST child");
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.headers.mockResolvedValue(new Headers());
    mocks.cookies.mockResolvedValue({ get: () => ({ value: "en" }) });
    fetcher = vi.fn<typeof fetch>().mockImplementation(async () => json(payload));
    mocks.createClient.mockImplementation(async () => createSdkClient<Database>("http://localhost:65421", "TEST-public-anon", {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false }, global: { fetch: fetcher },
    }));
  });
  it("renders children with no second client or RPC for a validated compatible result", async () => {
    mocks.headers.mockResolvedValue(new Headers({ [INITIAL_CONTEXT_HEADER]: context(evaluateSchemaCompatibility(payload)) }));
    expect(await SchemaCompatibilityGate({ children })).toBe(children);
    expect(mocks.createClient).not.toHaveBeenCalled();
    expect(fetcher).not.toHaveBeenCalled();
  });
  it.each([
    { ...payload, contract: "TEST-other-contract" },
    { ...payload, version: EXPECTED_SCHEMA_COMPATIBILITY_VERSION - 1 },
    { ...payload, compatible: false, missing: [] },
    { ...payload, missing: ["public.TEST_missing_rpc()"] },
    null,
  ])("keeps the original block panel for a valid negative result %j without another RPC", async (data) => {
    const result = evaluateSchemaCompatibility(data);
    mocks.headers.mockResolvedValue(new Headers({ [INITIAL_CONTEXT_HEADER]: context(result) }));
    const html = renderToStaticMarkup(await SchemaCompatibilityGate({ children }));
    expect(html).toContain('data-schema-compatible="false"');
    expect(html).toContain(`data-schema-reason="${result.reason}"`);
    expect(html).toContain(String(EXPECTED_SCHEMA_COMPATIBILITY_VERSION));
    expect(html).not.toContain("data-test-child");
    expect(mocks.createClient).not.toHaveBeenCalled();
  });
  it("keeps a denied/unavailable handoff blocked without extending its original retry budget", async () => {
    const result: SchemaCompatibilityResult = { ok: false, expectedVersion: EXPECTED_SCHEMA_COMPATIBILITY_VERSION, actualVersion: null, missing: [], reason: "preflight_unavailable" };
    mocks.headers.mockResolvedValue(new Headers({ [INITIAL_CONTEXT_HEADER]: context(result) }));
    expect(renderToStaticMarkup(await SchemaCompatibilityGate({ children }))).toContain('data-schema-reason="preflight_unavailable"');
    expect(mocks.createClient).not.toHaveBeenCalled();
  });
  it.each([
    null, "TEST-not-json", context({ ...evaluateSchemaCompatibility(payload), reason: "invalid_response" }),
    context(evaluateSchemaCompatibility(payload), "TEST-other-user"),
    Buffer.from(JSON.stringify({ session }), "utf8").toString("base64url"),
  ])("uses the original schema RPC on absent/malformed/mismatched transport %s", async (raw) => {
    mocks.headers.mockResolvedValue(new Headers(raw === null ? {} : { [INITIAL_CONTEXT_HEADER]: raw }));
    expect(await SchemaCompatibilityGate({ children })).toBe(children);
    expect(mocks.createClient).toHaveBeenCalledTimes(1);
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [input, init] = fetcher.mock.calls[0];
    expect(new URL(String(input)).pathname).toBe("/rest/v1/rpc/app_schema_compatibility");
    expect(init?.method).toBe("POST");
  });
  it("does not bypass a real denied fallback response", async () => {
    fetcher.mockImplementation(async () => json({ code: "42501", message: "TEST denied" }, 403));
    const html = renderToStaticMarkup(await SchemaCompatibilityGate({ children }));
    expect(html).toContain('data-schema-reason="preflight_unavailable"');
    expect(html).not.toContain("data-test-child");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
