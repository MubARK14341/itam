export const FINANCIAL_COVERAGE_THRESHOLD_PCT = 100;

export type FinancialValueState = "available" | "missing" | "forbidden";
export type FinancialMetricReason =
  | "complete"
  | "forbidden"
  | "no_records"
  | "below_threshold"
  | "mixed_currency";

export interface FinancialMetric {
  state: FinancialValueState;
  value: number | null;
  coveragePct: number;
  asOf: string;
  currency: string | null;
  usedRecords: number;
  excludedRecords: number;
  totalRecords: number;
  thresholdPct: number;
  reason: FinancialMetricReason;
}

interface FinancialMetricOptions<T> {
  authorized: boolean;
  rows: readonly T[];
  valueOf: (row: T) => number | null | undefined;
  currencyOf?: (row: T) => string | null | undefined;
  asOf?: Date;
  thresholdPct?: number;
}

/**
 * Produces an honest financial aggregate.
 *
 * Missing values are excluded from the calculation but the partial sum is never
 * returned unless coverage reaches the documented threshold. Numeric zero is a
 * complete value. A forbidden caller never receives a value or currency.
 */
export function summarizeFinancialMetric<T>({
  authorized,
  rows,
  valueOf,
  currencyOf = () => "SAR",
  asOf = new Date(),
  thresholdPct = FINANCIAL_COVERAGE_THRESHOLD_PCT,
}: FinancialMetricOptions<T>): FinancialMetric {
  const totalRecords = rows.length;
  const base = {
    asOf: asOf.toISOString(),
    totalRecords,
    thresholdPct,
  };

  if (!authorized) {
    return {
      ...base,
      state: "forbidden",
      value: null,
      coveragePct: 0,
      currency: null,
      usedRecords: 0,
      excludedRecords: totalRecords,
      reason: "forbidden",
    };
  }

  let sum = 0;
  let usedRecords = 0;
  const currencies = new Set<string>();
  for (const row of rows) {
    const value = valueOf(row);
    if (value == null || !Number.isFinite(Number(value))) continue;
    usedRecords++;
    sum += Number(value);
    const currency = currencyOf(row)?.trim().toUpperCase();
    if (currency) currencies.add(currency);
  }

  const excludedRecords = totalRecords - usedRecords;
  const coveragePct = totalRecords === 0
    ? 0
    : Math.round((usedRecords / totalRecords) * 10_000) / 100;
  const currency = currencies.size === 1 ? [...currencies][0] : null;
  const mixedCurrency = currencies.size > 1;
  const complete = totalRecords > 0
    && coveragePct >= thresholdPct
    && !mixedCurrency
    && currency != null;

  return {
    ...base,
    state: complete ? "available" : "missing",
    value: complete ? sum : null,
    coveragePct,
    currency,
    usedRecords,
    excludedRecords,
    reason: complete
      ? "complete"
      : totalRecords === 0
        ? "no_records"
        : mixedCurrency
          ? "mixed_currency"
          : "below_threshold",
  };
}

export function formatFinancialMetricValue(
  metric: FinancialMetric,
  formatter: (value: number, currency: string) => string,
  missingLabel: string,
  forbiddenLabel: string,
): string {
  if (metric.state === "forbidden") return forbiddenLabel;
  if (metric.state !== "available" || metric.value == null || !metric.currency) {
    return missingLabel;
  }
  return formatter(metric.value, metric.currency);
}
