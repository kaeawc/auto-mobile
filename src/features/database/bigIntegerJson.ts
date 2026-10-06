/**
 * Lossless handling of SQLite integers in ContentProvider JSON replies.
 *
 * The Android SDK writes every SQLite INTEGER column as a bare JSON number, but `JSON.parse`
 * turns numbers into IEEE-754 doubles, so a value beyond ±(2^53 - 1) (64-bit primary keys,
 * snowflake ids, nanosecond timestamps) is silently rounded (issue #10063). The reviver's
 * `context.source` hands back the original literal text, which lets the host keep the exact
 * digits without a hand-written parser and without an SDK re-cut.
 *
 * Values inside the safe range stay JSON numbers exactly as before. Values outside it become
 * decimal strings, and the column indices that carry such strings are reported in
 * {@link BIG_INTEGER_COLUMNS_KEY} so a caller can tell a stringified integer from TEXT.
 */

/** Result field listing zero-based columns whose integer cells were returned as decimal strings. */
export const BIG_INTEGER_COLUMNS_KEY = "bigIntegerColumns";

const INTEGER_LITERAL = /^-?\d+$/;

/** Placeholder carried through `JSON.parse` for an integer literal that doubles cannot hold. */
class UnsafeInteger {
  constructor(readonly digits: string) {}
}

/** The reviver's third argument (JSON.parse source text access) is not in every TS lib. */
interface ReviverContext {
  source?: string;
}

function isUnsafeIntegerLiteral(value: unknown, context?: ReviverContext): boolean {
  return (
    typeof value === "number" &&
    !Number.isSafeInteger(value) &&
    context?.source !== undefined &&
    INTEGER_LITERAL.test(context.source)
  );
}

/** Replace placeholders outside row cells with the plain number `JSON.parse` would have produced. */
function restoreNumbers(value: unknown): unknown {
  if (value instanceof UnsafeInteger) {
    return Number(value.digits);
  }
  if (Array.isArray(value)) {
    return value.map(restoreNumbers);
  }
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, restoreNumbers(item)]),
    );
  }
  return value;
}

/** Stringify placeholder cells in place and return the ascending columns that held one. */
function stringifyRowCells(rows: unknown[]): number[] {
  const columns = new Set<number>();
  for (const row of rows) {
    if (!Array.isArray(row)) {
      continue;
    }
    row.forEach((cell, index) => {
      if (cell instanceof UnsafeInteger) {
        row[index] = cell.digits;
        columns.add(index);
      }
    });
  }
  return [...columns].sort((a, b) => a - b);
}

/**
 * Parse a ContentProvider JSON reply without rounding 64-bit integers. When a `rows` matrix
 * holds an integer outside the safe range, that cell is returned as its exact decimal string
 * and the result gains `bigIntegerColumns`. Any other field parses exactly as `JSON.parse`.
 */
export function parseJsonKeepingBigIntegers<T>(json: string): T {
  let placeholders = 0;
  const parsed: unknown = JSON.parse(json, (_key, value: unknown, context?: ReviverContext) => {
    if (isUnsafeIntegerLiteral(value, context)) {
      placeholders += 1;
      return new UnsafeInteger(context?.source ?? "");
    }
    return value;
  });
  if (placeholders === 0) {
    return parsed as T;
  }

  const result = parsed as { rows?: unknown };
  const rows = typeof parsed === "object" && parsed !== null ? result.rows : undefined;
  const bigColumns = Array.isArray(rows) ? stringifyRowCells(rows) : [];
  // Placeholders outside row cells (never expected) keep the plain number JSON.parse produced.
  const restored = restoreNumbers(parsed) as Record<string, unknown>;
  if (bigColumns.length > 0) {
    restored[BIG_INTEGER_COLUMNS_KEY] = bigColumns;
  }
  return restored as T;
}
