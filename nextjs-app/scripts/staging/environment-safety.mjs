import {
  APPROVED_STAGING,
  ProductionBoundaryError,
  assertApprovedHostedQaUrl,
  assertApprovedSupabaseTarget,
  assertApprovedVercelProject,
  assertSafeGitBranch,
  containsDeniedProductionIdentifier,
} from "../safety/production-boundary.mjs";

export class TargetSafetyError extends ProductionBoundaryError {
  constructor(issues) {
    super(issues);
    this.name = "TargetSafetyError";
  }
}

function required(env, name, issues) {
  const value = env[name]?.trim();
  if (!value) issues.push(`${name} is required; Staging safety fails closed.`);
  return value ?? "";
}

function collectError(issues, operation) {
  try {
    return operation();
  } catch (error) {
    if (error instanceof ProductionBoundaryError) issues.push(...error.issues);
    else throw error;
    return null;
  }
}

function assertExact(value, expected, label, issues) {
  if (value !== expected) issues.push(`${label} does not equal the approved Staging identity.`);
}

function databaseTarget(value, label, issues) {
  if (!value) return;
  try {
    const parsed = new URL(value);
    if (!["postgres:", "postgresql:"].includes(parsed.protocol)) {
      issues.push(`${label} must use postgres/postgresql.`);
      return;
    }
    assertExact(parsed.hostname.toLowerCase(), APPROVED_STAGING.supabaseDatabaseHost, label, issues);
    assertExact(parsed.pathname.slice(1), APPROVED_STAGING.supabaseDatabaseName, label, issues);
  } catch {
    issues.push(`${label} is not a valid database URL.`);
  }
}

