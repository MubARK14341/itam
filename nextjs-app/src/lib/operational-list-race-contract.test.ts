import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

function source(path: string): string {
  return readFileSync(resolve(import.meta.dirname, path), "utf8");
}

const alertsPage = source("../app/(app)/alerts/page-client.tsx");
const assetsPage = source("../app/(app)/assets/page-client.tsx");
const maintenancePage = source("../app/(app)/maintenance/page-client.tsx");
const purchaseRequestsPage = source("../app/(app)/purchase-requests/page.tsx");
const requestsPage = source("../app/(app)/requests/page-client.tsx");
const consumablesPanel = source("../components/consumables/consumables-panel.tsx");

function functionBody(sourceText: string, start: string, end: string): string {
  const startIndex = sourceText.indexOf(start);
  const endIndex = sourceText.indexOf(end, startIndex);
  expect(startIndex).toBeGreaterThanOrEqual(0);
  expect(endIndex).toBeGreaterThan(startIndex);
  return sourceText.slice(startIndex, endIndex);
}

function expectRequestGateBeforeCommit(body: string, commit: string) {
  const begin = body.indexOf("beginOperationalListRequest(");
  const rejected = body.indexOf("if (generation === null) return;");
  const complete = body.indexOf("if (!completeOperationalListRequest(");
  const stateCommit = body.indexOf(commit);
  expect(begin).toBeGreaterThanOrEqual(0);
  expect(rejected).toBeGreaterThan(begin);
  expect(complete).toBeGreaterThan(rejected);
  expect(stateCommit).toBeGreaterThan(complete);
}

