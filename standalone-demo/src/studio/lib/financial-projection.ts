export type ProjectionResult<T> = { data: T[] | null; error: { message: string } | null };

/** One row per ID: bounded batches avoid the Data API's result-row ceiling. */
export async function readFinancialBatches<T>(
  ids: string[],
  read: (ids: string[]) => PromiseLike<ProjectionResult<T>>,
  signal?: AbortSignal,
): Promise<ProjectionResult<T>> {
  const unique = [...new Set(ids)].sort();
  // These RPCs return one row per entity ID. Stay below the 1000-row API cap
  // while keeping each payload bounded for complete financial reports.
  const batchSize = 500;
  const count = Math.ceil(unique.length / batchSize);
  const batches: T[][] = [];
  type Failure = { kind: "result"; error: { message: string } } | { kind: "thrown"; error: unknown };
  const state: { next: number; failure: Failure | null } = { next: 0, failure: null };
  const worker = async () => {
    while (!state.failure && !signal?.aborted && state.next < count) {
      const index = state.next++;
      let result: ProjectionResult<T>;
      try { result = await read(unique.slice(index * batchSize, (index + 1) * batchSize)); }
      catch (error) { if (!state.failure) state.failure = { kind: "thrown", error }; return; }
      if (state.failure || signal?.aborted) return;
      if (result.error) { state.failure = { kind: "result", error: result.error }; return; }
      // A completed slot can start the next batch before another slow batch finishes.
      batches[index] = result.data ?? [];
    }
  };
  if (signal?.aborted) return { data: null, error: { message: "read_aborted" } };
  await Promise.all(Array.from({ length: Math.min(4, count) }, worker));
  if (signal?.aborted) return { data: null, error: { message: "read_aborted" } };
  if (state.failure?.kind === "thrown") throw state.failure.error;
  if (state.failure?.kind === "result") return { data: null, error: state.failure.error };
  return { data: batches.flat(), error: null };
}
