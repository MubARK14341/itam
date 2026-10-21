import { BULK_PAGE_SIZE } from "./pagination";

export type ReportPageSize = 500 | 1000;

export interface ReportRangePage<T extends { id: string }> {
  data: T[] | null;
  error: { message: string } | null;
  count?: number | null;
}

export interface ReportPageProjection<T extends { id: string }> {
  read(page: readonly T[], signal: AbortSignal): PromiseLike<{
    data: T[] | null; error: { message: string } | null;
  }>;
}

/** Same count, cardinality and identity validation for ordinary and projected reads. */
function validateReportPage<T extends { id: string }>(
  page: ReportRangePage<T>, from: number, count: number, seen: Set<string>, pageSize: ReportPageSize,
): string | null {
  if (page.error !== null) return page.error?.message || "report_range_read_failed";
  if (page.count !== undefined && page.count !== null && page.count !== count) return "report_range_count_changed";
  if (!Array.isArray(page.data) || page.data.length !== Math.min(pageSize, count - from)) return "report_range_incomplete";
  for (const row of page.data) {
    if (!row || typeof row.id !== "string" || !row.id) return "report_range_invalid_id";
    if (seen.has(row.id)) return "report_range_duplicate_id";
    seen.add(row.id);
  }
  return null;
}

/**
 * Complete report reads with stable server ordering and at most four pending pages.
 * Exact count is not a transaction snapshot: changed counts, short pages or duplicate
 * IDs reject the entire report so its caller can offer a fresh retry.
 * Callers opting into 1000 must verify their Data API row cap; short pages never
 * infer a smaller cap or fall back to a truncated success. All other reads default to 500.
 */
export async function collectReportRangePages<T extends { id: string }>(
  fetchPage: (from: number, to: number, countExact: boolean, readSignal?: AbortSignal) => PromiseLike<ReportRangePage<T>>,
  signal?: AbortSignal,
  concurrency: 1 | 2 | 3 | 4 = 4,
  projection?: ReportPageProjection<T>,
  pageSize: ReportPageSize = BULK_PAGE_SIZE,
): Promise<{ data: T[]; error: { message: string } | null }> {
  const fail = (message: string) => ({ data: [] as T[], error: { message } });
  if (![1, 2, 3, 4].includes(concurrency)) return fail("report_range_invalid_concurrency");
  if (pageSize !== 500 && pageSize !== 1000) return fail("report_range_invalid_page_size");
  if (projection) return collectProjectedReportRangePages(fetchPage, signal, concurrency, projection, pageSize);
  const read = async (from: number, to: number, countExact: boolean): Promise<ReportRangePage<T>> => {
    try { return await fetchPage(from, to, countExact); }
    catch { return { data: null, error: { message: "report_range_read_failed" } }; }
  };
  if (signal?.aborted) return fail("read_aborted");
  const first = await read(0, pageSize - 1, true);
  if (signal?.aborted) return fail("read_aborted");
  if (first.error !== null) return fail(first.error?.message || "report_range_read_failed");
  const count = first.count;
  if (typeof count !== "number" || !Number.isSafeInteger(count) || count < 0) return fail("report_range_invalid_count");

  const rows: T[] = [], seen = new Set<string>();
  const append = (page: ReportRangePage<T>, from: number, destination: T[] = rows): string | null => {
    const failure = validateReportPage(page, from, count, seen, pageSize);
    if (failure) return failure;
    destination.push(...(page.data ?? []));
    return null;
  };
  const firstFailure = append(first, 0);
  if (firstFailure) return fail(firstFailure);

  const pageCount = Math.max(0, Math.ceil(count / pageSize) - 1);
  const pages: T[][] = [];
  const state: { next: number; failure: string | null } = { next: 0, failure: null };
  const worker = async () => {
    while (!state.failure && !signal?.aborted && state.next < pageCount) {
      const index = state.next++, from = (index + 1) * pageSize;
      const page = await read(from, Math.min(from + pageSize - 1, count - 1), false);
      if (signal?.aborted || state.failure) return;
      const destination: T[] = [];
      const failure = append(page, from, destination);
      if (failure) { state.failure = failure; return; }
      // Refill the completed slot immediately; output still follows requested server offsets.
      pages[index] = destination;
    }
  };
  // On failure/cancellation, stop new reads and drain the already pending callbacks.
  await Promise.all(Array.from({ length: Math.min(concurrency, pageCount) }, worker));
  if (signal?.aborted) return fail("read_aborted");
  if (state.failure) return fail(state.failure);
  for (const page of pages) rows.push(...page);
  return { data: rows, error: null };
}

