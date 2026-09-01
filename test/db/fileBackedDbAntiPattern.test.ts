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
    return findFileBackedDbAntiPatterns("test/db/example.test.ts", source).map((v) => v.rule);
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
      expect(found.map((v) => v.rule)).toContain("hand-rolled-temp-dir-retry");
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

    test("flags a `while (attempt < n)` retry-shaped loop that removes a dir and gates on a lock code", () => {
      const source = [
        "let attempt = 0;",
        "while (attempt < 100) {",
        "  attempt += 1;",
        "  try {",
        "    await rm(dir, { recursive: true });",
        "    break;",
        "  } catch (error) {",
        '    if (error.code !== "ENOTEMPTY") throw error;',
        "  }",
        "}",
      ].join("\n");
      expect(rules(source)).toContain("hand-rolled-temp-dir-retry");
    });

    test("does NOT flag a generic `while (cond)` poll even with a lock code and rm nearby", () => {
      // A generic poll condition is not retry/attempt/backoff-shaped, so the
      // structural conjunction must not fire — this guards tempDbDir.integration.test.ts (the
      // bounded remover's own test, which holds the quoted lock codes) from a
      // false positive if it ever grows a real-fs poll + cleanup case.
      const source = [
        "while (!ready) {",
        "  await rmSync(dir);",
        '  if (lastCode === "EBUSY") ready = check();',
        "}",
      ].join("\n");
      expect(rules(source)).not.toContain("hand-rolled-temp-dir-retry");
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
      expect(found.map((v) => v.rule)).toContain("unfunneled-mkdtemp");
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
        'const dir = await harness.makeTempDbDir("am-");',
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

  describe("sanctioned primitive homes are exempted (they ARE the primitive)", () => {
    test("freshDatabaseModule.ts may hold the raw cache-busted import", () => {
      const source = "return import(`../../src/db/database.ts?fresh-db-module=${moduleCounter}`);";
      const found = findFileBackedDbAntiPatterns("test/db/freshDatabaseModule.ts", source);
      expect(found).toEqual([]);
    });

    test("tempDbDir.ts may hold the bounded attempt-loop + lock codes", () => {
      const source = [
        'const codes = new Set(["EBUSY", "EPERM", "ENOTEMPTY"]);',
        "for (let attempt = 0; attempt < maxAttempts; attempt += 1) {",
        "  try { await rm(dir); return; } catch (e) { if (!codes.has(e.code)) throw e; }",
        "}",
      ].join("\n");
      const found = findFileBackedDbAntiPatterns("test/db/tempDbDir.ts", source);
      expect(found).toEqual([]);
    });

    test("withFileBackedDb.ts may call mkdtemp for its tracked makeTempDbDir", () => {
      const source = [
        'import { importFreshDatabaseModule } from "./freshDatabaseModule";',
        "const dir = await mkdtemp(path.join(tmpdir(), prefix));",
      ].join("\n");
      const found = findFileBackedDbAntiPatterns("test/db/withFileBackedDb.ts", source);
      expect(found).toEqual([]);
    });

    test("the exemption is per-rule: freshDatabaseModule.ts still flags an UNfunneled mkdtemp", () => {
      // It's exempt only for the cache-busted import it owns — a different
      // anti-pattern in the same file must still be caught.
      const source = [
        "return import(`../../src/db/database.ts?fresh=${n}`);",
        "await importFreshDatabaseModule();",
        'const dir = await mkdtemp("am-");',
      ].join("\n");
      const rulesFound = findFileBackedDbAntiPatterns("test/db/freshDatabaseModule.ts", source).map(
        (v) => v.rule,
      );
      expect(rulesFound).not.toContain("raw-cache-busted-import");
      expect(rulesFound).toContain("unfunneled-mkdtemp");
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
 * Meta-test: the real `test/db` tree must be free of every deleted anti-pattern.
 * This is the enforcement teeth issue #3081 asked for — it fails the moment a new
 * suite hand-rolls what the harness centralizes.
 *
 * It scans EVERY `test/db/*.ts` (the `*.test.ts` suites AND the non-test `.ts`
 * helpers), not just the suites, so extracting a hand-rolled loop into a sibling
 * helper — the refactor this harness promotes — is covered too. The sanctioned
 * primitive homes (freshDatabaseModule.ts, tempDbDir.ts, withFileBackedDb.ts) are
 * exempted per-rule inside the detector.
 */
describe("test/db is free of file-backed DB anti-patterns (issue #3081)", () => {
  const dbDir = import.meta.dir;
  // The guard does not guard itself: this detector and its fixture test embed
  // every anti-pattern as data (regexes / string fixtures) inherent to their
  // purpose, so both are excluded from the real-tree scan.
  const GUARD_OWN_FILES = new Set([
    "fileBackedDbAntiPattern.ts",
    "fileBackedDbAntiPattern.test.ts",
  ]);
  const scanned = readdirSync(dbDir).filter(
    (name) => name.endsWith(".ts") && !GUARD_OWN_FILES.has(name),
  );

  test("the guard actually scans the DB tree (suites + helpers, non-empty)", () => {
    // A guard that scans nothing is a false sense of security.
    expect(scanned.length).toBeGreaterThan(10);
    expect(scanned).toContain("withFileBackedDb.integration.test.ts");
    // Non-test helpers are in scope too — the sibling-helper blind spot is closed.
    expect(scanned).toContain("tempDbDir.ts");
    expect(scanned).toContain("freshDatabaseModule.ts");
  });

  test("no test/db file reintroduces a hand-rolled flake-avoidance anti-pattern", () => {
    const violations = scanned.flatMap((name) =>
      findFileBackedDbAntiPatterns(name, readFileSync(join(dbDir, name), "utf8")),
    );
    const rendered = violations
      .map((v) => `  - ${v.file}:${v.line} [${v.rule}] ${v.message}`)
      .join("\n");
    expect(rendered).toBe("");
  });
});
