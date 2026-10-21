<!-- PRODUCTION-BOUNDARY: ACTIVE-DENIAL -->
# Database migrations (post-demo)

> Apply and inspect only exact approved Staging after `npm run safety:production-boundary`.
> Production and unknown targets are denied for reads and writes.

Historically applied files are marked `APPLIED` in this document. The eight
`20260727*` production-remediation files are **local-only proposals** and have not been
applied to the project database. Because the remote migration ledger has known drift,
this directory must not be treated as a safe `db push` source; follow
`../docs/MANUAL_DB_MAINTENANCE.md`.

## 2026-08-17 registration admission boundary — STAGING APPLIED

`20260817204500_registration_admission_rpc_boundary.sql` makes the Auth trigger
enforce staff registration modes instead of relying on the registration page. It
rejects closed or missing configuration, invalid/exhausted invitations, depleted
gradual capacity, and disallowed email domains; role requests now come only from
validated server configuration. Staff and customer-portal invitation claims are
row-locked before counters change. Registration settings and invitations are
managed through capability-gated RPCs, direct browser DML is revoked, invite codes
are server-generated and audit-redacted, and all three registration control tables
have unified-audit coverage. Exact approved Staging recorded ledger entry
`20260817190626 registration_admission_rpc_boundary`; the rollback-only database
contract proved closed, open/domain, invite-only/exhaustion, gradual-capacity,
missing-configuration, ACL, and unchanged-state behavior. Production was not
contacted.

`20260817221500_registration_trusted_provisioning_compatibility.sql` preserves
Supabase Auth Admin/service-role provisioning while registration is closed, but
forces those newly provisioned staff requests to `viewer` and leaves them pending;
user metadata still cannot choose a role. Browser roles, including authenticated
users, have no execute access to the internal claim function. Exact approved
Staging recorded ledger entry
`20260817190948 registration_trusted_provisioning_compatibility`.

## 2026-08-16 maintenance search pagination — STAGING APPLIED

`20260816213510_maintenance_search_index.sql` adds an authenticated-only,
non-financial `security_invoker` view that lets maintenance search use one
cursor-paginated Data API query across the full RLS-visible asset inventory. It
replaces the client query's former 100-asset prefetch ceiling without weakening the
financial column-grant boundary. Exact approved Staging recorded ledger entry
`20260816183801 maintenance_search_index`; its security and performance advisors
reported no finding for the view. Production was not contacted.

## 2026-08-17 atomic supplier administration — STAGING APPLIED

`20260817164103_supplier_atomic_writes.sql` replaces the browser's independently
committed supplier/category writes with two role-gated `SECURITY DEFINER` RPCs,
removes direct `authenticated` DML policies and grants, serializes edits with a row
lock, and adds unified-audit triggers for supplier changes. Exact approved Staging
recorded ledger entry `20260817164616 supplier_atomic_writes`; an authenticated
IT-manager contract proved create/update/link replacement and activation, denied
direct DML, rejected an unknown category without writing, and rolled the whole probe
back. The Security Advisor's two authenticated-function warnings are intentional:
both exposed RPCs verify `auth.uid()` and the approved admin/IT-manager role before
performing any privileged write; `anon` has no execute access.

`20260817165350_index_supplier_categories_category.sql` adds the missing
category-first foreign-key index identified by the Staging Performance Advisor.
Exact approved Staging recorded ledger entry
`20260817165425 index_supplier_categories_category`. Production was not contacted.

## 2026-08-17 customer and portal activity boundary — STAGING APPLIED

`20260817170623_customer_portal_activity_gate.sql` makes staff customer writes
RPC-only, validates and row-locks customer changes, and removes the former direct
`authenticated` write policies and grants. It also separates internal portal account
identity from operational portal access: inactive, unapproved, and explicitly
disabled customers retain only the disabled-context response, while operational
portal RPCs and storage-policy helpers receive no customer identity. Customer
rejection now deactivates the customer and returns `not_found` for unknown targets.
A rolled-back exact-Staging rehearsal passed all positive, denial, direct-DML, and
disabled-context checks before application. Exact approved Staging recorded ledger
entry `20260817171620 customer_portal_activity_gate`. The Security Advisor reports
only the expected authenticated-`SECURITY DEFINER` warnings for the intentionally
exposed portal/customer RPCs; `anon` is denied, staff mutations re-check role and
identity, and the context-only account helper is not executable by clients.
Production was not contacted.

