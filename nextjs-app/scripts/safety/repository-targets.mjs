import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  APPROVED_STAGING,
  ProductionBoundaryError,
  assertApprovedSupabaseTarget,
  assertApprovedVercelProject,
  containsDeniedProductionIdentifier,
} from "./production-boundary.mjs";

export function parseEnvText(source) {
  const values = new Map();
  for (const rawLine of source.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const separator = line.indexOf("=");
    if (separator < 1) continue;
    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim().replace(/^(['"])(.*)\1$/, "$2");
    values.set(key, value);
  }
  return values;
}

export function assertNoActiveProductionBindings(root, relativePaths) {
  const issues = [];
  for (const relativePath of relativePaths) {
    const path = resolve(root, relativePath);
    if (!existsSync(path)) continue;
    const values = parseEnvText(readFileSync(path, "utf8"));
    for (const [key, value] of values) {
      if (containsDeniedProductionIdentifier(value)) {
        issues.push(`${relativePath}:${key} contains a denylisted Production target.`);
      }
      if (/PRODUCTION/i.test(key) && value) {
        issues.push(`${relativePath}:${key} is an active Production-labelled binding.`);
      }
      if (["SUPABASE_ACCESS_TOKEN", "VERCEL_TOKEN", "E2E_VERCEL_SHARE_URL"].includes(key) && value) {
        issues.push(`${relativePath}:${key} is an account-wide credential and must not be persisted.`);
      }
      if (/_vercel_share=/i.test(value)) {
        issues.push(`${relativePath}:${key} contains a temporary Vercel share token and must not be persisted.`);
      }
    }
  }
  if (issues.length) throw new ProductionBoundaryError(issues);
  return true;
}

export function assertApprovedActiveEnvironmentBindings(root, relativePaths) {
  const issues = [];
  for (const relativePath of relativePaths) {
    const path = resolve(root, relativePath);
    if (!existsSync(path)) continue;
    const values = parseEnvText(readFileSync(path, "utf8"));
    for (const name of ["NEXT_PUBLIC_SUPABASE_URL", "E2E_SUPABASE_URL", "STAGING_SUPABASE_URL"]) {
      const value = values.get(name);
      if (!value) continue;
      try {
        assertApprovedSupabaseTarget({
          url: value,
          projectRef: APPROVED_STAGING.supabaseProjectRef,
        });
      } catch (error) {
        if (error instanceof ProductionBoundaryError) {
          issues.push(`${relativePath}:${name} is not the approved Staging URL.`);
        } else throw error;
      }
    }
    for (const name of [
      "SUPABASE_PROJECT_ID",
      "SUPABASE_PROJECT_REF",
      "SUPABASE_STAGING_PROJECT_REF",
      "E2E_EXPECTED_PROJECT_REF",
    ]) {
      const value = values.get(name);
      if (value && value !== APPROVED_STAGING.supabaseProjectRef) {
        issues.push(`${relativePath}:${name} is not the approved Staging ref.`);
      }
    }
    if (values.get("APP_ENV") && values.get("APP_ENV") !== "staging") {
      issues.push(`${relativePath}:APP_ENV must equal staging.`);
    }
    if (values.get("DEPLOYMENT_ENV") && values.get("DEPLOYMENT_ENV") !== "preview") {
      issues.push(`${relativePath}:DEPLOYMENT_ENV must equal preview.`);
    }
  }
  if (issues.length) throw new ProductionBoundaryError(issues);
  return true;
}

export function assertNoProductionTextFiles(root, relativePaths) {
  const issues = [];
  for (const relativePath of relativePaths) {
    const path = resolve(root, relativePath);
    if (!existsSync(path)) continue;
    const source = readFileSync(path, "utf8");
    if (containsDeniedProductionIdentifier(source) || /\[account\.production_/i.test(source)) {
      issues.push(`${relativePath} contains active Production-only material.`);
    }
  }
  if (issues.length) throw new ProductionBoundaryError(issues);
  return true;
}

export function readAndAssertVercelLink(root) {
  const path = resolve(root, ".vercel/project.json");
  if (!existsSync(path)) {
    throw new ProductionBoundaryError([".vercel/project.json is required; deployment fails closed."]);
  }
  let project;
  try {
    project = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new ProductionBoundaryError([".vercel/project.json is invalid."]);
  }
  return assertApprovedVercelProject({
    projectId: project.projectId,
    projectName: project.projectName,
    teamId: project.orgId,
  });
}

export function readAndAssertSupabaseLink(root) {
  const configPath = resolve(root, "supabase/config.toml");
  if (!existsSync(configPath)) {
    throw new ProductionBoundaryError(["supabase/config.toml is required; Supabase operations fail closed."]);
  }
  const config = readFileSync(configPath, "utf8");
  const configRef = config.match(/^\s*project_id\s*=\s*"([^"]+)"\s*$/m)?.[1] ?? "";
  if (configRef !== APPROVED_STAGING.supabaseProjectRef) {
    throw new ProductionBoundaryError([
      "supabase/config.toml is not pinned to the approved Staging project.",
    ]);
  }

  const linkedPath = resolve(root, "supabase/.temp/linked-project.json");
  if (!existsSync(linkedPath)) {
    throw new ProductionBoundaryError([
      "supabase/.temp/linked-project.json is required; an unknown link is never assumed safe.",
    ]);
  }
  let linked;
  try {
    linked = JSON.parse(readFileSync(linkedPath, "utf8"));
  } catch {
    throw new ProductionBoundaryError(["Supabase linked-project metadata is invalid."]);
  }
  assertApprovedSupabaseTarget({
    url: `https://${linked.ref ?? "missing"}.supabase.co`,
    projectRef: linked.ref,
  });
  if (linked.name !== APPROVED_STAGING.supabaseProjectName) {
    throw new ProductionBoundaryError([
      "Supabase linked project name is not the approved Staging project.",
    ]);
  }
  return { projectRef: linked.ref, projectName: linked.name };
}

export function assertPreviewEnvironmentFile(root) {
  const path = resolve(root, ".vercel/.env.preview.local");
  if (!existsSync(path)) return true;
  const values = parseEnvText(readFileSync(path, "utf8"));
  if (values.get("APP_ENV") !== "staging" || values.get("DEPLOYMENT_ENV") !== "preview") {
    throw new ProductionBoundaryError([
      "Vercel Preview environment must identify APP_ENV=staging and DEPLOYMENT_ENV=preview.",
    ]);
  }
  assertApprovedSupabaseTarget({
    url: values.get("NEXT_PUBLIC_SUPABASE_URL"),
    projectRef: APPROVED_STAGING.supabaseProjectRef,
  });
  if (values.get("VERCEL_TARGET_ENV") && values.get("VERCEL_TARGET_ENV") !== "preview") {
    throw new ProductionBoundaryError(["VERCEL_TARGET_ENV must equal preview."]);
  }
  return true;
}
