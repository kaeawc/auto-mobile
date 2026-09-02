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
 * signatures #3046 deleted, not a full parser. The meta-test scans every
 * `test/db/*.ts` — both the `*.test.ts` suites AND the non-test helpers — so a
 * hand-rolled loop *extracted into a sibling helper* (the very refactor this
 * harness promotes) is covered too, not just an inline copy in a suite; the
 * sanctioned primitive homes are named in {@link RULE_EXEMPTIONS}. It still
 * matches only inline literals, so a few textual escapes remain by design: an
 * `import()` whose specifier is assembled from a variable, a removal via
 * `unlink`/`rmdir`/`rimraf` rather than `rm`, or lock codes gated through an
 * imported constant rather than an inline literal. That is an accepted trade —
 * the recurring anti-pattern has always been an inline copy of the deleted code,
 * and a stricter AST guard is not warranted until a variant actually recurs
 * (CLAUDE.md YAGNI). The primitives it points at (`importFreshDatabaseModule`,
 * `removeTempDbDir`, the harness) remain the real enforcement; this just makes
 * the common reintroduction fail fast.
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
 * entry is a file that legitimately IS the sanctioned primitive for that rule (so
 * it necessarily contains the pattern the rule flags), not a suite that
 * re-hand-rolls it. Scanning the non-test `.ts` helpers too (not just
 * `*.test.ts`) closes the "extract the hand-rolled loop into a sibling helper"
 * blind spot — the exact refactor this harness promotes — so these homes must be
 * named here or they would flag themselves.
 */
const RULE_EXEMPTIONS: Readonly<Record<string, ReadonlySet<FileBackedDbAntiPatternRule>>> = {
  // The canonical fresh-module importer — the ONE sanctioned home for the raw
  // cache-busted `database.ts?…` import (with the collision-proof counter).
  "freshDatabaseModule.ts": new Set(["raw-cache-busted-import"]),
  // The ONE bounded temp-dir remover (#2916); it necessarily contains the
  // attempt-loop + transient-lock-code handling every suite must route THROUGH it
  // instead of re-implementing.
  "tempDbDir.ts": new Set(["hand-rolled-temp-dir-retry"]),
  // The harness itself owns the tracked `mkdtemp` that `makeTempDbDir` wraps.
  "withFileBackedDb.ts": new Set(["unfunneled-mkdtemp"]),
  // The harness's OWN unit test injects fake `mkdtemp`s and drives the real
  // `openLifecycleTestDb` — it is the reference consumer, not an unfunneled suite.
  "withFileBackedDb.integration.test.ts": new Set(["unfunneled-mkdtemp"]),
};

// A raw cache-busted dynamic import whose specifier targets `database`/`database.ts`
// followed by a `?` query string (any quote style, incl. template literals).
const RAW_CACHE_BUSTED_IMPORT = /\bimport\s*\(\s*(['"`])(?:(?!\1)[\s\S])*?database(?:\.ts)?\?/;

// The exact deleted helper-name family. `removeTempDbDir` (the canonical bounded
// remover) contains no "Retry" and never matches.
const HAND_ROLLED_RETRY_NAME = /removeTempDir\w*Retry/;

// A transient-lock code as a *quoted literal* — the fingerprint of code that
// gates removal retries on it. A bareword in a comment ("...hits EBUSY...") or a
// classification message (`new Error("EBUSY: ...")`) is intentionally excluded
// from the retry-loop conjunction below.
const QUOTED_TRANSIENT_LOCK_CODE = /["'](?:EBUSY|EPERM|ENOTEMPTY)["']/;

// A manual *retry* loop specifically — a `for (let attempt …)` header, or a
// `while (…)` whose condition is retry/attempt/backoff-shaped. A generic
// `while (cond)` poll does NOT count: keying the structural rule on any `while`
// would leave it one edit away from false-positiving on `tempDbDir.integration.test.ts` (the
// bounded remover's own test), which already holds the quoted lock codes and
// could grow a real `rm` + poll case.
const MANUAL_RETRY_LOOP =
  /\bfor\s*\(\s*let\s+attempt\b|\bwhile\s*\([^)]*\b(?:attempt|retr|backoff)/i;

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
  source: string,
): FileBackedDbAntiPatternViolation[] {
  const violations: FileBackedDbAntiPatternViolation[] = [];

  // 1. Raw cache-busted `database.ts?…` import.
  if (!isExempt(fileName, "raw-cache-busted-import") && RAW_CACHE_BUSTED_IMPORT.test(source)) {
    violations.push({
      file: fileName,
      rule: "raw-cache-busted-import",
      line: firstMatchLine(source, RAW_CACHE_BUSTED_IMPORT),
      message:
        'raw cache-busted `import(".../database.ts?…")`; import a fresh module ' +
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
