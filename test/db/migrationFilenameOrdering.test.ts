import { describe, expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import {
  GRANDFATHERED_PREFIX_COLLISIONS,
  MIGRATION_FILENAME_PATTERN,
  checkMigrationFilenames,
  findStaleGrandfatherEntries,
} from "./migrationFilenameOrdering";

/**
 * Guard for migration filename ordering (issue #2868).
 *
 * Two layers, mirroring `fileBackedDbAntiPattern.test.ts`:
 *   - Unit tests of the pure `checkMigrationFilenames` detector against
 *     hand-written fixtures — malformed names, new prefix collisions,
 *     grandfathered collisions, and the stale-allowlist ratchet.
 *   - A meta-test that runs the detector over the real `src/db/migrations/`
 *     directory and asserts it is clean, so the next ambiguous filename fails
 *     HERE (a <100ms unit test) instead of as a `corrupted migrations`
 *     startup wedge on someone's populated dev DB.
 */

const CLEAN_PAIR = ["2026_08_01_000_alpha.ts", "2026_08_01_001_beta.ts"];

describe("checkMigrationFilenames detector (issue #2868)", () => {
  describe("malformed-filename", () => {
    test("flags a filename with no NNN sequence", () => {
      const violations = checkMigrationFilenames(["2026_08_01_alpha.ts"]);
      expect(violations).toHaveLength(1);
      expect(violations[0].rule).toBe("malformed-filename");
      expect(violations[0].files).toEqual(["2026_08_01_alpha.ts"]);
      expect(violations[0].message).toContain("YYYY_MM_DD_NNN");
    });

    test("flags uppercase / dashed / dotted descriptions", () => {
      for (const bad of [
        "2026_08_01_000_Alpha.ts",
        "2026_08_01_000_alpha-beta.ts",
        "2026_08_01_000_alpha.beta.ts",
      ]) {
        const violations = checkMigrationFilenames([bad]);
        expect(violations.map((v) => v.rule)).toEqual(["malformed-filename"]);
      }
    });

    test("flags a stray non-TypeScript file in the migrations directory", () => {
      const violations = checkMigrationFilenames(["README.md"]);
      expect(violations.map((v) => v.rule)).toEqual(["malformed-filename"]);
    });

    test("flags a trailing underscore before the extension", () => {
      const violations = checkMigrationFilenames(["2026_08_01_000_alpha_.ts"]);
      expect(violations.map((v) => v.rule)).toEqual(["malformed-filename"]);
    });

    test("accepts the canonical shape, including digits in the description", () => {
      expect(checkMigrationFilenames(CLEAN_PAIR)).toEqual([]);
      expect(checkMigrationFilenames(["2026_08_01_000_add_v2_index.ts"])).toEqual([]);
    });
  });

  describe("prefix-collision", () => {
    test("flags two migrations sharing a full YYYY_MM_DD_NNN prefix", () => {
      const violations = checkMigrationFilenames([
        "2026_08_01_000_alpha.ts",
        "2026_08_01_000_beta.ts",
      ]);
      expect(violations).toHaveLength(1);
      expect(violations[0].rule).toBe("prefix-collision");
      expect(violations[0].files).toEqual(["2026_08_01_000_alpha.ts", "2026_08_01_000_beta.ts"]);
    });

    test("the message names the colliding prefix and suggests the next NNN", () => {
      const [violation] = checkMigrationFilenames([
        "2026_08_01_000_alpha.ts",
        "2026_08_01_000_beta.ts",
      ]);
      expect(violation.message).toContain("2026_08_01_000");
      expect(violation.message).toContain("2026_08_01_001");
      expect(violation.message).toContain("Do NOT extend GRANDFATHERED_PREFIX_COLLISIONS");
    });

    test("does NOT flag same-day migrations with distinct NNN sequences", () => {
      expect(checkMigrationFilenames(CLEAN_PAIR)).toEqual([]);
    });

    test("does NOT flag the grandfathered historical pairs", () => {
      const violations = checkMigrationFilenames(
        Object.values(GRANDFATHERED_PREFIX_COLLISIONS).flat(),
      );
      expect(violations).toEqual([]);
    });

    test("flags a THIRD file added to a grandfathered prefix", () => {
      const violations = checkMigrationFilenames([
        ...Object.values(GRANDFATHERED_PREFIX_COLLISIONS).flat(),
        "2026_01_03_000_zzz_new_table.ts",
      ]);
      const collisions = violations.filter((v) => v.rule === "prefix-collision");
      expect(collisions).toHaveLength(1);
      expect(collisions[0].files).toContain("2026_01_03_000_zzz_new_table.ts");
    });

    test("flags three-way collisions on a non-grandfathered prefix as one violation", () => {
      const violations = checkMigrationFilenames([
        "2026_08_01_000_alpha.ts",
        "2026_08_01_000_beta.ts",
        "2026_08_01_000_gamma.ts",
      ]);
      expect(violations).toHaveLength(1);
      expect(violations[0].files).toHaveLength(3);
    });
  });

  describe("stale-grandfather-entry ratchet", () => {
    test("flags a grandfathered file that no longer exists (allowlist must shrink)", () => {
      const all = Object.values(GRANDFATHERED_PREFIX_COLLISIONS).flat();
      const withoutOne = all.filter((f) => f !== "2026_01_27_000_failures.ts");
      const stale = findStaleGrandfatherEntries(withoutOne);
      expect(stale).toHaveLength(1);
      expect(stale[0].rule).toBe("stale-grandfather-entry");
      expect(stale[0].files).toEqual(["2026_01_27_000_failures.ts"]);
      // Losing one half of a grandfathered pair also dissolves the collision,
      // so the survivor must not be flagged by the collision check.
      expect(checkMigrationFilenames(withoutOne)).toEqual([]);
    });

    test("is clean when every grandfathered file is present", () => {
      const all = Object.values(GRANDFATHERED_PREFIX_COLLISIONS).flat();
      expect(findStaleGrandfatherEntries(all)).toEqual([]);
    });
  });

  describe("allowlist self-consistency", () => {
    test("every grandfathered filename matches the pattern and its own prefix", () => {
      for (const [prefix, files] of Object.entries(GRANDFATHERED_PREFIX_COLLISIONS)) {
        for (const file of files) {
          const match = MIGRATION_FILENAME_PATTERN.exec(file);
          expect(match).not.toBeNull();
          expect(match![1]).toBe(prefix);
        }
      }
    });

    test("grandfathered entries are frozen pairs (never grown in place)", () => {
      for (const files of Object.values(GRANDFATHERED_PREFIX_COLLISIONS)) {
        expect(files).toHaveLength(2);
        expect(Object.isFrozen(files)).toBe(true);
      }
      expect(Object.isFrozen(GRANDFATHERED_PREFIX_COLLISIONS)).toBe(true);
    });
  });
});

describe("real src/db/migrations directory (issue #2868 meta-test)", () => {
  test("has no malformed filenames and no NEW ordering-prefix collisions", () => {
    const migrationsDir = join(import.meta.dir, "..", "..", "src", "db", "migrations");
    const filenames = readdirSync(migrationsDir);
    // Sanity: the directory actually resolved (an empty read would vacuously pass).
    expect(filenames.length).toBeGreaterThan(30);

    const violations = [
      ...checkMigrationFilenames(filenames),
      ...findStaleGrandfatherEntries(filenames),
    ];
    const rendered = violations.map((v) => `[${v.rule}] ${v.message}`).join("\n\n");
    expect(rendered).toBe("");
  });
});
