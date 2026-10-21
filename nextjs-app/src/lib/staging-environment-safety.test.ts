import { describe, expect, it } from "vitest";
import {
  assertStagingEnvironment,
  validateStagingEnvironment,
} from "../../scripts/staging/environment-safety.mjs";

import {APPROVED_STAGING as fixture} from '../../scripts/safety/production-boundary.mjs';
function validEnv(overrides: Record<string,string>={}) {return {
 NODE_ENV:'test',APP_ENV:'staging',DEPLOYMENT_ENV:'preview',
 EXPECTED_STAGING_PROJECT_REF:fixture.supabaseProjectRef,STAGING_SUPABASE_PROJECT_REF:fixture.supabaseProjectRef,
 STAGING_SUPABASE_URL:`https://${fixture.supabaseApiHost}`,STAGING_DATABASE_HOST:fixture.supabaseDatabaseHost,
 STAGING_DATABASE_NAME:'postgres',EXPECTED_STAGING_DATABASE_NAME:'postgres',STAGING_DEPLOYMENT_DOMAIN:fixture.fixedPreviewHost,
 STAGING_DEPLOYMENT_PROJECT:fixture.vercelProjectName,STAGING_VERCEL_PROJECT_ID:fixture.vercelProjectId,STAGING_VERCEL_TEAM_ID:fixture.vercelTeamId,
 STAGING_SUPABASE_PROJECT_NAME:fixture.supabaseProjectName,STAGING_SUPABASE_ORGANIZATION:fixture.supabaseOrganization,
 STAGING_GIT_BRANCH:'review/synthetic',...overrides};}

describe("staging environment safety preflight", () => {
  it("accepts a fully documented staging target", () => {
    expect(validateStagingEnvironment(validEnv())).toMatchObject({
      ok: true,
      identity: {
        appEnvironment: "staging",
        projectRef: fixture.supabaseProjectRef,
        databaseName: "postgres",
      },
    });
  });

  it("rejects the known production project", () => {
    expect(() => assertStagingEnvironment(validEnv({
      EXPECTED_STAGING_PROJECT_REF: "synthetic-production",
      STAGING_SUPABASE_PROJECT_REF: "synthetic-production",
      STAGING_SUPABASE_URL: "https://production.example.invalid",
      STAGING_DATABASE_HOST: "production.example.invalid",
    }))).toThrow(/production identifier/i);
  });

  it("rejects a missing environment identity", () => {
    expect(validateStagingEnvironment(validEnv({ APP_ENV: "" }))).toMatchObject({ ok: false });
  });

  it("rejects an unknown deployment URL", () => {
    const result = validateStagingEnvironment(validEnv({
      STAGING_DEPLOYMENT_DOMAIN: "itam.example.net",
    }));
    expect(result).toMatchObject({ ok: false });
    if (!result.ok) expect((result.issues ?? []).join(" ")).toMatch(/approved Staging Preview/i);
  });

  it("rejects an unexpected project reference", () => {
    expect(validateStagingEnvironment(validEnv({
      STAGING_SUPABASE_PROJECT_REF: "unexpectedprojectref",
    }))).toMatchObject({ ok: false });
  });

  it("rejects a self-consistent but unknown project", () => {
    const unknown = "abcdefghijklmnopqrst";
    expect(validateStagingEnvironment(validEnv({
      EXPECTED_STAGING_PROJECT_REF: unknown,
      STAGING_SUPABASE_PROJECT_REF: unknown,
      STAGING_SUPABASE_URL: `https://${unknown}.supabase.co`,
      STAGING_DATABASE_HOST: `db.${unknown}.supabase.co`,
    }))).toMatchObject({ ok: false });
  });

  it("rejects frontend service-role exposure and mismatched migration targets", () => {
    const result = validateStagingEnvironment(validEnv({
      NEXT_PUBLIC_SUPABASE_SERVICE_ROLE_KEY: "never-public",
      MIGRATION_DATABASE_URL: "postgresql://user:demo@example.invalid/postgres",
    }));
    expect(result).toMatchObject({ ok: false });
    if (!result.ok) {
      expect((result.issues ?? []).join(" ")).toMatch(/privileged secret/i);
      expect((result.issues ?? []).join(" ")).toMatch(/MIGRATION_DATABASE_URL/i);
    }
  });
});
