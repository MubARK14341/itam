# Dashboard Command Center V6

## Purpose and constraints

V6 is the authenticated staff dashboard inside the existing application shell. It is an operational decision surface, not a replacement for asset, request, maintenance, inventory, scan, report, or audit workflows. It uses only the current roles, capabilities, RLS, and authorized RPCs. It never fetches financial data for this dashboard and never substitutes an error with zero.

The three HTML references are not present in the workspace. Their approved design decisions are therefore applied from the delivery brief:

- A: `Priority now` precedes KPIs.
- B: functional coverage only.
- C: calm visual language, RTL/mobile discipline, and a compact hero.
- Rejected: copied shells, prototype workflows, fake metrics/history, dense KPI grids, and local-only actions.

## Information architecture

1. Existing application shell
2. Compact command hero and print metadata
3. Priority now
4. My work / today
5. Exactly four role-aware KPI cards
6. Risks and exceptions
7. At most two charts
8. Requests and maintenance
9. Assets and inventory
10. Recent activity / audit

`Priority now` is earlier in the DOM than the KPI grid at every viewport.

## Component map

```text
src/app/(app)/dashboard/page.tsx
  server session/approval/portal guard
  getDashboardCommandCenterData()
  DashboardCommandCenter

src/components/dashboard-v6/
  dashboard-command-center.tsx
  command-hero.tsx
  priority-now.tsx
  my-work.tsx
  kpi-grid.tsx
  risks-exceptions.tsx
  dashboard-charts.tsx
  operational-summaries.tsx
  recent-activity.tsx
  widget-state.tsx
  dashboard-print-header.tsx

src/lib/dashboard/
  dashboard-types.ts
  dashboard-filters.ts
  kpi-definitions.ts
  role-dashboard-config.ts
  priority-selector.ts
  get-command-center-data.ts
```

Client components render, translate, refresh with `router.refresh()`, and print. Server code authenticates, resolves the approved staff role/capabilities, and performs all reads. No service-role key is used.

## Data contract and sources

Every independently fallible widget is a `WidgetResult<T>` with `success`, `empty`, or `error`. The page-level metadata separately records `complete`, `partial`, or `stale`, the successful-source update time, and sanitized unavailable-source identifiers.

| Surface | Authoritative source | Detail bound |
| --- | --- | --- |
| Exact operational totals | `dashboard_operational_summary()` | One JSON result |
| Priority / request preview | `requests` non-financial projection | Top actionable rows only |
| Priority / maintenance preview | `maintenance_records` non-financial projection | Top actionable rows only |
| Asset exceptions | `assets` non-financial projection | Top exception rows only |
| Inventory risk | `consumables` non-financial projection | Top risk rows only |
| Request trend | `request_events`, exact-count gated and paged | 30 days; unavailable above safe bound |
| Recent activity | movement, maintenance, stock tables | Recent rows only |
| Actor labels | `user_labels(uuid[])` | Managers only; one batched call |
| User/role/capabilities | auth, `app_users`, `my_capabilities()` | Current user only |

The exact aggregate RPC prevents KPIs from depending on a `.limit(1000)` detail projection. Bounded detail rows are never used as exact totals. Financial tables, columns, projections, RPCs, cache keys, and DTO fields are absent.

## KPI definitions

Definitions live in `kpi-definitions.ts`; JSX receives definition metadata rather than duplicating it.

| KPI | Formula/source | Period | Direction | Financial |
| --- | --- | --- | --- | --- |
| Actionable requests | Exact `under_review` count in `dashboard_operational_summary()` | Current | Lower is better | No |
| Overdue requests | Exact explicit-overdue or past-return count | Current Riyadh day | Lower is better | No |
| Maintenance follow-up | Exact unique open/in-progress record matching long-open or unassigned/no-action semantics | Current | Lower is better | No |
| Critical consumables | Exact active items at/below a positive reorder level | Current | Lower is better | No |
| Available assets | Exact active `available` assets | Current | Higher is better | No |
| Active assets | Exact active assets | Current | Neutral | No |
| Preparation queue | Exact request statuses in the established preparation bucket | Current | Lower is better | No |
| Ready delivery | Exact `ready_for_pickup` requests | Current | Neutral | No |
| Returns due | Exact delivered/partially-returned/overdue requests due today or earlier | Current Riyadh day | Lower is better | No |
| Missing location | Exact active assets with no location | Current | Lower is better | No |
| Assigned maintenance | Exact open/in-progress records assigned to current user | Current | Neutral | No |
| Assigned maintenance overdue | Assigned open/in-progress records past `next_due_date` | Current Riyadh day | Lower is better | No |
| Assigned requests | Exact non-terminal requests assigned to current user | Current | Neutral | No |

Targets and prior-period comparisons are omitted unless backed by a stored target and comparable historical source. All cards display definition, source, period, update time, drilldown, partial state, and financial classification.

Aggregate drilldowns use the same shared predicates as their destination work queues: `maintenance?view=followup`, `maintenance?view=past_due`, `requests?view=returns_due`, `assets?view=lost_damaged`, and `assets?view=missing_location`. This prevents a combined KPI from opening a narrower or unrelated list.

## Priority selection rules

All priority candidates use one normalized shape and one pure selector:

```text
severity rank (critical → warning → info → neutral)
→ overdue duration descending
→ nearest SLA/due deadline
→ oldest created_at
→ stable entity ID
```

