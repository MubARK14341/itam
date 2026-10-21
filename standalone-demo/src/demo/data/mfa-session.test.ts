import { afterEach, describe, expect, it, vi } from "vitest";
import { createClient } from "@supabase/supabase-js";
import { createDemoStore } from "./store";
import { createDemoTransport } from "./transport";
import { DEMO_PERSONAS } from "./seed";
import { checkDemoAuthorization, demoSession, DEMO_SUPABASE_ANON_KEY, DEMO_SUPABASE_URL } from "./auth";

afterEach(() => vi.unstubAllGlobals());

async function setup() {
  const store = createDemoStore({ memory: true });
  await store.setActor("admin");
  const transport = createDemoTransport(store);
  const paths: string[] = [];
  const client = createClient(DEMO_SUPABASE_URL, DEMO_SUPABASE_ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: {
      fetch: async (input, init) => {
        const request = new Request(input, init);
        paths.push(`${request.method} ${new URL(request.url).pathname}`);
        return transport(request);
      },
    },
  });
  return { store, client, paths };
}

describe("actual demo sessions through the installed Auth SDK", () => {
  it("primes the SDK with a real data session and completes local MFA enrollment and verification", async () => {
    const nativeFetch = vi.fn(() => { throw new Error("network escape"); });
    vi.stubGlobal("fetch", nativeFetch);
    const { store, client, paths } = await setup();
    const session = demoSession(store.getActor(), store.getGeneration())!;
    const primed = await client.auth.setSession({ access_token: session.access_token, refresh_token: session.refresh_token });
    expect(primed.error).toBeNull();
    expect(primed.data.session?.user.id).toBe(session.user.id);
    const initial = await client.auth.mfa.listFactors();
    expect(initial.error).toBeNull();
    expect(initial.data).toMatchObject({ all: [], totp: [] });
    expect(paths).toEqual(["GET /auth/v1/user", "GET /auth/v1/user"]);

    const enrolled = await client.auth.mfa.enroll({ factorType: "totp", friendlyName: "Local demo MFA" });
    expect(enrolled.error).toBeNull();
    expect(enrolled.data?.type).toBe("totp");
    if (enrolled.data?.type !== "totp") throw new Error("Local MFA enrollment did not return a TOTP factor");
    expect(enrolled.data.totp.qr_code).toContain("DEMO 123456");
    const pending = await client.auth.mfa.listFactors();
    expect(pending.error).toBeNull();
    expect(pending.data?.all).toEqual([expect.objectContaining({ id: enrolled.data.id, status: "unverified" })]);
    expect(pending.data?.totp).toEqual([]);

    const verified = await client.auth.mfa.challengeAndVerify({ factorId: enrolled.data.id, code: "123456" });
    expect(verified.error).toBeNull();
    const factors = await client.auth.mfa.listFactors();
    expect(factors.error).toBeNull();
    expect(factors.data?.totp).toEqual([expect.objectContaining({ id: enrolled.data.id, status: "verified" })]);
    expect((await store.read()).mfa[session.user.id]).toEqual([expect.objectContaining({ id: enrolled.data.id, status: "verified" })]);
    expect(nativeFetch).not.toHaveBeenCalled();
  });

  it("accepts data-generated Base64URL sessions for every selectable persona", async () => {
    const { store, client } = await setup();
    for (const persona of DEMO_PERSONAS) {
      await store.setActor(persona.id);
      const session = demoSession(store.getActor(), store.getGeneration())!;
      for (const segment of session.access_token.split(".")) expect(segment).toMatch(/^([a-z0-9_-]{4})*($|[a-z0-9_-]{3}$|[a-z0-9_-]{2}$)$/i);
      const primed = await client.auth.setSession({ access_token: session.access_token, refresh_token: session.refresh_token });
      expect(primed.error, persona.id).toBeNull();
      expect(primed.data.user?.id).toBe(persona.userId);
      const factors = await client.auth.mfa.listFactors();
      expect(factors.error, persona.id).toBeNull();
      expect(factors.data?.all).toEqual([]);
    }
  });

  it("decodes UTF-8 Base64URL claims while preserving actor and generation rejection", async () => {
    const { store } = await setup();
    const captured = store.capture();
    const actor = { ...captured.actor!, userId: "تجربة 💻" };
    const context = { ...captured, actor };
    const session = demoSession(actor, context.generation)!;
    expect(() => checkDemoAuthorization(`Bearer ${session.access_token}`, context)).not.toThrow();
    expect(() => checkDemoAuthorization(`Bearer ${session.access_token}`, { ...context, generation: context.generation + 1 })).toThrow(expect.objectContaining({ code: "DEMO_STALE_OPERATION" }));
    expect(() => checkDemoAuthorization(`Bearer ${session.access_token}`, captured)).toThrow(expect.objectContaining({ code: "DEMO_STALE_OPERATION" }));
    expect(() => checkDemoAuthorization("Bearer invalid.%.demo-local", context)).toThrow(expect.objectContaining({ code: "42501" }));
  });

  it("keeps the SDK's rejection of the former padded token rather than bypassing JWT validation", async () => {
    const { store, client, paths } = await setup();
    const session = demoSession(store.getActor(), store.getGeneration())!;
    const [, payload, signature] = session.access_token.split(".");
    const paddedHeader = btoa(JSON.stringify({ alg: "none", typ: "JWT" }));
    expect(paddedHeader).toContain("=");
    const result = await client.auth.setSession({ access_token: `${paddedHeader}.${payload}.${signature}`, refresh_token: session.refresh_token });
    expect(result.error?.message).toBe("JWT not in base64url format");
    expect(result.data.session).toBeNull();
    expect(paths).toEqual([]);
  });
});
