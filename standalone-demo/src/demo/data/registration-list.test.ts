import { describe, expect, it } from "vitest";
import { createClient } from "@supabase/supabase-js";
import type { RegistrationRequest } from "../../studio/lib/queries";
import { createDemoStore } from "./store";
import { createDemoTransport } from "./transport";
import { DEMO_SUPABASE_ANON_KEY, DEMO_SUPABASE_URL } from "./auth";
import { DEMO_PERSONAS, demoId } from "./seed";

type RegistrationListDatabase = {
  public: {
    Tables: Record<string, never>;
    Views: Record<string, never>;
    Functions: { list_registration_requests: { Args: { p_status: string | null }; Returns: RegistrationRequest[] } };
    Enums: Record<string, never>;
    CompositeTypes: Record<string, never>;
  };
};

async function setup() {
  const store = createDemoStore({ memory: true });
  await store.setActor("it_manager");
  const client = createClient<RegistrationListDatabase>(DEMO_SUPABASE_URL, DEMO_SUPABASE_ANON_KEY, {
    global: { fetch: createDemoTransport(store) },
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
  return { store, client };
}

describe("canonical registration list consumed by staff assignment and user settings", () => {
  it("returns the exact source columns and retains the operational assignment options", async () => {
    const { store, client } = await setup();
    const result = await client.rpc("list_registration_requests", { p_status: "approved" });
    expect(result.error).toBeNull();
    expect(result.data).toHaveLength(7);
    const sourceColumns = ["id", "email", "full_name", "phone", "department_id", "department_name", "registration_note", "requested_role", "assigned_role", "approval_status", "created_at", "approved_at", "rejected_at", "rejection_reason", "email_confirmed"].sort();
    for (const row of result.data!) {
      expect(Object.keys(row).sort()).toEqual(sourceColumns);
      expect(row.email_confirmed).toBe(true);
      expect(row.department_name).toBeNull();
      const profile = (await store.read()).tables.app_users.find(u => u.id === row.id)!;
      expect(row.assigned_role).toBe(profile.role_key);
    }
    // These are the actual AssignDialog eligibility fields, not a demo-only role_key fallback.
    const assignable = result.data!.filter(u => u.approval_status === "approved" && ["admin", "it_manager", "technician"].includes(u.assigned_role ?? ""));
    expect(assignable.map(u => u.id).sort()).toEqual([demoId(1,1), demoId(1,8), demoId(1,9)].sort());
    expect((await client.rpc("list_registration_requests", { p_status: "" })).data).toEqual([]);
  });

  it("reads registered profile, joined department, current role and real local confirmation state", async () => {
    const { store, client } = await setup();
    await store.setActor(null);
    const signup = await client.auth.signUp({ email: "registration-shape@demo.invalid", password: "Local-only123!", options: { data: {
      full_name: "Local registration", phone: "0501234567", department_id: demoId(6,1), registration_note: "Profile metadata",
    } } });
    expect(signup.error).toBeNull();
    expect(signup.data.session).toBeNull();
    const id = signup.data.user!.id;
    await store.setActor("it_manager");
    const pending = await client.rpc("list_registration_requests", { p_status: "pending" });
    expect(pending.error).toBeNull();
    expect(pending.data).toEqual([expect.objectContaining({ id, full_name: "Local registration", phone: "0501234567", department_id: demoId(6,1),
      department_name: "تقنية المعلومات", registration_note: "Profile metadata", assigned_role: "viewer", requested_role: "employee", email_confirmed: false })]);
    await store.transact(store.capture(), state => {
      Object.assign(state.tables.departments.find(d => d.id === demoId(6,1))!, { name_ar: null, name: "Local IT department" });
      Object.assign(state.tables.app_users.find(u => u.id === id)!, { role_key: "technician", role: "technician", approval_status: null });
      state.tables.demo_auth_users.find(u => u.id === id)!.email_confirmed_at = "2026-10-11T10:00:00Z";
    });
    const refreshed = await client.rpc("list_registration_requests", { p_status: "approved" });
    expect(refreshed.error).toBeNull();
    expect(refreshed.data?.find(u => u.id === id)).toMatchObject({ department_name: "Local IT department", assigned_role: "technician", approval_status: "approved", email_confirmed: true });
    expect((await client.rpc("list_registration_requests", { p_status: "pending" })).data).toEqual([]);
    const all = await client.rpc("list_registration_requests", { p_status: null });
    expect(all.error).toBeNull();
    expect(all.data?.[0].id).toBe(id);
  });

  it("keeps all nonmanager personas outside this staff identity projection", async () => {
    const { store, client } = await setup();
    for (const persona of DEMO_PERSONAS.filter(p => !["admin", "it_manager"].includes(p.role ?? ""))) {
      await store.setActor(persona.id);
      const result = await client.rpc("list_registration_requests", { p_status: null });
      expect(result.error?.code, persona.id).toBe("42501");
      expect(result.data).toBeNull();
    }
  });
});
