import { describe, it, expect } from "bun:test";
import { classifySqliteError } from "../../src/db/databaseFailureClassification";

/**
 * Issue #2874: `classifySqliteError` must prefer the structured
 * `err.cause.code` (the #2793 identity contract) and fall back to message
 * matching only when no code is present.
 */
describe("classifySqliteError", () => {
  const wrap = (code: string): Error =>
    new Error("Query failed: ...", { cause: Object.assign(new Error("x"), { code }) });

  it("maps SQLITE_BUSY / SQLITE_LOCKED (and extended codes) to retryable", () => {
    expect(classifySqliteError(wrap("SQLITE_BUSY"))).toBe("retryable");
    expect(classifySqliteError(wrap("SQLITE_BUSY_SNAPSHOT"))).toBe("retryable");
    expect(classifySqliteError(wrap("SQLITE_LOCKED"))).toBe("retryable");
    expect(classifySqliteError(wrap("SQLITE_LOCKED_SHAREDCACHE"))).toBe("retryable");
  });

  it("maps SQLITE_CONSTRAINT* to constraint (never retryable)", () => {
    expect(classifySqliteError(wrap("SQLITE_CONSTRAINT"))).toBe("constraint");
    expect(classifySqliteError(wrap("SQLITE_CONSTRAINT_UNIQUE"))).toBe("constraint");
    expect(classifySqliteError(wrap("SQLITE_CONSTRAINT_FOREIGNKEY"))).toBe("constraint");
  });

  it("maps unknown / corruption / misuse codes to fatal", () => {
    expect(classifySqliteError(wrap("SQLITE_CORRUPT"))).toBe("fatal");
    expect(classifySqliteError(wrap("SQLITE_MISUSE"))).toBe("fatal");
    expect(classifySqliteError(wrap("SQLITE_ERROR"))).toBe("fatal");
  });

  it("reads a bare SqliteError's own code (not only via cause)", () => {
    expect(classifySqliteError(Object.assign(new Error("x"), { code: "SQLITE_BUSY" }))).toBe(
      "retryable"
    );
  });

  it("falls back to message matching only when no structured code is present", () => {
    expect(classifySqliteError(new Error("database is locked"))).toBe("retryable");
    expect(classifySqliteError(new Error("UNIQUE constraint failed"))).toBe("fatal");
    expect(classifySqliteError("some string")).toBe("fatal");
    expect(classifySqliteError(undefined)).toBe("fatal");
  });

  it("prefers the structured code over a misleading message", () => {
    // message screams 'locked' but code is a constraint -> constraint wins.
    const err = new Error("database is locked", {
      cause: Object.assign(new Error("x"), { code: "SQLITE_CONSTRAINT_UNIQUE" }),
    });
    expect(classifySqliteError(err)).toBe("constraint");
  });
});
