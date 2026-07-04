import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  findFileBackedDbAntiPatterns,
  type FileBackedDbAntiPatternRule,
} from "./fileBackedDbAntiPattern";

/**
 * Guard for the file-backed DB-lifecycle flake-avoidance pattern (issue #3081).
 *
 * Two layers:
 *   - Unit tests of the pure `findFileBackedDbAntiPatterns` detector against
 *     hand-written fixtures — each of the three deleted anti-pattern signatures
 *     (raw cache-busted import, hand-rolled temp-dir retry, unfunneled mkdtemp)
 *     plus the legitimate patterns that must NOT trip it.
 *   - A meta-test that runs the detector over the real `test/db/*.test.ts` tree
 *     and asserts it is clean, so a reintroduction fails HERE (a <100ms unit
 *     test) instead of on a `windows-latest` CI run three rounds later.
 */
describe("findFileBackedDbAntiPatterns detector (issue #3081)", () => {
  function rules(source: string): FileBackedDbAntiPatternRule[] {
    return findFileBackedDbAntiPatterns("test/db/example.test.ts", source).map(v => v.rule);
  }

  describe("1. raw-cache-busted-import", () => {
    test("flags a template-literal `database.ts?…` dynamic import", () => {
      const source = "const m = await import(`../../src/db/database.ts?fresh=${n}`);";
      expect(rules(source)).toContain("raw-cache-busted-import");
    });

    test("flags the `Date.now()-Math.random()` guard-test cache-buster shape", () => {
      const source =
        "return import(`../../src/db/database.ts?guard-test=${Date.now()}-${Math.random()}`);";
      const found = findFileBackedDbAntiPatterns("test/db/example.test.ts", source);
      expect(found).toHaveLength(1);
      expect(found[0].rule).toBe("raw-cache-busted-import");
      expect(found[0].line).toBe(1);
      expect(found[0].message).toContain("importFreshDatabaseModule");
    });

    test("flags a single-quoted `database?` import with no `.ts`", () => {
      const source = "await import('../../src/db/database?bust=' + n);";
      expect(rules(source)).toContain("raw-cache-busted-import");
    });

    test("does NOT flag a plain static import of database.ts", () => {
      const source = 'import { getDatabase } from "../../src/db/database";';
      expect(rules(source)).not.toContain("raw-cache-busted-import");
    });

    test("does NOT flag a dynamic import with no cache-bust query", () => {
      const source = 'const m = await import("../../src/db/database");';
      expect(rules(source)).not.toContain("raw-cache-busted-import");
    });

    test("does NOT flag importing a DIFFERENT `?…` module (not database)", () => {
      const source = "await import(`../../src/db/migrator.ts?fresh=${n}`);";
      expect(rules(source)).not.toContain("raw-cache-busted-import");
    });
  });

  describe("2. hand-rolled-temp-dir-retry", () => {
    test("flags a `removeTempDirWithRetry` helper by name", () => {
      const source = [
        "async function removeTempDirWithRetry(dir) {",
        "  await someRemove(dir);",
        "}",
      ].join("\n");
      const found = findFileBackedDbAntiPatterns("test/db/example.test.ts", source);
      expect(found.map(v => v.rule)).toContain("hand-rolled-temp-dir-retry");
      expect(found[0].line).toBe(1);
    });

    test("flags a structural EBUSY/attempt-loop/rm reimplementation with a different name", () => {
      const source = [
        "async function cleanupDir(dir) {",
        "  for (let attempt = 0; attempt < 100; attempt += 1) {",
        "    try {",
        "      await rm(dir, { recursive: true });",
        "      return;",
        "    } catch (error) {",
        '      if (error.code !== "EBUSY" && error.code !== "EPERM") throw error;',
        "    }",
        "  }",
        "}",
      ].join("\n");
      expect(rules(source)).toContain("hand-rolled-temp-dir-retry");
    });

    test("does NOT flag a long POLL loop that never removes a dir or gates on a lock code", () => {
      const source = [
        "for (let attempt = 0; attempt < 500; attempt += 1) {",
        "  if (module.getMigrationsError()) break;",
        "  await timer.sleep(1);",
        "}",
      ].join("\n");
      expect(rules(source)).not.toContain("hand-rolled-temp-dir-retry");
    });

    test("does NOT flag error-classification code that only mentions EBUSY in a string message", () => {
      const source =
        'expect(classifyDatabaseFailure(new Error("EBUSY: resource busy"))).toBe("transient");';
      expect(rules(source)).not.toContain("hand-rolled-temp-dir-retry");
    });

    test("does NOT flag a call to the canonical `removeTempDbDir`", () => {
      const source = 'import { removeTempDbDir } from "./tempDbDir";\nawait removeTempDbDir(dir);';
      expect(rules(source)).not.toContain("hand-rolled-temp-dir-retry");
    });

    test("does NOT flag Node's bounded `rmSync(..., { maxRetries })` with EBUSY only in a comment", () => {
      const source = [
        "// the temp dir can transiently hit EBUSY — retry, best-effort",
        "rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });",
      ].join("\n");
      expect(rules(source)).not.toContain("hand-rolled-temp-dir-retry");
    });
  });

  describe("3. unfunneled-mkdtemp", () => {
    test("flags a fresh-module lifecycle suite that calls mkdtemp directly", () => {
      const source = [
        'import { importFreshDatabaseModule } from "./freshDatabaseModule";',
        'const dir = await mkdtemp(join(tmpdir(), "am-"));',
        "const module = await importFreshDatabaseModule();",
      ].join("\n");
      const found = findFileBackedDbAntiPatterns("test/db/example.test.ts", source);
      expect(found.map(v => v.rule)).toContain("unfunneled-mkdtemp");
    });

    test("flags a harness-using suite that hand-rolls mkdtempSync for its DB dir", () => {
      const source = [
        'import { createFileBackedDbHarness } from "./withFileBackedDb";',
        'const dir = mkdtempSync(join(tmpdir(), "am-"));',
      ].join("\n");
      expect(rules(source)).toContain("unfunneled-mkdtemp");
    });

    test("does NOT flag mkdtemp in a file that never imports a fresh DB module (e.g. a lock-path test)", () => {
      const source = [
        'import { mkdtempSync } from "fs";',
        'const dir = mkdtempSync(join(tmpdir(), "migration-lock-"));',
        'const lockPath = join(dir, "auto-mobile.db.migrate.lock");',
      ].join("\n");
      expect(rules(source)).not.toContain("unfunneled-mkdtemp");
    });

    test("does NOT flag a lifecycle suite that funnels through harness.makeTempDbDir (no raw mkdtemp)", () => {
      const source = [
        'import { createFileBackedDbHarness } from "./withFileBackedDb";',
        "const dir = await harness.makeTempDbDir(\"am-\");",
      ].join("\n");
      expect(rules(source)).not.toContain("unfunneled-mkdtemp");
    });

    test("does NOT match a camelCase identifier like `makeFakeMkdtemp`", () => {
      const source = [
        'import { createFileBackedDbHarness } from "./withFileBackedDb";',
        "const { mkdtemp } = makeFakeMkdtemp();",
      ].join("\n");
      expect(rules(source)).not.toContain("unfunneled-mkdtemp");
    });
  });

  test("a clean lifecycle suite that uses the harness produces zero violations", () => {
    const source = [
      'import { createFileBackedDbHarness } from "./withFileBackedDb";',
      "const harness = createFileBackedDbHarness();",
      'const opened = await harness.openLifecycleTestDb("am-");',
      "await opened.close();",
      "await harness.cleanup();",
    ].join("\n");
    expect(findFileBackedDbAntiPatterns("test/db/example.test.ts", source)).toEqual([]);
  });
});

