import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { importOnlyIosCandidates } from "../../scripts/lib/iosTestImportSignal";
import {
  classifyTestPath,
  discoverTestFiles,
  loadManifest,
  patternMatches,
} from "../../scripts/lib/macOsOnlyTests";

const ROOT = join(import.meta.dir, "..", "..");
const MANIFEST = "test/macos-only-tests.txt";

const rules = loadManifest(ROOT);
const testFiles = discoverTestFiles(ROOT);

/**
 * Owner rule (2026-10-23): iOS tests never run on Linux or Windows. A path with an iOS
 * token is skipped off macOS automatically; this guard covers the two ways a test can
 * escape that rule or be skipped by accident (docs/design-docs/ci/macos-only-tests.md).
 */
/**
 * Each test walks the import graph of every test file (about 5 s on an idle machine, over 20 s
 * on a loaded CI runner or a lane running gates in parallel), so the 5 s default timed out
 * constantly. The explicit ceiling is for this file only; the per-test unit budget is untouched.
 */
const CLASSIFICATION_TIMEOUT_MS = 60_000;

describe("macOS-only test classification", () => {
  test(
    "every test whose direct imports are only iOS source has an explicit rule",
    () => {
      const unclassified = importOnlyIosCandidates(ROOT, testFiles).filter(
        (testPath) => classifyTestPath(testPath, rules).rule === undefined,
      );

      expect(
        unclassified,
        `These tests import only iOS source (src/**/ios/**, simctl, devicectl, ...) but have no ` +
          `rule in ${MANIFEST}. Add "macos <path> # reason" if they need an iOS host, or ` +
          `"portable <path> # reason" if they are cross-platform logic that must keep running ` +
          `on Linux and Windows.`,
      ).toEqual([]);
    },
    CLASSIFICATION_TIMEOUT_MS,
  );

  test(
    "every rule matches at least one test file",
    () => {
      const stale = rules.filter(
        (rule) => !testFiles.some((testPath) => patternMatches(rule.pattern, testPath)),
      );

      expect(
        stale.map((rule) => `${MANIFEST}:${rule.line} ${rule.pattern}`),
        "Remove rules whose files were renamed or deleted.",
      ).toEqual([]);
    },
    CLASSIFICATION_TIMEOUT_MS,
  );

  test(
    "a macos rule is only needed for tests without an iOS path token",
    () => {
      const redundant = rules
        .filter((rule) => rule.verdict === "macos")
        .filter((rule) =>
          testFiles
            .filter((testPath) => patternMatches(rule.pattern, testPath))
            .every((testPath) => classifyTestPath(testPath, []).macosOnly),
        );

      expect(
        redundant.map((rule) => `${MANIFEST}:${rule.line} ${rule.pattern}`),
        "These paths already carry an iOS token and are macOS-only without a rule; remove the rule.",
      ).toEqual([]);
    },
    CLASSIFICATION_TIMEOUT_MS,
  );

  test(
    "a portable rule keeps at least one file that would otherwise be skipped or must be classified",
    () => {
      const importCandidates = new Set(importOnlyIosCandidates(ROOT, testFiles));
      const unnecessary = rules
        .filter((rule) => rule.verdict === "portable")
        .filter((rule) =>
          testFiles
            .filter((testPath) => classifyTestPath(testPath, rules).rule === rule)
            .every(
              (testPath) =>
                !classifyTestPath(testPath, []).macosOnly && !importCandidates.has(testPath),
            ),
        );

      expect(
        unnecessary.map((rule) => `${MANIFEST}:${rule.line} ${rule.pattern}`),
        "These files already run everywhere without a rule; remove the portable rule.",
      ).toEqual([]);
    },
    CLASSIFICATION_TIMEOUT_MS,
  );
});