> All migrations are **additive and safe**: no `DROP TABLE` / `TRUNCATE` / bulk `DELETE`,
> no `anon` access opened, no `service_role` in the frontend. The `attachments` storage
> bucket stays **private**. Existing rows (636 assets / 18 consumables / existing users)
> are untouched; pre-existing users were backfilled to `approval_status='approved'`.

Apply in filename (timestamp) order:

| # | File | Purpose |
|---|------|---------|
| 1 | `20260630201216_staff_registration_system.sql` | Staff self-registration, manager approval, registration modes (closed / open_with_approval / gradual / invite_only), invite codes, `is_approved()` / `app_user_role()` (approval-gated), `sel_auth` reads gated to approved users. |
| 2 | `20260630201250_companies_classification.sql` | `companies` table (brand ≠ supplier) + nullable `assets.company_id` / `consumables.company_id` + RLS + seed brands. |
| 3 | `20260630201423_lock_down_anon_on_manager_rpcs.sql` | Revoke `anon` EXECUTE on manager/approval RPCs (Supabase auto-grants it). |
| 4 | `20260630210235_fix_null_role_guard_privilege_escalation.sql` | **Security fix:** explicit NULL check in `approve_user` / `reject_user` / `reset_user_pending` (a NULL role bypassed `not in (...)` → privilege escalation). |
| 5 | `20260630215704_rfid_and_consumable_replenishment_fields.sql` | Optional unique `rfid_tag` on assets+consumables; per-purchase cost/supplier/invoice columns on `consumable_transactions`. |
| 6 | `20260630222755_restrict_financial_invoice_attachments.sql` | **Security fix:** kind-aware `attachments` read policy + path-aware storage read policy → financial invoice attachments (`warranty_invoice` / `purchase_invoice` / `consumable_invoice` / `replenishment_invoice`) readable only by `admin` / `it_manager`. Maintenance/operational attachments and the device photo are unaffected. |

The original hardening script (`../dev-only/secure_rls.sql`) predates these and is **historical** —
do not re-run it on the live DB (see its header). Supabase migrations are authoritative.

## 2026-07-31 schema compatibility contract — LOCAL ONLY

`20260731073033_schema_compatibility_contract.sql` is an additive local proposal
that runs after M1–M8. It adds a deny-by-default compatibility ledger and the minimal
`app_schema_compatibility()` RPC used by the app gate and `/api/health/schema`.
Version `2026073101` requires the five critical create/aggregate RPC signatures.

Local clean rebuild, `db lint`, the security advisor, the public health check, and
61 Playwright role/Storage/workflow/concurrency/RPC tests pass. This does not
authorize staging or production application. Release order is DB migration first,
health check second, application deployment last.

## 2026-07-31 attachment quarantine lifecycle — LOCAL ONLY

`20260731105203_attachment_quarantine_lifecycle.sql` is an additive local proposal
after the schema compatibility migration. It adds `pending/clean/infected/error`
scanner evidence to both attachment registries. Storage reads and signed URLs require
both entity authorization and `scan_status='clean'`; only `service_role` may call the
scanner completion RPC.

The migration intentionally marks every historical row `pending` and deletes nothing.
Do not apply it remotely until an AV/CDR worker and full historical scan/backfill have
been rehearsed in representative staging. The clean local rebuild, DB lint, byte
validation contracts, role matrix, quarantine denial, and download disposition tests
pass. See `../docs/audit-remediation/ATTACHMENT_SCAN_RUNBOOK.md`.

## 2026-07-31 custody integrity and reconciliation — LOCAL ONLY

`20260731110758_custody_integrity_and_reconciliation.sql` closes the bidirectional
asset/active-assignment invariant at transaction end, blocks direct browser DML on
`asset_assignments`, preserves return evidence, and serializes custody RPCs. It also
adds a persistent reconciliation case queue and manager/auditor RPCs.

