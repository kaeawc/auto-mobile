import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { MIGRATION_RUNTIME_DEPENDENCIES } from "../../src/db/migrationDependencyIntegrity";
import {
  barePackageName,
  extractValueImportPackages,
  findMigrationDependencyDrift,
} from "./migrationRuntimeDependencies";

/**
 * Guard for {@link MIGRATION_RUNTIME_DEPENDENCIES} drift (issue #2867).
 *
 * Two layers, mirroring `migrationFilenameOrdering.test.ts`:
 *   - Unit tests of the pure extractor / drift-detector against hand-written
 *     source fixtures — value vs type-only imports, inline `type` members,
 *     scoped/subpath specifiers, relative imports.
 *   - A meta-test that scans the real `src/db/migrations/` directory and
 *     asserts every runtime value import is present in the allowlist, so a new
 *     migration importing an un-listed package fails HERE (a <100ms unit test)
 *     instead of silently losing the recoverable incomplete-extraction message
 *     for that dependency (issue #2833 symptom).
 */

describe("barePackageName", () => {
  test("returns the package name unchanged for a bare specifier", () => {
    expect(barePackageName("kysely")).toBe("kysely");
  });

  test("strips a subpath from an unscoped package", () => {
    expect(barePackageName("kysely/helpers/postgres")).toBe("kysely");
  });

  test("keeps the scope for a scoped package", () => {
    expect(barePackageName("@scope/pkg")).toBe("@scope/pkg");
    expect(barePackageName("@scope/pkg/sub")).toBe("@scope/pkg");
  });

  test("returns null for relative and absolute specifiers (not packages)", () => {
    expect(barePackageName("../eventTables")).toBeNull();
    expect(barePackageName("./foo")).toBeNull();
    expect(barePackageName("/abs/path")).toBeNull();
  });
});

describe("extractValueImportPackages", () => {
  test("captures a plain value import", () => {
    expect(extractValueImportPackages('import { sql } from "kysely";')).toEqual(["kysely"]);
  });

  test("captures a value import with multiple members", () => {
    expect(extractValueImportPackages('import { Kysely, sql } from "kysely";')).toEqual(["kysely"]);
  });

  test("captures the value member of a mixed inline-type import", () => {
    // `{ type Kysely, sql }` — `sql` is a runtime value, so `kysely` counts.
    expect(extractValueImportPackages('import { type Kysely, sql } from "kysely";')).toEqual([
      "kysely",
    ]);
  });

  test("ignores a whole-clause `import type`", () => {
    expect(extractValueImportPackages('import type { Kysely } from "kysely";')).toEqual([]);
  });

  test("ignores a named import whose members are all inline `type`", () => {
    expect(extractValueImportPackages('import { type Kysely } from "kysely";')).toEqual([]);
    expect(extractValueImportPackages('import { type A, type B } from "kysely";')).toEqual([]);
  });

  test("ignores relative imports (not packages)", () => {
    expect(extractValueImportPackages('import { EVENT_TABLES } from "../eventTables";')).toEqual(
      [],
    );
  });

  test("de-duplicates and sorts across multiple imports", () => {
    const source = [
      'import type { Kysely } from "kysely";',
      'import { sql } from "kysely";',
      'import { z } from "zod";',
      'import { EVENT_TABLES } from "../eventTables";',
    ].join("\n");
    expect(extractValueImportPackages(source)).toEqual(["kysely", "zod"]);
  });

  test("reduces a scoped/subpath specifier to its package name", () => {
    expect(extractValueImportPackages('import { x } from "@scope/pkg/sub";')).toEqual([
      "@scope/pkg",
    ]);
  });

  test("handles single-quoted specifiers and leading indentation", () => {
    expect(extractValueImportPackages("  import { sql } from 'kysely';")).toEqual(["kysely"]);
  });
});

describe("findMigrationDependencyDrift detector (issue #2867)", () => {
  test("is clean when every value import is in the allowlist", () => {
    const sources = new Map([
      ["m1.ts", 'import { sql } from "kysely";'],
      ["m2.ts", 'import type { Kysely } from "kysely";'],
    ]);
    expect(findMigrationDependencyDrift(sources, ["kysely"])).toEqual([]);
  });

  test("flags a value import from a package missing from the allowlist", () => {
    const sources = new Map([["m1.ts", 'import { z } from "zod";']]);
    const violations = findMigrationDependencyDrift(sources, ["kysely"]);
    expect(violations).toHaveLength(1);
    expect(violations[0].package).toBe("zod");
    expect(violations[0].files).toEqual(["m1.ts"]);
    expect(violations[0].message).toContain("MIGRATION_RUNTIME_DEPENDENCIES");
    expect(violations[0].message).toContain("zod");
  });

  test("does NOT flag a type-only import of an un-listed package", () => {
    const sources = new Map([["m1.ts", 'import type { Foo } from "some-types-pkg";']]);
    expect(findMigrationDependencyDrift(sources, ["kysely"])).toEqual([]);
  });

  test("aggregates every file importing the same missing package, sorted", () => {
    const sources = new Map([
      ["b.ts", 'import { z } from "zod";'],
      ["a.ts", 'import { schema } from "zod";'],
    ]);
    const violations = findMigrationDependencyDrift(sources, ["kysely"]);
    expect(violations).toHaveLength(1);
    expect(violations[0].files).toEqual(["a.ts", "b.ts"]);
  });

  test("reports one violation per distinct missing package, sorted by name", () => {
    const sources = new Map([
      ["m1.ts", 'import { z } from "zod";\nimport { produce } from "immer";'],
    ]);
    const violations = findMigrationDependencyDrift(sources, ["kysely"]);
    expect(violations.map((v) => v.package)).toEqual(["immer", "zod"]);
  });
});

describe("real src/db/migrations directory (issue #2867 meta-test)", () => {
  test("every runtime value import is declared in MIGRATION_RUNTIME_DEPENDENCIES", () => {
    const migrationsDir = join(import.meta.dir, "..", "..", "src", "db", "migrations");
    const filenames = readdirSync(migrationsDir).filter((name) => name.endsWith(".ts"));
    // Sanity: the directory actually resolved (an empty read would vacuously pass).
    expect(filenames.length).toBeGreaterThan(30);

    const sources = new Map(
      filenames.map((name) => [name, readFileSync(join(migrationsDir, name), "utf8")]),
    );

    // Sanity: the scan finds the known `kysely` value import somewhere, proving
    // the extractor is actually seeing real import lines (not vacuously empty).
    const allImported = new Set<string>();
    for (const source of sources.values()) {
      for (const pkg of extractValueImportPackages(source)) {
        allImported.add(pkg);
      }
    }
    expect(allImported.has("kysely")).toBe(true);

    const violations = findMigrationDependencyDrift(sources, MIGRATION_RUNTIME_DEPENDENCIES);
    const rendered = violations.map((v) => v.message).join("\n\n");
    expect(rendered).toBe("");
  });

  test("the allowlist has no unused entries (every listed dep is actually imported)", () => {
    const migrationsDir = join(import.meta.dir, "..", "..", "src", "db", "migrations");
    const filenames = readdirSync(migrationsDir).filter((name) => name.endsWith(".ts"));
    const imported = new Set<string>();
    for (const name of filenames) {
      for (const pkg of extractValueImportPackages(
        readFileSync(join(migrationsDir, name), "utf8"),
      )) {
        imported.add(pkg);
      }
    }
    const unused = MIGRATION_RUNTIME_DEPENDENCIES.filter((dep) => !imported.has(dep));
    expect(unused).toEqual([]);
  });
});