/** Opt-in mixed base/projection queue; each admitted task owns exactly one call. */
async function collectProjectedReportRangePages<T extends { id: string }>(
  fetchPage: (from: number, to: number, countExact: boolean, readSignal?: AbortSignal) => PromiseLike<ReportRangePage<T>>,
  callerSignal: AbortSignal | undefined,
  concurrency: 1 | 2 | 3 | 4,
  projection: ReportPageProjection<T>,
  pageSize: ReportPageSize,
): Promise<{ data: T[]; error: { message: string } | null }> {
  const controller = new AbortController();
  const state: { failure: string | null } = { failure: null };
  const fail = (message: string) => {
    if (!state.failure) state.failure = message || "report_range_projection_failed";
    controller.abort();
  };
  const cancelled = () => fail("read_aborted");
  callerSignal?.addEventListener("abort", cancelled, { once: true });
  if (callerSignal?.aborted) cancelled();
  try {
    if (state.failure) return { data: [], error: { message: state.failure } };
    let first: ReportRangePage<T>;
    try { first = await fetchPage(0, pageSize - 1, true, controller.signal); }
    catch { fail("report_range_read_failed"); return { data: [], error: { message: state.failure! } }; }
    if (state.failure) return { data: [], error: { message: state.failure } };
    if (first.error !== null) { fail(first.error?.message || "report_range_read_failed"); return { data: [], error: { message: state.failure! } }; }
    const count = first.count;
    if (typeof count !== "number" || !Number.isSafeInteger(count) || count < 0) {
      return { data: [], error: { message: "report_range_invalid_count" } };
    }
    const seen = new Set<string>();
    const initialFailure = validateReportPage(first, 0, count, seen, pageSize);
    if (initialFailure) return { data: [], error: { message: initialFailure } };
    if (count === 0) return { data: [], error: null };

    const base: T[][] = [first.data ?? []], merged: T[][] = [];
    const ready: number[] = [0];
    let readyIndex = 0, nextBase = 1, active = 0, preferProjection = true;
    const pageCount = Math.ceil(count / pageSize);
    await new Promise<void>(resolve => {
      const run = async (kind: "base" | "projection", index: number) => {
        try {
          if (state.failure || controller.signal.aborted) return;
          if (kind === "base") {
            const from = index * pageSize;
            const page = await fetchPage(from, Math.min(from + pageSize - 1, count - 1), false, controller.signal);
            if (state.failure) return;
            const failure = validateReportPage(page, from, count, seen, pageSize);
            if (failure) { fail(failure); return; }
            base[index] = page.data ?? [];
            ready.push(index);
          } else {
            const source = base[index], sourceIds = source.map(row => row.id);
            const page = await projection.read(source, controller.signal);
            if (state.failure) return;
            if (page.error !== null) { fail(page.error?.message || "report_range_projection_failed"); return; }
            if (!Array.isArray(page.data) || page.data.length !== sourceIds.length) { fail("report_range_projection_incomplete"); return; }
            const expected = new Set(sourceIds), byId = new Map<string, T>();
            for (const row of page.data) {
              if (!row || typeof row.id !== "string" || !expected.has(row.id) || byId.has(row.id)) {
                fail("report_range_projection_identity_changed"); return;
              }
              byId.set(row.id, row);
            }
            const ordered: T[] = [];
            for (const id of sourceIds) {
              const projected = byId.get(id);
              if (!projected) { fail("report_range_projection_incomplete"); return; }
              ordered.push(projected);
            }
            merged[index] = ordered;
          }
        } catch { fail(kind === "base" ? "report_range_read_failed" : "report_range_projection_failed"); }
      };
      const pump = () => {
        while (!state.failure && active < concurrency && (nextBase < pageCount || readyIndex < ready.length)) {
          // Alternate when both branches have work; no base slot waits for a projection slot.
          const project = readyIndex < ready.length && (preferProjection || nextBase >= pageCount);
          const kind = project ? "projection" : "base";
          const index = project ? ready[readyIndex++] : nextBase++;
          preferProjection = !project;
          active++;
          void run(kind, index).finally(() => { active--; pump(); });
        }
        // Failure closes admission, but already-started callbacks must settle before return.
        if (active === 0 && (state.failure || nextBase === pageCount && readyIndex === ready.length)) resolve();
      };
      pump();
    });
    if (state.failure) return { data: [], error: { message: state.failure } };
    const rows: T[] = [], projectedIds = new Set<string>();
    for (let index = 0; index < pageCount; index++) {
      if (!merged[index] || merged[index].length !== base[index].length) return { data: [], error: { message: "report_range_projection_incomplete" } };
      for (const row of merged[index]) {
        if (!seen.has(row.id) || projectedIds.has(row.id)) return { data: [], error: { message: "report_range_projection_identity_changed" } };
        projectedIds.add(row.id); rows.push(row);
      }
    }
    if (rows.length !== count || projectedIds.size !== seen.size) return { data: [], error: { message: "report_range_projection_incomplete" } };
    return { data: rows, error: null };
  } finally { callerSignal?.removeEventListener("abort", cancelled); }
}