The migration inventories contradictions into cases only; it never guesses a holder
or mutates historical custody source rows. A disposable local fixture proves that a
historical contradiction is queued, operational RPCs refuse it, and the read-only CSV
export works. Clean rebuild, DB lint, 70 Playwright tests, 261 unit/contract tests,
TypeScript, lint, and production build pass.

Do not apply it remotely until a representative backup has been restored to staging,
the generated queue has been reviewed, and ITAM Owner/Internal Audit own the field
reconciliation and change-ticket evidence. See
`../docs/audit-remediation/CUSTODY_RECONCILIATION_REQUIRED.md`.

## 2026-07-31 financial truthfulness — LOCAL ONLY

`20260731123640_financial_truthfulness.sql` makes missing maintenance cost
representable, adds explicit `cost_recorded` provenance, and removes the atomic
create path's historical NULL-to-zero coercion. It does not rewrite any amount;
historical zero remains unconfirmed.

The migration also adds finance-only, amount-free summary/list RPCs for missing
purchase cost/date, warranty, manufacturer, and model. Financial KPIs use a
documented 100% coverage threshold, one currency, an as-of timestamp, and
used/excluded counts. Non-financial roles continue to be denied financial columns,
and are denied the queue itself.

Clean rebuild, DB lint, 80 Playwright tests, 268 unit/contract tests, role UI tests,
TypeScript, lint, and production build pass locally. Do not apply remotely until
representative staging proves the queue, currency partitioning, historical-zero
review, and Finance/Data Owner sign-off. See
`../docs/audit-remediation/FINANCIAL_DATA_QUALITY.md`.

## 2026-07-31 checksummed manifest and P0 schema contract — LOCAL ONLY

`20260731133000_schema_contract_p0_complete.sql` advances compatibility to
`2026073102` and requires the critical attachment, custody, and financial signatures
in addition to the original create/aggregate RPCs. Application code with this version
fails closed against a partially migrated database.

`docs/audit-remediation/MIGRATION_MANIFEST.json` is generated from every timestamped
SQL file plus the baseline/test bootstraps. It records purpose, ordered dependency,
execution classification, and SHA-256. `npm run audit:migration-manifest` fails when a
source or generated artifact drifts. The clean runner verifies it before reset and
applies its 48 local steps; the production-only Cron migration remains excluded.

This closes reproducible local replay only. The generated baseline substitutes for
uncommitted foundational history, the local replay has no Supabase platform migration
ledger, and neither artifact is an authoritative production backup. Reconcile ledger,
Auth/Storage object bytes, ACLs, extensions, globals, and secrets through an authorized
staging restore before any remote migration.

## 2026-07-31 Stocktake MVP — LOCAL ONLY

`20260731150000_stocktake_mvp.sql` replaces direct table mutation with a complete,
non-financial Stocktake RPC workflow: immutable location snapshot, blind scan-first
count, QR/serial/RFID/tag resolution, expected/observed classifications, recount and
reason gates, independent review, observed-only atomic location adjustment,
append-only events, idempotent operations, final locking, and correction sessions.
Auditor is read-only; warehouse manager/admin/IT manager manage.

`20260731151000_schema_contract_stocktake.sql` advances compatibility to
`2026073103` and requires the critical Stocktake RPC signatures. Clean replay,
81 E2E tests, 276 unit/contracts, UI role smoke, build, and logical restore pass
locally. No production or staging migration was applied. See
`../docs/audit-remediation/STOCKTAKE_RUNBOOK.md`.

> Migrations 7–28 (customer requests, scan_logs, asset_pools, notification_settings, …)
> were applied in later phases; see `list_migrations` for the authoritative ordered list.

## 2026-07-27 production remediation — NOT APPLIED

The following files require clean-environment execution, role/concurrency tests, backup,
and individual approval before any production use:

`20260727144004_harden_staff_request_creation.sql`,
`20260727144620_attachment_classification_hardening.sql`,
`20260727145511_request_state_machine_hardening.sql`,
`20260727150423_purchase_receiving_bridge_hardening.sql`,
`20260727152018_atomic_business_operations.sql`,
`20260727152842_capability_consistency_hardening.sql`,
`20260727153809_future_asset_integrity_guards.sql`, and
`20260727154633_dashboard_exact_aggregates.sql`.