/**
 * Meta-test: the real `test/db/*.test.ts` tree must be free of every deleted
 * anti-pattern. This is the enforcement teeth issue #3081 asked for — it fails
 * the moment a new suite hand-rolls what the harness centralizes.
 */
describe("test/db suites are free of file-backed DB anti-patterns (issue #3081)", () => {
  const dbDir = import.meta.dir;
  // This detector's OWN test file embeds each anti-pattern as a string fixture to
  // prove the detector fires; it is not a lifecycle suite, so exclude it from the
  // real-tree scan (otherwise the fixtures self-flag).
  const SELF = "fileBackedDbAntiPattern.test.ts";
  const testFiles = readdirSync(dbDir).filter(
    name => name.endsWith(".test.ts") && name !== SELF
  );

  test("the guard actually scans the DB test suite (non-empty)", () => {
    // A guard that scans nothing is a false sense of security.
    expect(testFiles.length).toBeGreaterThan(10);
    expect(testFiles).toContain("withFileBackedDb.test.ts");
  });

  test("no test/db suite reintroduces a hand-rolled flake-avoidance anti-pattern", () => {
    const violations = testFiles.flatMap(name =>
      findFileBackedDbAntiPatterns(name, readFileSync(join(dbDir, name), "utf8"))
    );
    const rendered = violations
      .map(v => `  - ${v.file}:${v.line} [${v.rule}] ${v.message}`)
      .join("\n");
    expect(rendered).toBe("");
  });
});
