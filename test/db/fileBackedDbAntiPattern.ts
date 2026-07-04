/**
 * Mechanical guard for the file-backed DB-lifecycle flake-avoidance pattern
 * (issue #3081, follow-up to the `withFileBackedDb.ts` harness in #3046/PR #3078).
 *
 * The harness (`createFileBackedDbHarness()`) made the correct pattern the
 * *documented* path of least resistance, but it was still opt-in prose: a new
 * `test/db/*.test.ts` suite could hand-roll the anti-pattern and never touch the
 * harness. Since this is the THIRD recurrence of the same `windows-latest`
 * file-backed sqlite flake class (#2916 -> #2923, #2992 -> #3040, #3046), "prose
 * hasn't stopped the recurrence" applies to the harness too. This module turns
 * the three deleted anti-pattern signatures into a fast, purely-textual guard so
 * the next reintroduction fails a unit test instead of a Windows CI run.
 *
 * It is a pure `(fileName, source) -> violations` function so it is unit-tested
 * with string fixtures (no filesystem) and then applied to the real
 * `test/db/*.test.ts` tree by the accompanying meta-test — both stay <100ms.
 *
 * The three signatures (each is exactly what #3046 removed from the migrated
 * suites):
 *
 *   1. `raw-cache-busted-import` — a raw cache-busted `import(".../database.ts?…")`
 *      dynamic import. The fresh-module import must go through the single
 *      canonical primitive `importFreshDatabaseModule()`
 *      ({@link file://./freshDatabaseModule.ts}) — which the harness wraps — so
 *      the cache-bust key is the collision-proof monotonic counter and not an
 *      ad-hoc `Date.now()-Math.random()`. `freshDatabaseModule.ts` and
 *      `withFileBackedDb.ts` are the only sanctioned homes for the raw import and
 *      are not `*.test.ts`, so no test file may contain it.
 *
 *   2. `hand-rolled-temp-dir-retry` — a locally re-implemented bounded/unbounded
 *      temp-dir removal retry loop (the `removeTempDirWithRetry` /
 *      `attempt < 100` EBUSY/EPERM/ENOTEMPTY loop #3046 deleted three copies of).
 *      Cleanup must go through the ONE bounded {@link file://./tempDbDir.ts}
 *      `removeTempDbDir` so a Windows file-handle livelock can never stall
 *      `afterEach`.
 *
 *   3. `unfunneled-mkdtemp` — a file-backed lifecycle suite (one that imports a
 *      fresh `database.ts` module) that also calls `mkdtemp`/`mkdtempSync`
 *      directly instead of funneling its DB dir through the harness's tracked
 *      `makeTempDbDir` / `openLifecycleTestDb`. An untracked temp dir escapes the
 *      bounded cleanup, reopening the same flake surface.
 *
 * Scope of the guard: it is a fast *textual* backstop for the exact three
 * signatures #3046 deleted, not a full parser. It deliberately matches only
 * inline literals: an `import()` whose specifier is assembled from a variable, a
 * removal via `unlink`/`rimraf` rather than `rm`, or a fresh module reached
 * transitively through an un-named helper can slip through. That is an accepted
 * trade — the recurring anti-pattern has always been an inline copy of the
 * deleted code, and a stricter AST guard is not warranted until a variant
 * actually recurs (CLAUDE.md YAGNI). The primitives it points at
 * (`importFreshDatabaseModule`, `removeTempDbDir`, the harness) remain the real
 * enforcement; this just makes the common reintroduction fail fast.
 */

export type FileBackedDbAntiPatternRule =
  | "raw-cache-busted-import"
  | "hand-rolled-temp-dir-retry"
  | "unfunneled-mkdtemp";

export interface FileBackedDbAntiPatternViolation {
  /** The scanned file (as passed in; the meta-test passes a repo-relative path). */
  file: string;
  /** Which anti-pattern signature matched. */
  rule: FileBackedDbAntiPatternRule;
  /** 1-based line number of the first offending match. */
  line: number;
  /** Human-readable explanation + the sanctioned alternative. */
  message: string;
}

/**
 * Per-file, per-rule exemptions. Keyed by BASENAME so the allowlist is stable
 * regardless of how the caller spells the path. Kept intentionally tiny — every
 * entry is a file that legitimately embodies the sanctioned primitive itself, not
 * a suite that re-hand-rolls the pattern.
 */
const RULE_EXEMPTIONS: Readonly<Record<string, ReadonlySet<FileBackedDbAntiPatternRule>>> = {
  // The harness's OWN unit test injects fake `mkdtemp`s and drives the real
  // `openLifecycleTestDb` — it is the reference consumer, not an unfunneled suite.
  "withFileBackedDb.test.ts": new Set(["unfunneled-mkdtemp"]),
};