On 2026-07-27, all eight applied and retried successfully in an ephemeral PGlite
PostgreSQL 18 scratch database. The rehearsal also passed 14 targeted assertions,
transaction rollback injection, and an embedded backup/restore. M6 was corrected to
drop the policies it recreates before retry, and M3 was corrected so asset-bearing
returns cannot bypass the required atomic inspection path. These scratch results were
supplemented on 2026-07-28 by a guarded local Supabase rebuild and 44 passing
JWT/PostgREST/Storage/workflow/concurrency/UI tests. This is still not production
migration authorization; `pg_cron` and an authoritative production-equivalent restore
remain manual. See `../docs/STAGING_VALIDATION_REPORT.md`.

## Phase 2 — Production Readiness (2026-07-01+)

| Version | File | Purpose |
|---|---|---|
| `20260701141909` | `20260701141909_harden_storage_write_policies_role_path_aware.sql` | **MEDIUM-2 (APPLIED):** role/path-aware INSERT/UPDATE/DELETE policies on `storage.objects` (bucket=attachments). Financial-invoice paths writable only by admin/it_manager; operational paths by admin/it_manager/technician; viewer/auditor lose write. Read policy untouched. Non-destructive (policies only). |
| `20260701142912` | `20260701142912_consumable_stock_move_atomic_rpc.sql` | **MEDIUM-1 (APPLIED):** atomic `consumable_stock_move(...)` RPC (in/out/adjust) — row-locked (`FOR UPDATE`), server-authoritative balance, prevents lost updates + negative stock (`insufficient_stock`), role-gated. Additive (function only); the `quantity_on_hand >= 0` CHECK already existed and was **not** re-added. Client `issue/replenish/adjust/stockTxn` in `queries.ts` now route through it. |
| `20260701145434` | `20260701145434_high1_financial_column_protection_strict.sql` | **HIGH-1 (APPLIED):** `is_financial_viewer()` + 6 self-gated financial RPCs (SECURITY DEFINER) + `maintenance_guard_financial` trigger (technician cannot enter/erase `cost`). NOTE: the column REVOKEs here were ineffective (table-level grant overrides) — corrected by the next migration. |
| `20260701150032` | `20260701150032_high1b_financial_column_grants_correction.sql` | **HIGH-1b (APPLIED):** revoke table-level SELECT from `authenticated` then grant SELECT on **non-financial columns only** for assets/consumables/consumable_transactions/maintenance_records/request_items/depreciation_rules; revoke stray `anon` SELECT on depreciation_rules. Financial amounts/rates now blocked at column level; managers read them via the RPCs. Client selects in `queries.ts`/`requests.ts` cleaned + `canSeeMaintenanceCost`→`canSeeFinancial`. **Maintenance note:** new columns on these 6 tables need an explicit `grant select` to `authenticated`. |

All Phase 2 items (MEDIUM-2, MEDIUM-1, HIGH-1) are **applied**. Remaining: enable Leaked
Password Protection in Supabase Dashboard (manual). See `../PHASE_2_PRODUCTION_READINESS_PLAN.md`.

## Phase 3 — Post-audit hardening (2026-07-03/04)

> Note: `20260702184849_harden_user_mgmt_admin_protection` exists **in the database only**
> (its file was never committed). Its guards (`cannot_manage_self` / `cannot_manage_admin`)
> are re-declared verbatim — and superseded — by `20260703200000` below, restoring repo parity.

