import { describe, expect, it } from "vitest";
import { bucketizeRequests, warehouseBucketKeyForStatus } from "./warehouse-buckets";
import type { RequestListRow } from "./requests";

const row = (id: string, status: string, returnDate: string | null = null, createdAt = "2026-08-01T00:00:00Z") => ({
  id, status, return_date: returnDate, created_at: createdAt,
}) as unknown as RequestListRow;

describe("warehouse buckets parity", () => {
  it("keeps overdue requests in their original bucket, first, and only once", () => {
    const { buckets, overdue } = bucketizeRequests([
      row("fresh", "delivered", "2099-01-01"),
      row("late", "delivered", "2020-01-01"),
      row("done", "completed", "2020-01-01"),
    ]);
    const awaiting = buckets.find((b) => b.key === "awaitingReturn")!;
    expect(awaiting.rows.map((r) => r.id)).toEqual(["late", "fresh"]);
    expect(overdue.map((r) => r.id)).toEqual(["late"]);
    expect(buckets.flatMap((b) => b.rows).filter((r) => r.id === "late")).toHaveLength(1);
    expect(buckets.flatMap((b) => b.rows).some((r) => r.id === "done")).toBe(false);
  });

  it("maps the explicit legacy overdue state to awaiting return", () => {
    expect(warehouseBucketKeyForStatus("overdue")).toBe("awaitingReturn");
  });

  it("dashboard task count equals the rows visible across warehouse buckets", () => {
    const result = bucketizeRequests([
      row("a", "approved"), row("b", "preparing"), row("c", "ready_for_pickup"),
      row("d", "delivered", "2020-01-01"), row("e", "returned"), row("f", "completed"),
    ]);
    expect(result.buckets.reduce((sum, bucket) => sum + bucket.rows.length, 0)).toBe(5);
  });

  it("puts the oldest actionable work first and the earliest returns first", () => {
    const result = bucketizeRequests([
      row("new-prep", "approved", null, "2026-08-10T00:00:00Z"),
      row("old-prep", "approved", null, "2026-08-01T00:00:00Z"),
      row("later-return", "delivered", "2099-09-10", "2026-08-01T00:00:00Z"),
      row("sooner-return", "delivered", "2099-09-01", "2026-08-10T00:00:00Z"),
    ]);
    expect(result.buckets.find((bucket) => bucket.key === "needsPrep")!.rows.map((item) => item.id)).toEqual(["old-prep", "new-prep"]);
    expect(result.buckets.find((bucket) => bucket.key === "awaitingReturn")!.rows.map((item) => item.id)).toEqual(["sooner-return", "later-return"]);
  });
});
