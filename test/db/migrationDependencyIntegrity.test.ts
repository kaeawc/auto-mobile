import { describe, expect, test } from "bun:test";
import {
  INCOMPLETE_EXTRACTION_CODE,
  MIGRATION_RUNTIME_DEPENDENCIES,
  assertMigrationDependenciesResolvable,
  createIncompleteExtractionError,
  extractMissingPackageName,
  findMissingMigrationDependency,
  isIncompleteExtractionError,
  isMissingPackageError,
} from "../../src/db/migrationDependencyIntegrity";

/**
 * Covers issue #2833: a half-linked `bunx` extraction whose `node_modules` is
 * missing a migration runtime dependency (e.g. `kysely`) must surface as a
 * distinct, recoverable failure — not a generic fatal migration crash.
 */
describe("isMissingPackageError", () => {
  test("recognizes bun's ResolveMessage 'Cannot find package' shape", () => {
    const error = new Error(
      "Cannot find package 'kysely' from " +
        "'/tmp/bunx-501-@kaeawc/auto-mobile@1.2.3/node_modules/@kaeawc/auto-mobile/dist/src/db/migrations/2026_01_01_000.ts'"
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
    expect(isMissingPackageError(new Error("migration 0007 failed: column already exists"))).toBe(false);
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
    expect((error as { cause?: unknown }).cause).toBe(cause);
    expect(isIncompleteExtractionError(error)).toBe(true);
  });

  test("falls back to a generic dependency phrase when the package name is unknown", () => {
    const error = createIncompleteExtractionError(null);
    expect(error.message).toMatch(/dependenc/i);
    expect(isIncompleteExtractionError(error)).toBe(true);
  });
});

describe("isIncompleteExtractionError", () => {
  test("is false for ordinary errors", () => {
    expect(isIncompleteExtractionError(new Error("nope"))).toBe(false);
    expect(isIncompleteExtractionError(undefined)).toBe(false);
  });
});

describe("findMissingMigrationDependency", () => {
  test("returns the dependency name when the resolver cannot resolve it", () => {
    const resolve = (specifier: string): string => {
      if (specifier === "kysely") {
        throw Object.assign(new Error("Cannot find package 'kysely'"), { code: "MODULE_NOT_FOUND" });
      }
      return `/resolved/${specifier}`;
    };
    expect(findMissingMigrationDependency("/migrations", resolve)).toBe("kysely");
  });

  test("returns null when every migration runtime dependency resolves", () => {
    const resolve = (specifier: string): string => `/resolved/${specifier}`;
    expect(findMissingMigrationDependency("/migrations", resolve)).toBeNull();
  });

  test("covers exactly the declared migration runtime dependencies", () => {
    const attempted: string[] = [];
    const resolve = (specifier: string): string => {
      attempted.push(specifier);
      return `/resolved/${specifier}`;
    };
    findMissingMigrationDependency("/migrations", resolve);
    expect(attempted).toEqual([...MIGRATION_RUNTIME_DEPENDENCIES]);
    expect(MIGRATION_RUNTIME_DEPENDENCIES).toContain("kysely");
  });

  test("resolves each dependency from the given migrations folder", () => {
    const seenPaths: Array<string | undefined> = [];
    const resolve = (specifier: string, fromDir?: string): string => {
      seenPaths.push(fromDir);
      return `/resolved/${specifier}`;
    };
    findMissingMigrationDependency("/some/migrations/dir", resolve);
    expect(seenPaths.every(p => p === "/some/migrations/dir")).toBe(true);
  });
});

describe("assertMigrationDependenciesResolvable", () => {
  test("throws a recoverable incomplete-extraction error naming the missing dependency", () => {
    const resolve = (specifier: string): string => {
      if (specifier === "kysely") {
        throw new Error("Cannot find package 'kysely'");
      }
      return `/resolved/${specifier}`;
    };

    let thrown: unknown;
    try {
      assertMigrationDependenciesResolvable("/migrations", resolve);
    } catch (error) {
      thrown = error;
    }

    expect(isIncompleteExtractionError(thrown)).toBe(true);
    expect((thrown as Error).message).toContain("kysely");
  });

  test("does nothing when all dependencies resolve", () => {
    const resolve = (specifier: string): string => `/resolved/${specifier}`;
    expect(() => assertMigrationDependenciesResolvable("/migrations", resolve)).not.toThrow();
  });
});