Candidates include real entity IDs, timestamps, owner/responsibility labels, due dates, SLA state, location/scope where available, impact labels, and real drilldown routes. If any required priority source fails, the widget is partial/error and its empty state never claims that everything is healthy.

## Role visibility and real actions

| Surface | Admin / IT manager | Technician | Warehouse manager | Viewer | Auditor |
| --- | --- | --- | --- | --- | --- |
| Primary hero action | `/alerts` | `/maintenance` | `/requests?view=warehouse` | `/reports` | `/alerts` |
| Secondary search | `/scan` when scan capability/role permits | `/scan` | `/scan` | Omitted | Omitted |
| My work | approvals, unassigned/SLA queues | assigned maintenance/requests where ownership is provable | preparation, pickup, return, stock queues | read-only summary | read-only exceptions |
| KPIs | management operations | assigned maintenance | warehouse operations | current asset/service overview | integrity/audit exceptions |
| Mutation controls | None on dashboard; links to authorized workflows | None on dashboard | None on dashboard | None | None |
| Financial content | Not requested/fetched | Never | Never | Never | Never |

Viewer and auditor surfaces are read-only. Portal users redirect to `/client-portal`; pending/rejected staff redirect to `/pending-approval`; anonymous users remain middleware-redirected to `/login`. The approved server-resolved role selects dashboard actions; the fetched capability set remains available to the authorized application shell. RLS/RPC remains authoritative, and the dashboard exposes no mutation controls.

All dashboard CTAs are existing routes: `/alerts`, `/requests`, `/maintenance`, `/assets`, `/consumables`, `/purchase-requests`, `/scan`, `/reports`, `/activity`, and entity detail routes. There are no toast-only, placeholder, local-completion, or fake-success actions.

## States and freshness

- Loading: route `loading.tsx` renders stable, accessible skeletons in final DOM order.
- Empty: explains that the authorized query returned no rows; no false health claim when another source failed.
- Partial: names only the sanitized source label that failed and keeps successful widgets usable.
- Error: bounded message plus `router.refresh()` retry; raw Postgres errors are never serialized.
- Stale: the contract and translated status treatment are defined with a five-minute threshold for a future cached transport. A normal V6 request is freshly server-rendered, so it reports `complete` or `partial` rather than inventing stale source time.

## Responsive, RTL, accessibility, and print

- Logical properties only; mixed identifiers use `dir="ltr"` and `unicode-bidi: isolate`.
- One application `<main>` from the existing shell and ordered `h1`/`h2` headings.
- Touch targets are at least 44px; grids use `min-w-0`; tables either become cards or use component-scoped scrolling.
- No page-level horizontal hiding. Target viewports: 320, 360, 390, 430, 768, 1024, and 1440px.
- Visible focus, named controls, semantic links/buttons, status icon plus label, `aria-live` for refresh/errors, reduced-motion support, and same-data list/table alternatives for charts.
- A4 print CSS hides shell navigation and interactive actions, shows report/role/scope/period/filter/source/update/print/user metadata, avoids card splitting, preserves grayscale meaning, and prints chart alternatives.

## Test matrix

| Layer | Coverage |
| --- | --- |
| Unit | KPI registry, direction semantics, priority ordering, status tokens, role config, filter parsing, age/SLA calculations, empty/error mapping |
| Contract | no financial fields/RPCs/service role, no client data fetch, no unsafe HTML, max two charts, Priority before KPI, real routes |
| Security | role response minimization, read-only roles, portal/pending/rejected guards, capability/UI parity, XSS text rendering |
| Data | exact summary use, status-group math, critical counts, open/final request semantics, no bounded-row totals |
| Browser | admin, technician, warehouse, viewer, auditor, portal; AR/EN, light/dark; links and refresh |
| Responsive | 320×800, 390×844, 768×1024, 1440×900; no document overflow |
| Keyboard/a11y | focus order, named controls, heading order, chart alternatives, print button |
| Failure | priority partial state, chart fallback, independent widgets remain usable |
| Print | A4 media, navigation/actions hidden, metadata/update visible, no financial content or clipping |

## Deliberate gaps

- The application has no safe global search API. V6 links authorized operational roles to the existing `/scan` search workflow rather than implementing an incomplete cross-domain search.
- No financial KPI is shown. This avoids fetching or serializing financial values and is valid because financial exposure is optional.
- No migration is planned: current exact aggregates plus RLS-protected targeted queries satisfy correctness and performance. A migration will be added only if implementation evidence disproves that.

## Verification evidence

Final local verification on 2026-07-28:

- `npm ci`: clean dependency installation.
- `npm audit --omit=dev`: zero production vulnerabilities.
- `npm test`: 44 files and 228 tests passed.
- `npm run lint`: no warnings or errors.
- `npx tsc --noEmit`: passed.
- `npm run build`: passed; `/dashboard` remains a dynamic server-rendered route at 11.2 kB page code and 188 kB first load.
- `npm run test:e2e:local:clean`: schema lint clean and 52/52 fail-closed local Supabase tests passed, including all six staff dashboard roles, responsive/theme/language checks, and print media.
- Real-browser and Playwright QA: Arabic RTL and English LTR, light and dark themes, keyboard focus order, desktop, 1024 px, 768 px, 430 px, 390 px, 360 px, 320 px, and the mobile drawer showed no document or main-content horizontal overflow.
