export const DEFAULT_PAGE_SIZE = 100;
export const MAX_PAGE_SIZE = 250;
export const BULK_PAGE_SIZE = 500;

export interface DescTimeCursor {
  at: string;
  id: string;
}

export interface AscTextCursor {
  value: string;
  id: string;
}

export interface CursorPage<T, C> {
  rows: T[];
  nextCursor: C | null;
  total: number | null;
  error: string | null;
}

export function boundedPageSize(value?: number): number {
  if (!Number.isFinite(value)) return DEFAULT_PAGE_SIZE;
  return Math.max(1, Math.min(Math.trunc(value!), MAX_PAGE_SIZE));
}

export function takeCursorPage<T, C>(
  rows: T[],
  pageSize: number,
  cursorOf: (row: T) => C,
): { rows: T[]; nextCursor: C | null } {
  const hasMore = rows.length > pageSize;
  const pageRows = hasMore ? rows.slice(0, pageSize) : rows;
  return {
    rows: pageRows,
    nextCursor: hasMore && pageRows.length
      ? cursorOf(pageRows[pageRows.length - 1])
      : null,
  };
}

export function escapePostgrestValue(value: string): string {
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

/**
 * Build a quoted PostgREST `ilike` contains operand from user-entered text.
 * Quoting keeps commas, parentheses, and quotes inside the value instead of
 * letting them change the `.or(...)` filter grammar. `%` and `_` remain literal
 * user characters; only the outer `%` pair acts as the contains wildcard.
 */
export function postgrestIlikeContains(value: string): string {
  const literal = value
    .trim()
    .replaceAll("\\", "\\\\")
    .replaceAll("%", "\\%")
    .replaceAll("_", "\\_");
  return escapePostgrestValue(`%${literal}%`);
}

export async function collectRangePages<T>(
  fetchPage: (from: number, to: number) => PromiseLike<{
    data: T[] | null;
    error: { message: string } | null;
  }>,
  pageSize = BULK_PAGE_SIZE,
): Promise<{ data: T[]; error: { message: string } | null }> {
  const rows: T[] = [];
  for (let from = 0; ; from += pageSize) {
    const result = await fetchPage(from, from + pageSize - 1);
    if (result.error) return { data: [], error: result.error };
    const page = result.data ?? [];
    rows.push(...page);
    if (page.length < pageSize) return { data: rows, error: null };
  }
}

/** SDK error JSON is unvalidated; failed cursor reads always expose a nonempty string. */
export function cursorReadErrorMessage(message: unknown, fallback = "cursor_read_failed"): string {
  return typeof message === "string" && message.trim().length > 0 ? message : fallback;
}

/** Read a complete filtered export, discarding every row if a later page fails. */
export async function collectCursorPages<T, C>(
  fetchPage: (cursor: C | null) => Promise<CursorPage<T, C>>,
): Promise<{ rows: T[]; error: string | null }> {
  const rows: T[] = [];
  let cursor: C | null = null;
  do {
    const page = await fetchPage(cursor);
    if (page.error !== null) return { rows: [], error: cursorReadErrorMessage(page.error) };
    rows.push(...page.rows);
    cursor = page.nextCursor;
  } while (cursor !== null);
  return { rows, error: null };
}
