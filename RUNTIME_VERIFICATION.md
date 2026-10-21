# Local runtime verification

The standalone synthetic React/Vite demo was tested in Chromium at `http://127.0.0.1:4173`, at 1440×1000 and 390×844 viewports. External page requests and service workers were blocked. The Next.js source application was not connected to a live backend.

Covered flows passed: persona selection; manager dashboard and asset inventory; customer portal; redirecting a portal persona from staff routes; rejecting an empty request; creating one synthetic request and retaining it after reload in local storage; hiding asset creation from the read-only persona; reset-dialog focus and Escape cancellation; and unknown-route recovery. No page exceptions or console errors were observed in those checks. Automated axe WCAG A/AA checks found zero violations in the tested manager dashboard, mobile asset inventory and loaded customer portal. This does not clear every route or the earlier static source findings.

Manual screenshot review found legacy human-looking fixture labels. They were replaced with numbered synthetic employee/contact labels, all-zero non-dialable seeded phone placeholders and `.invalid` contact emails. Two privacy invariants were added. The full demo suite now passes **89 tests**, with typecheck and Vite build also passing using the clean-installed dependency tree. No original names or screenshots containing the legacy labels were selected for delivery.

## Clean installation

The core installed with `npm ci --offline --ignore-scripts --no-audit --no-fund` in an initially empty dependency tree. Missing archives were downloaded only from the official npm registry and verified against the unchanged lockfile integrity; the actual install and subsequent checks had outbound application networking blocked. Core lint, typecheck, **1612 tests in 166 files**, and Next.js build all passed in that clean tree. The standalone demo also passed its clean installation with lifecycle scripts disabled. Dependency vulnerability clearance is not claimed.

## Local database

The subsequently authorized PostgreSQL execution context succeeded without changing device security settings. It used PostgreSQL 17.11, a private Unix socket, TCP disabled, OS peer authentication and no passwords. Official pgTAP 1.3.4 SQL helpers were loaded only in the disposable database. Minimal Auth/Storage SQL fixtures were used; no Supabase HTTP service, real account or production database was contacted.

**119 of the 121 ordered local manifest steps passed.** These two scheduler migrations were deliberately excluded because they require cron/network/Vault infrastructure and could schedule outbound automation:

- `migrations/20260806171000_edit_5_email_cron.sql`
- `migrations/20260810162000_production_email_dispatch_cron.sql`

The complete manifest, external worker and scheduling system are not certified. The rollback-only source probe in `nextjs-app/scripts/test/publication-rls-probe.sql` passed **27 assertions** covering RLS, customer and requester isolation, direct financial column denial, manager-only financial RPC results, closed public registration, portal-disabled/missing-settings denial and the exact five-field public QR projection. Setup used the source's trusted Auth Admin provisioning fixture; registration settings and application permissions were not weakened. The pgTAP helper schema is separate from application functions. The later portal activity gate returns `not_portal` when disabled; the probe also asserts no request payload is returned.

Full Auth/Storage/PostgREST integration, all application workflows, backup/restore rehearsal and external scheduling remain unverified. Test services were stopped after evidence capture; no persistent credential, remote repository, push or deployment was created.

## Screenshots

All images contain synthetic data and were visually reviewed:

- [Persona picker](docs/screenshots/itam-role-picker.png)
- [Manager dashboard](docs/screenshots/itam-manager-desktop-viewport.png)
- [Asset inventory](docs/screenshots/itam-assets-desktop.png)
- [Mobile inventory](docs/screenshots/itam-assets-mobile.png)
- [Customer portal](docs/screenshots/itam-customer-portal-viewport.png)
- [Saved synthetic request](docs/screenshots/itam-saved-request.png)
