export type NumericParseResult =
  | { ok: true; value: number | null }
  | { ok: false; reason: "required" | "format" | "range" };

type NumericOptions = {
  required?: boolean;
  emptyValue?: number | null;
  min?: number;
  max?: number;
};

const PG_INTEGER_MAX = 2_147_483_647;
const DEFAULT_MONEY_MAX = 1_000_000_000_000;

function emptyResult(value: string, options: NumericOptions): NumericParseResult | null {
  if (value.trim() !== "") return null;
  if (options.required) return { ok: false, reason: "required" };
  return { ok: true, value: options.emptyValue ?? null };
}

export function parseStrictInteger(value: string, options: NumericOptions = {}): NumericParseResult {
  const empty = emptyResult(value, options);
  if (empty) return empty;
  const normalized = value.trim();
  if (!/^(0|[1-9]\d*)$/.test(normalized)) return { ok: false, reason: "format" };
  const parsed = Number(normalized);
  const min = options.min ?? 0;
  const max = options.max ?? PG_INTEGER_MAX;
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    return { ok: false, reason: "range" };
  }
  return { ok: true, value: parsed };
}

export function parseStrictDecimal(value: string, options: NumericOptions = {}): NumericParseResult {
  const empty = emptyResult(value, options);
  if (empty) return empty;
  const normalized = value.trim();
  if (!/^(?:\d+(?:\.\d*)?|\.\d+)$/.test(normalized)) return { ok: false, reason: "format" };
  const parsed = Number(normalized);
  const min = options.min ?? 0;
  const max = options.max ?? DEFAULT_MONEY_MAX;
  if (!Number.isFinite(parsed) || parsed < min || parsed > max) {
    return { ok: false, reason: "range" };
  }
  return { ok: true, value: parsed };
}