describe("operational list race contracts", () => {
  const listCases = [
    {
      name: "Action Center",
      source: alertsPage,
      start: "async function refresh(doSync: boolean, reset = true)",
      commit: "setRows((previous)",
    },
    {
      name: "Assets",
      source: assetsPage,
      start: "async function loadInventory(reset: boolean)",
      commit: "setRows((previous)",
    },
    {
      name: "Consumables",
      source: consumablesPanel,
      start: "async function load(reset = true)",
      commit: "setRows((previous)",
    },
    {
      name: "Maintenance",
      source: maintenancePage,
      start: "async function reload(focusId?: string, reset = true)",
      commit: "setRows((previous)",
    },
    {
      name: "Purchase Requests",
      source: purchaseRequestsPage,
      start: "async function load(",
      commit: "setRows((previous)",
    },
    {
      name: "Requests",
      source: requestsPage,
      start: "async function loadPage(reset: boolean)",
      commit: "setRows((previous)",
    },
  ];

  for (const listCase of listCases) {
    it(`rejects overlapping ${listCase.name} continuations before committing rows`, () => {
      const load = functionBody(listCase.source, listCase.start, "useEffect(() => {");
      expectRequestGateBeforeCommit(load, listCase.commit);
      expect(listCase.source).not.toContain("reset ? ++loadGeneration.current");
      expect(listCase.source).not.toContain("disabled={loadingMore}");
    });
  }

  it("discards stale Action Center labels and counts", () => {
    const refresh = functionBody(
      alertsPage,
      "async function refresh(doSync: boolean, reset = true)",
      "useEffect(() => {",
    );
    expect(refresh).toContain("const [pageLabels, countsResult] = await Promise.all([");
    expect(refresh.lastIndexOf("if (!completeOperationalListRequest("))
      .toBeLessThan(refresh.indexOf("setLabels("));
    expect(refresh.lastIndexOf("if (!completeOperationalListRequest("))
      .toBeLessThan(refresh.indexOf("setServerCounts("));
    expect(alertsPage).not.toContain("if (loading) return;");
    expect(alertsPage).toContain("const doSync = initialSyncPending.current && write;");
    expect(alertsPage).not.toMatch(/useEffect\(\(\) => \{\s*refresh\(true\)/);
  });

  it("issues one initial Purchase Requests page load", () => {
    expect(purchaseRequestsPage).not.toContain("useEffect(() => { load(); }, [])");
    expect(purchaseRequestsPage.match(/void\s+load\(true,\s*true\);/g)).toHaveLength(1);
    expect(purchaseRequestsPage).toMatch(/async function load\(reset = true,\s*applyInitialOpenIntent = false\)/);
    expect(purchaseRequestsPage).toContain("if (applyInitialOpenIntent && initialOpenIntentPending.current && !error)");
    const load = functionBody(purchaseRequestsPage, "async function load(", "useEffect(() => {");
    const scopeGuard = "if (scopeRef.current !== scope) return;";
    const firstGuard = load.indexOf(scopeGuard);
    const sourceRead = load.indexOf("await listPurchaseRequestsPage(");
    const completedGuard = load.indexOf(scopeGuard, sourceRead);
    expect(firstGuard).toBeGreaterThanOrEqual(0);
    expect(load.indexOf("beginOperationalListRequest(")).toBeGreaterThan(firstGuard);
    expect(completedGuard).toBeGreaterThan(sourceRead);
    expect(load.indexOf("if (!completeOperationalListRequest(")).toBeGreaterThan(completedGuard);
    const cleanup = functionBody(purchaseRequestsPage, "useEffect(() => () => {", "}, []);");
    expect(cleanup.indexOf("cancelOperationalListRequest(listRequestGate.current);")).toBeGreaterThanOrEqual(0);
    expect(cleanup.indexOf("openIdRef.current = null;")).toBeGreaterThan(cleanup.indexOf("cancelOperationalListRequest("));
  });

  it("invalidates stale Purchase Request detail loads when selection changes", () => {
    const loadItems = functionBody(
      purchaseRequestsPage,
      "async function loadItems(id: string)",
      "async function load(",
    );
    const begin = loadItems.indexOf("++itemLoadGeneration.current");
    const selectionGuard = loadItems.indexOf("if (openIdRef.current !== id || scopeRef.current !== scope) return;");
    expect(selectionGuard).toBeGreaterThanOrEqual(0);
    expect(begin).toBeGreaterThan(selectionGuard);
    const current = functionBody(loadItems, "const current = () =>", "loadedItemsScopeRef.current = null;");
    expect(current).toContain("!controller.signal.aborted");
    expect(current).toContain("generation === itemLoadGeneration.current");
    expect(current).toContain("openIdRef.current === id");
    expect(current).toContain("scopeRef.current === scope");
    const sourceRead = loadItems.indexOf("await getPurchaseRequestItems(");
    const sourceGuard = loadItems.indexOf("if (!current()) return;", sourceRead);
    const recovery = loadItems.indexOf("await recoverCompletedOperations(");
    const recoveryGuard = loadItems.indexOf("if (!current()) return;", recovery);
    const stateCommit = loadItems.indexOf("setItems(result.error");
    expect(sourceRead).toBeGreaterThan(begin);
    expect(sourceGuard).toBeGreaterThan(sourceRead);
    expect(recovery).toBeGreaterThan(sourceGuard);
    expect(recoveryGuard).toBeGreaterThan(recovery);
    expect(loadItems.indexOf("setItemsError(result.error)")).toBeGreaterThan(recoveryGuard);
    expect(stateCommit).toBeGreaterThan(recoveryGuard);
    expect(purchaseRequestsPage).toContain("const { role, userId, approvalStatus, capabilities } = useSession();");
    expect(purchaseRequestsPage).toContain("[...capabilities].sort().join(");
    expect(purchaseRequestsPage).toContain("|${approvalStatus}|");

    const toggle = functionBody(
      purchaseRequestsPage,
      "async function toggleOpen(id: string)",
      "const filtered = useMemo",
    );
    expect(toggle).toContain("++itemLoadGeneration.current;");
    expect(toggle).toContain("itemLoadController.current?.abort();");
    expect(toggle.indexOf("openIdRef.current = id;")).toBeGreaterThanOrEqual(0);
    expect(toggle.indexOf("openIdRef.current = id;")).toBeLessThan(toggle.indexOf("await loadItems(id);"));
    expect(toggle).toContain("await loadItems(id);");
  });
});