export function validateStagingEnvironment(env) {
  const issues = [];
  const nodeEnv = required(env, "NODE_ENV", issues);
  const appEnv = required(env, "APP_ENV", issues);
  const deploymentEnv = required(env, "DEPLOYMENT_ENV", issues);
  const expectedRef = required(env, "EXPECTED_STAGING_PROJECT_REF", issues).toLowerCase();
  const declaredRef = required(env, "STAGING_SUPABASE_PROJECT_REF", issues).toLowerCase();
  const supabaseUrl = required(env, "STAGING_SUPABASE_URL", issues);
  const databaseHost = required(env, "STAGING_DATABASE_HOST", issues).toLowerCase();
  const databaseName = required(env, "STAGING_DATABASE_NAME", issues);
  const expectedDatabaseName = required(env, "EXPECTED_STAGING_DATABASE_NAME", issues);
  const deploymentDomain = required(env, "STAGING_DEPLOYMENT_DOMAIN", issues).toLowerCase();
  const deploymentProject = required(env, "STAGING_DEPLOYMENT_PROJECT", issues);
  const deploymentProjectId = required(env, "STAGING_VERCEL_PROJECT_ID", issues);
  const deploymentTeamId = required(env, "STAGING_VERCEL_TEAM_ID", issues);
  const supabaseProjectName = required(env, "STAGING_SUPABASE_PROJECT_NAME", issues);
  const supabaseOrganization = required(env, "STAGING_SUPABASE_ORGANIZATION", issues);
  const gitBranch = required(env, "STAGING_GIT_BRANCH", issues);

  if (!["production", "test", "development"].includes(nodeEnv)) {
    issues.push("NODE_ENV must be production, test, or development.");
  }
  if (appEnv !== "staging") issues.push("APP_ENV must equal staging.");
  if (deploymentEnv !== "preview") issues.push("DEPLOYMENT_ENV must equal preview.");

  collectError(issues, () => assertSafeGitBranch(gitBranch));
  collectError(issues, () => assertApprovedSupabaseTarget({
    url: supabaseUrl,
    projectRef: expectedRef,
    databaseHost,
    databaseName,
  }));
  collectError(issues, () => assertApprovedVercelProject({
    projectId: deploymentProjectId,
    projectName: deploymentProject,
    teamId: deploymentTeamId,
  }));
  collectError(issues, () => assertApprovedHostedQaUrl(`https://${deploymentDomain}`));

  assertExact(declaredRef, APPROVED_STAGING.supabaseProjectRef, "STAGING_SUPABASE_PROJECT_REF", issues);
  assertExact(expectedDatabaseName, APPROVED_STAGING.supabaseDatabaseName, "EXPECTED_STAGING_DATABASE_NAME", issues);
  assertExact(supabaseProjectName, APPROVED_STAGING.supabaseProjectName, "STAGING_SUPABASE_PROJECT_NAME", issues);
  assertExact(supabaseOrganization, APPROVED_STAGING.supabaseOrganization, "STAGING_SUPABASE_ORGANIZATION", issues);

  for (const [name, value] of Object.entries(env)) {
    if (/^NEXT_PUBLIC_.*(SERVICE_ROLE|SECRET_KEY|DATABASE_PASSWORD|JWT_SECRET)/i.test(name) && value) {
      issues.push(`${name} exposes a privileged secret through the frontend environment.`);
    }
    if (!name.startsWith("PRODUCTION_") && value && containsDeniedProductionIdentifier(value)) {
      issues.push(`${name} contains a denylisted Production identifier.`);
    }
  }

  for (const name of ["NEXT_PUBLIC_SUPABASE_URL", "E2E_SUPABASE_URL"]) {
    const value = env[name]?.trim();
    if (!value) continue;
    collectError(issues, () => assertApprovedSupabaseTarget({
      url: value,
      projectRef: APPROVED_STAGING.supabaseProjectRef,
    }));
  }

  for (const name of [
    "SUPABASE_PROJECT_ID",
    "SUPABASE_PROJECT_REF",
    "SUPABASE_STAGING_PROJECT_REF",
    "E2E_EXPECTED_PROJECT_REF",
  ]) {
    const value = env[name]?.trim();
    if (value) assertExact(value, APPROVED_STAGING.supabaseProjectRef, name, issues);
  }

  for (const name of ["DATABASE_URL", "SUPABASE_DB_URL", "MIGRATION_DATABASE_URL"]) {
    databaseTarget(env[name], name, issues);
  }

  const hostedQaUrl = env.PLAYWRIGHT_BASE_URL ?? env.E2E_APP_URL;
  if (hostedQaUrl) {
    collectError(issues, () => assertApprovedHostedQaUrl(hostedQaUrl));
    if (env.E2E_ALLOW_REMOTE_SECURITY_TESTS !== "true") {
      issues.push("Hosted QA requires E2E_ALLOW_REMOTE_SECURITY_TESTS=true.");
    }
  }

  if (issues.length) return { ok: false, issues: [...new Set(issues)] };
  return {
    ok: true,
    identity: {
      appEnvironment: appEnv,
      deploymentEnvironment: deploymentEnv,
      projectRef: APPROVED_STAGING.supabaseProjectRef,
      supabaseHost: APPROVED_STAGING.supabaseApiHost,
      databaseHost: APPROVED_STAGING.supabaseDatabaseHost,
      databaseName: APPROVED_STAGING.supabaseDatabaseName,
      deploymentDomain,
      deploymentProject: APPROVED_STAGING.vercelProjectName,
      deploymentProjectId: APPROVED_STAGING.vercelProjectId,
      supabaseProjectName: APPROVED_STAGING.supabaseProjectName,
      supabaseOrganization: APPROVED_STAGING.supabaseOrganization,
      gitBranch,
    },
  };
}

export function assertStagingEnvironment(env) {
  const result = validateStagingEnvironment(env);
  if (!result.ok) throw new TargetSafetyError(result.issues);
  return result.identity;
}

// Kept for compatibility; unlike the former implementation this is a complete
// positive Staging assertion. Missing and unknown targets fail closed.
export function assertNoProductionTarget(env) {
  assertStagingEnvironment(env);
  return true;
}
