import type { RequestTrendDay } from "@/lib/dashboard/dashboard-types";

/** Presentation only: both series use the same scale, including after a series is hidden. */
export function requestSeriesPoints(rows: RequestTrendDay[], key: "created" | "completed") {
  const max = Math.max(1, ...rows.flatMap((row) => [row.created, row.completed]));
  return rows.map((row, index) => {
    const x = rows.length === 1 ? 300 : 8 + (index / (rows.length - 1)) * 584;
    const y = 160 - (row[key] / max) * 148;
    return `${Number(x.toFixed(2))},${Number(y.toFixed(2))}`;
  }).join(" ");
}
