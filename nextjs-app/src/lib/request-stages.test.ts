import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { REQUEST_STAGE_STATUSES, isRequestStageKey } from "./request-stages";
import { buildRequestQueuePath, requestQueueStateFromSearch } from "./request-navigation";

// The stage strip shows request_operational_counts; clicking a cell must list exactly the same statuses.
const sql = readFileSync(
  resolve(__dirname, "../../migrations/20260809170000_production_reconciliation_non_email.sql"),
  "utf8",
);
const fn = sql.slice(sql.lastIndexOf("create or replace function public.request_operational_counts()"));
const body = fn.slice(0, fn.indexOf("$function$;"));

function serverStatuses(counter: string): string[] {
  const match = body.match(new RegExp(`'${counter}', count\\(\\*\\) filter \\(\\s*where status (?:in \\(([^)]*)\\)|= '([a-z_]+)')`));
  expect(match, counter).not.toBeNull();
  const list = match![1] ?? `'${match![2]}'`;
  return list.split(",").map((s) => s.trim().replace(/'/g, "")).sort();
}

describe("request stage strip", () => {
  it("uses the same status groups as the server counters", () => {
    expect([...REQUEST_STAGE_STATUSES.review].sort()).toEqual(serverStatuses("review"));
    expect([...REQUEST_STAGE_STATUSES.fulfillment].sort()).toEqual(serverStatuses("awaiting"));
    expect([...REQUEST_STAGE_STATUSES.out].sort()).toEqual(serverStatuses("out"));
    expect([...REQUEST_STAGE_STATUSES.completed].sort()).toEqual(serverStatuses("completed"));
  });

  it("round-trips the stage through the queue URL and rejects unknown values", () => {
    expect(isRequestStageKey("out")).toBe(true);
    expect(isRequestStageKey("overdue")).toBe(false);
    const path = buildRequestQueuePath({ stage: "fulfillment" });
    expect(path).toBe("/requests?stage=fulfillment");
    expect(requestQueueStateFromSearch("?stage=fulfillment").stage).toBe("fulfillment");
    expect(requestQueueStateFromSearch("?stage=drop_table").stage).toBe("");
  });
});
