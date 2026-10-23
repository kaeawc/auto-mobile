/**
 * Import-based signal for "this test exercises only iOS code", used by the
 * classification guard (test/lint/macOsOnlyTestClassification.integration.test.ts).
 *
 * A test is an import-signaled candidate when its direct runtime imports of
 * `src/` include at least one iOS-named module and nothing else outside a small
 * set of generic leaf modules. Mixed tests (an iOS module plus shared actions,
 * brokers or registries) are not candidates: they keep running everywhere.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { hasIosPathToken } from "./macOsOnlyTests";
import { relativeModuleSpecifiers, resolveRelativeSpecifier } from "./tsImportDeps";

/** Leaf modules a pure iOS test may import without becoming a "mixed" test. */
const GENERIC_SOURCE = [
  /^src\/models\//,
  /^src\/constants\//,
  /^src\/utils\/(logger|SystemTimer|Timer|IdGenerator|Random|Backoff|bounds|constants|describeUnknownError|ExecSeam|HostCommandExecutor)\.ts$/,
];

export function isGenericSource(srcPath: string): boolean {
  return GENERIC_SOURCE.some((pattern) => pattern.test(srcPath));
}

/** Cheap text prefilter: a test can only import iOS source if its text names one. */
export function mentionsIosSource(source: string): boolean {
  return /ios|simctl|devicectl|simulator|xcode|xcrun/i.test(source);
}

export interface ImportSignal {
  iosImports: string[];
  otherImports: string[];
}

/** Direct runtime (non-type) `src/` imports of one test, split into iOS and non-generic other. */
export function sourceImportSignal(
  repoRoot: string,
  testPath: string,
  source: string,
): ImportSignal {
  const sourceFile = ts.createSourceFile(testPath, source, ts.ScriptTarget.Latest, true);
  const absoluteTest = path.resolve(repoRoot, testPath);
  const known = { has: () => false };
  const resolved = new Set<string>();
  for (const specifier of relativeModuleSpecifiers(sourceFile, { includeTypeOnly: false })) {
    for (const dependency of resolveRelativeSpecifier(absoluteTest, specifier, repoRoot, known)) {
      resolved.add(path.relative(repoRoot, dependency).split(path.sep).join("/"));
    }
  }
  const sourceImports = [...resolved].filter((entry) => entry.startsWith("src/"));
  return {
    iosImports: sourceImports.filter((entry) => hasIosPathToken(entry)),
    otherImports: sourceImports.filter(
      (entry) => !hasIosPathToken(entry) && !isGenericSource(entry),
    ),
  };
}

export function isImportOnlyIosCandidate(signal: ImportSignal): boolean {
  return signal.iosImports.length > 0 && signal.otherImports.length === 0;
}

/** Test files (outside the path-token rule) whose direct imports are only iOS source. */
export function importOnlyIosCandidates(repoRoot: string, testPaths: readonly string[]): string[] {
  return testPaths.filter((testPath) => {
    if (hasIosPathToken(testPath)) {
      return false;
    }
    const source = readFileSync(path.join(repoRoot, testPath), "utf8");
    return (
      mentionsIosSource(source) &&
      isImportOnlyIosCandidate(sourceImportSignal(repoRoot, testPath, source))
    );
  });
}
