import { describe, expect, test } from "bun:test";
import {
  INCOMPLETE_EXTRACTION_CODE,
  INCOMPLETE_EXTRACTION_EXIT_CODE,
  MIGRATION_RUNTIME_DEPENDENCIES,
  createIncompleteExtractionError,
  extractMissingPackageName,
  isIncompleteExtractionError,
  isMissingMigrationDependencyError,
  isMissingPackageError,
} from "../../src/db/migrationDependencyIntegrity";

/**
 * Covers issue #2833: a half-linked `bunx` extraction whose `node_modules` is
 * missing a migration runtime dependency (e.g. `kysely`) must surface as a
 * distinct, recoverable failure — not a generic fatal migration crash — while a
 * genuine bad import (a typo, an unpublished dep) must NOT be mislabeled.
 */
describe("isMissingPackageError", () => {
  test("recognizes bun's ResolveMessage 'Cannot find package' shape", () => {
    const error = new Error(
      "Cannot find package 'kysely' from " +
        "'/tmp/bunx-501-@kaeawc/auto-mobile@1.2.3/node_modules/@kaeawc/auto-mobile/dist/src/db/migrations/2026_01_01_000.ts'",
    );
    expect(isMissingPackageError(error)).toBe(true);
  });

  test("recognizes node's MODULE_NOT_FOUND / 'Cannot find module'", () => {
    const codeError = Object.assign(new Error("boom"), { code: "MODULE_NOT_FOUND" });
    expect(isMissingPackageError(codeError)).toBe(true);
    expect(isMissingPackageError(new Error("Cannot find module 'kysely'"))).toBe(true);
  });

  test("recognizes bun's ERR_MODULE_NOT_FOUND code", () => {
    const codeError = Object.assign(new Error("boom"), { code: "ERR_MODULE_NOT_FOUND" });
    expect(isMissingPackageError(codeError)).toBe(true);
  });

  test("rejects unrelated failures (busy sqlite file, deterministic migration throw)", () => {
    expect(isMissingPackageError(new Error("SQLITE_BUSY: database is locked"))).toBe(false);
    expect(isMissingPackageError(new Error("migration 0007 failed: column already exists"))).toBe(
      false,
    );
    expect(isMissingPackageError(undefined)).toBe(false);
    expect(isMissingPackageError("a plain string")).toBe(false);
  });
});

describe("extractMissingPackageName", () => {
  test("pulls the package name from bun's 'Cannot find package' message", () => {
    const error = new Error("Cannot find package 'kysely' from '/tmp/x/migrations/m.ts'");
    expect(extractMissingPackageName(error)).toBe("kysely");
  });

  test("pulls the module name from node's 'Cannot find module' message", () => {
    expect(extractMissingPackageName(new Error("Cannot find module 'kysely'"))).toBe("kysely");
  });

  test("handles scoped package names", () => {
    const error = new Error("Cannot find package '@scope/pkg' from '/tmp/x/m.ts'");
    expect(extractMissingPackageName(error)).toBe("@scope/pkg");
  });

  test("returns null when the message names no package", () => {
    expect(extractMissingPackageName(new Error("something else failed"))).toBeNull();
    expect(extractMissingPackageName(undefined)).toBeNull();
  });
});

describe("bun ResolveMessage shape (not instanceof Error)", () => {
  // bun throws a `ResolveMessage` for a failed dynamic import: a string
  // `.message` but NOT `instanceof Error`. The detection must read `.message`
  // off any object, or the exact kysely case this fix targets is missed.
  const resolveMessage = {
    code: "ERR_MODULE_NOT_FOUND",
    message: "Cannot find package 'kysely' from 'C:\\bunx\\...\\migrations\\m.ts'",
  };

  test("is detected, its package name extracted, and matched as a known dep", () => {
    expect(resolveMessage instanceof Error).toBe(false);
    expect(isMissingPackageError(resolveMessage)).toBe(true);
    expect(extractMissingPackageName(resolveMessage)).toBe("kysely");
    expect(isMissingMigrationDependencyError(resolveMessage)).toBe(true);
  });
});

describe("isMissingMigrationDependencyError", () => {
  test("is true only when a KNOWN migration runtime dependency is missing", () => {
    expect(
      isMissingMigrationDependencyError(
        new Error("Cannot find package 'kysely' from '/tmp/x/m.ts'"),
      ),
    ).toBe(true);
    expect(MIGRATION_RUNTIME_DEPENDENCIES).toContain("kysely");
  });

  test("is false for a genuine bad import — a typo'd or unpublished package", () => {
    // A code-level bug in a migration must fall through to the generic error, not
    // be mislabeled as an incomplete extraction whose fix is "re-extract".
    expect(
      isMissingMigrationDependencyError(
        new Error("Cannot find package 'kysley' from '/tmp/x/m.ts'"),
      ),
    ).toBe(false);
    expect(
      isMissingMigrationDependencyError(new Error("Cannot find package 'some-unpublished-dep'")),
    ).toBe(false);
  });

  test("is false for non-missing-package failures", () => {
    expect(isMissingMigrationDependencyError(new Error("database is locked"))).toBe(false);
    expect(isMissingMigrationDependencyError(undefined)).toBe(false);
  });
});

describe("createIncompleteExtractionError", () => {
  test("builds a recoverable error with distinct code, remediation, and preserved cause", () => {
    const cause = new Error("Cannot find package 'kysely' from '/tmp/x/m.ts'");
    const error = createIncompleteExtractionError("kysely", cause);

    expect(error).toBeInstanceOf(Error);
    expect((error as { code?: string }).code).toBe(INCOMPLETE_EXTRACTION_CODE);
    expect(error.message).toContain("kysely");
    // Names the mechanism and the fix so the caller knows it is recoverable.
    expect(error.message).toMatch(/incomplete/i);
    expect(error.message).toMatch(/extraction/i);
    expect(error.message).toMatch(/re-?run/i);
    // Hedges for the non-bunx install path rather than asserting the cause.
    expect(error.message).toMatch(/bunx/i);
    expect((error as { cause?: unknown }).cause).toBe(cause);
    expect(isIncompleteExtractionError(error)).toBe(true);
  });

  test("falls back to a generic dependency phrase when the package name is unknown", () => {
    const error = createIncompleteExtractionError(null);
    expect(error.message).toMatch(/dependenc/i);
    expect(isIncompleteExtractionError(error)).toBe(true);
    // No cause supplied → no cause attached.
    expect((error as { cause?: unknown }).cause).toBeUndefined();
  });
});

describe("isIncompleteExtractionError", () => {
  test("is false for ordinary errors", () => {
    expect(isIncompleteExtractionError(new Error("nope"))).toBe(false);
    expect(isIncompleteExtractionError(undefined)).toBe(false);
  });
});

describe("INCOMPLETE_EXTRACTION_EXIT_CODE", () => {
  test("is EX_TEMPFAIL (75) — a retryable-failure exit code distinct from 1", () => {
    expect(INCOMPLETE_EXTRACTION_EXIT_CODE).toBe(75);
  });
});