| Version | File | Purpose |
|---|---|---|
| `20260703200000` | `20260703200000_protect_admin_accounts_from_it_manager.sql` | **HIGH (APPLIED):** `approve_user` / `reject_user` / `reset_user_pending` — admin targets modifiable only by admin, self-management blocked, target row locked with `FOR UPDATE` (no concurrent-approval race), `user_not_found` instead of silent success. |
| `20260703201000` | `20260703201000_asset_custody_atomic_rpcs.sql` | **HIGH (APPLIED):** atomic custody RPCs `asset_assign` / `asset_return` / `asset_change_status` (row-locked, state-machine pre-checked, movement stamped with `auth.uid()`), replacing the 3-statement client-side flows that could orphan `asset_assignments` rows. `queries.ts` routes through them. |
| `20260703202000` | `20260703202000_gate_request_items_by_request_status.sql` | **MEDIUM (APPLIED):** `request_items` INSERT/DELETE allowed only while the parent request is `draft`/`under_review` — deleting a delivered item can no longer strand an asset in `rented`/`sold`. |
| `20260703203000` | `20260703203000_pin_search_path_helper_functions.sql` | **LOW (APPLIED):** pin `search_path = public` on 8 helper/trigger functions flagged by the Supabase security advisor. |

## Batch 7 — Production Readiness RC1 (2026-07-07)

| Version | File | Purpose |
|---|---|---|
| `20260707020347` | `20260707020347_rc1_anon_hardening.sql` | **MEDIUM (APPLIED):** defense-in-depth. Revoke `EXECUTE` on 4 pure trigger functions (`audit_trigger`, `handle_new_user`, `maintenance_guard_financial`, `requests_log_status_event`) from `public`/`anon`/`authenticated` (triggers fire as owner; the grant only widened the RPC surface), and drop stray `anon` table privileges on `depreciation_rules` / `supplier_categories` (RLS already denied anon). No behavioural change.

## Batch 8 — Final RC1 Stabilization hygiene (2026-07-07)

Two optional defense-in-depth fixes surfaced by the RC1 stabilization audit, applied with explicit user approval (verified live, rolled-back smoke test):

| Version | File | Purpose |
|---|---|---|
| `20260707030000` | `20260707030000_enable_rls_purchase_request_sequences.sql` | **M5 (APPLIED):** enable RLS on `purchase_request_sequences` (was the only RLS-disabled public table; advisor "critical"). Table has zero `anon`/`authenticated` grants and is only touched by SECURITY DEFINER RPCs, so RLS-with-no-policy = safe deny-all for clients. Matches `request_sequences` posture. No behavioural change. |
| `20260707030100` | `20260707030100_consumables_guard_unit_cost_financial.sql` | **M4 (APPLIED):** `consumables_guard_financial` BEFORE INSERT/UPDATE trigger on `consumables` — mirrors `pr_items_guard_financial`: non-financial writers (technician/viewer/auditor) cannot set/overwrite `unit_cost` (nulled on INSERT, frozen on UPDATE); `admin`/`it_manager` unaffected. Closes the write-guard asymmetry (read was already column-blocked). Additive: function + trigger only. | |

### ⚠️ Repo ↔ DB migration drift (found in the RC1 audit)

`list_migrations` reports **58** applied versions; this folder holds **45** `.sql` files. The
gap is **13**: the entire foundational block below was applied to the database (bootstrap phase)
but its files were **never committed here**, so `migrations/` alone **cannot rebuild the database**:

```
20260628213022_itam_core_schema            20260629153512_user_label_function
20260628213047_itam_seed_reference_data    20260629195055_ref_insert_for_ops_roles*
20260628213112_itam_storage_and_rls        20260630150919_maintenance_vendor_shop_fields
20260628213425_itam_restore_arabic_guard   20260630150931_supplier_categories
20260629144743_add_employees_rls_policies  20260630150936_depreciation_rules
20260629153509_maintenance_fault_fields    20260630150948_rbac_settings_and_supplier_policies
```
(*`ref_insert_for_ops_roles` has a loose copy at `itam-app/ref_insert_for_ops_roles.sql`.)
Plus the already-documented DB-only `20260702184849_harden_user_mgmt_admin_protection`.

**Mitigation shipped:** `_baseline/00_full_db_snapshot_20260707.sql` — a generated full-schema
snapshot (types, sequences, tables, constraints, indexes, functions, triggers, RLS + policies)
that recreates the current structure from empty. **It excludes column-level GRANTs (financial
protection), storage buckets/policies, and data** — for a byte-perfect backup use
`../BACKUP_AND_ROLLBACK_PLAN_AR.md` (archival only). Use the local restore rehearsal;
Production backup tooling is intentionally unavailable in this repository. See `_baseline/README.md`.