// A raw cache-busted dynamic import whose specifier targets `database`/`database.ts`
// followed by a `?` query string (any quote style, incl. template literals).
const RAW_CACHE_BUSTED_IMPORT =
  /\bimport\s*\(\s*(['"`])(?:(?!\1)[\s\S])*?database(?:\.ts)?\?/;

// The exact deleted helper-name family. `removeTempDbDir` (the canonical bounded
// remover) contains no "Retry" and never matches.
const HAND_ROLLED_RETRY_NAME = /removeTempDir\w*Retry/;

// A transient-lock code as a *quoted literal* — the fingerprint of code that
// gates removal retries on it. A bareword in a comment ("...hits EBUSY...") or a
// classification message (`new Error("EBUSY: ...")`) is intentionally excluded
// from the retry-loop conjunction below.
const QUOTED_TRANSIENT_LOCK_CODE = /["'](?:EBUSY|EPERM|ENOTEMPTY)["']/;

// A manual retry loop.
const MANUAL_RETRY_LOOP = /\bfor\s*\(\s*let\s+attempt\b|\bwhile\s*\(/;

// An actual filesystem removal call (not the canonical `removeTempDbDir`).
const FS_REMOVAL_CALL = /\brm(?:Sync)?\s*\(/;

// Any signal that a file imports/uses a fresh `database.ts` module — i.e. it is a
// file-backed lifecycle suite subject to the harness contract.
const FRESH_MODULE_USE =
  /importFreshDatabaseModule|createFileBackedDbHarness|openLifecycleTestDb|withFileBackedDb/;

// A direct `mkdtemp`/`mkdtempSync` call (lowercase leading `m`, so `makeFakeMkdtemp`
// and other camelCase identifiers are not matched).
const RAW_MKDTEMP_CALL = /\bmkdtemp(?:Sync)?\s*\(/;

function lineOf(source: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index && i < source.length; i += 1) {
    if (source[i] === "\n") {
      line += 1;
    }
  }
  return line;
}

/** First 1-based line matching `pattern`, or 1 if the caller only needs a marker. */
function firstMatchLine(source: string, pattern: RegExp): number {
  const match = pattern.exec(source);
  return match ? lineOf(source, match.index) : 1;
}

function isExempt(fileName: string, rule: FileBackedDbAntiPatternRule): boolean {
  const base = fileName.split(/[\\/]/).pop() ?? fileName;
  return RULE_EXEMPTIONS[base]?.has(rule) ?? false;
}

/**
 * Return every file-backed DB-lifecycle anti-pattern in `source`. Pure and
 * synchronous: the meta-test reads each `test/db/*.test.ts` and calls this; the
 * unit tests call it with hand-written fixtures.
 */
export function findFileBackedDbAntiPatterns(
  fileName: string,
  source: string
): FileBackedDbAntiPatternViolation[] {
  const violations: FileBackedDbAntiPatternViolation[] = [];

  // 1. Raw cache-busted `database.ts?…` import.
  if (!isExempt(fileName, "raw-cache-busted-import") && RAW_CACHE_BUSTED_IMPORT.test(source)) {
    violations.push({
      file: fileName,
      rule: "raw-cache-busted-import",
      line: firstMatchLine(source, RAW_CACHE_BUSTED_IMPORT),
      message:
        "raw cache-busted `import(\".../database.ts?…\")`; import a fresh module " +
        "via `importFreshDatabaseModule()` (freshDatabaseModule.ts) or the " +
        "`createFileBackedDbHarness()` harness instead.",
    });
  }

  // 2. Hand-rolled temp-dir removal retry loop.
  if (!isExempt(fileName, "hand-rolled-temp-dir-retry")) {
    const named = HAND_ROLLED_RETRY_NAME.test(source);
    const structural =
      QUOTED_TRANSIENT_LOCK_CODE.test(source) &&
      MANUAL_RETRY_LOOP.test(source) &&
      FS_REMOVAL_CALL.test(source);
    if (named || structural) {
      const marker = named ? HAND_ROLLED_RETRY_NAME : FS_REMOVAL_CALL;
      violations.push({
        file: fileName,
        rule: "hand-rolled-temp-dir-retry",
        line: firstMatchLine(source, marker),
        message:
          "hand-rolled temp-dir removal retry loop (EBUSY/EPERM/ENOTEMPTY); use " +
          "the single bounded `removeTempDbDir` (tempDbDir.ts) — via the harness's " +
          "tracked cleanup — so a Windows handle livelock can never stall afterEach.",
      });
    }
  }

  // 3. Unfunneled `mkdtemp` in a fresh-module lifecycle suite.
  if (
    !isExempt(fileName, "unfunneled-mkdtemp") &&
    FRESH_MODULE_USE.test(source) &&
    RAW_MKDTEMP_CALL.test(source)
  ) {
    violations.push({
      file: fileName,
      rule: "unfunneled-mkdtemp",
      line: firstMatchLine(source, RAW_MKDTEMP_CALL),
      message:
        "a file-backed lifecycle suite calling `mkdtemp` directly; funnel the DB " +
        "dir through the harness's tracked `makeTempDbDir` / `openLifecycleTestDb` " +
        "so the temp dir is bounded-cleanup tracked.",
    });
  }

  return violations;
}
