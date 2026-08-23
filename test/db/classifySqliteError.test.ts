import { describe, expect, test } from "bun:test";
import {
  classifySqliteError,
  type SqliteErrorAction,
} from "../../src/db/databaseFailureClassification";

/**
 * Issue #2874: `classifySqliteError` must prefer the structured
 * `err.cause.code` (the #2793 identity contract) and fall back to message
 * matching only when no code is present. The table below is the specification;
 * the final four rows are the boundaries that pin the exact predicate
 * (`startsWith` not `includes`, one-level `.cause` walk, non-string and
 * empty-string codes).
 */
describe("classifySqliteError", () => {
  // A code carried by identity on `.cause` — the dialect's wrapping shape.
  const wrapCause = (code: string): Error =>
    new Error("Query failed: ...", { cause: Object.assign(new Error("inner"), { code }) });
  // A bare SqliteError carrying its own `.code`.
  const bare = (code: string): Error => Object.assign(new Error("bare"), { code });

  test.each<[string, unknown, SqliteErrorAction]>([
    // Retryable: BUSY/LOCKED primary + extended codes (prefix match).
    ["SQLITE_BUSY", wrapCause("SQLITE_BUSY"), "retryable"],
    ["SQLITE_BUSY_SNAPSHOT", wrapCause("SQLITE_BUSY_SNAPSHOT"), "retryable"],
    ["SQLITE_LOCKED", wrapCause("SQLITE_LOCKED"), "retryable"],
    ["SQLITE_LOCKED_SHAREDCACHE", wrapCause("SQLITE_LOCKED_SHAREDCACHE"), "retryable"],

    // Constraint: never retryable.
    ["SQLITE_CONSTRAINT", wrapCause("SQLITE_CONSTRAINT"), "constraint"],
    ["SQLITE_CONSTRAINT_UNIQUE", wrapCause("SQLITE_CONSTRAINT_UNIQUE"), "constraint"],
    ["SQLITE_CONSTRAINT_FOREIGNKEY", wrapCause("SQLITE_CONSTRAINT_FOREIGNKEY"), "constraint"],

    // Fatal: corruption / misuse / generic error codes.
    ["SQLITE_CORRUPT", wrapCause("SQLITE_CORRUPT"), "fatal"],
    ["SQLITE_MISUSE", wrapCause("SQLITE_MISUSE"), "fatal"],
    ["SQLITE_ERROR", wrapCause("SQLITE_ERROR"), "fatal"],

    // Bare error's own code is read (not only via cause).
    ["bare SQLITE_BUSY", bare("SQLITE_BUSY"), "retryable"],
    ["bare SQLITE_CONSTRAINT_UNIQUE", bare("SQLITE_CONSTRAINT_UNIQUE"), "constraint"],

    // No structured code: message-pattern fallback.
    ["message: database is locked", new Error("database is locked"), "retryable"],
    ["message: UNIQUE constraint failed", new Error("UNIQUE constraint failed"), "fatal"],
    ["non-error string", "some string", "fatal"],
    ["undefined", undefined, "fatal"],
    ["null", null, "fatal"],

    // Structured code wins over a misleading message.
    [
      "locked message but CONSTRAINT code",
      new Error("database is locked", {
        cause: Object.assign(new Error("inner"), { code: "SQLITE_CONSTRAINT_UNIQUE" }),
      }),
      "constraint",
    ],

    // Boundary: prefix match, not substring — a code that merely contains the
    // token must not be treated as retryable.
    ["NOT_SQLITE_BUSY (prefix, not substring)", wrapCause("NOT_SQLITE_BUSY"), "fatal"],
    // Boundary: a non-string code is ignored; falls back to the neutral message.
    ["numeric code ignored", Object.assign(new Error("Query failed"), { code: 42 }), "fatal"],
    // Boundary: only ONE level of `.cause` is walked; a code nested two deep is
    // not found and the neutral message decides (fatal).
    [
      "double-cause (code two levels deep, not found)",
      new Error("outer", {
        cause: new Error("mid", {
          cause: Object.assign(new Error("deep"), { code: "SQLITE_BUSY" }),
        }),
      }),
      "fatal",
    ],
    // Boundary: an empty-string code is a present (string) code, so it takes the
    // code branch and matches no prefix -> fatal (no message fallback).
    ["empty-string code", wrapCause(""), "fatal"],
  ])("classifies %s", (_label, input, expected) => {
    expect(classifySqliteError(input)).toBe(expected);
  });
});
