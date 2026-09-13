import { describe, expect, test } from "bun:test";
import { loadAllJobSteps, type WorkflowStep } from "../helpers/workflowSteps";

type JobStep = { jobId: string; step: WorkflowStep };

/**
 * DerivedData cache entries key on `hashFiles(...)` of the build inputs for
 * that project directory. `actions/cache` never updates an existing key
 * (docs: dependency-caching#matching-a-cache-key), so a key that hashes only
 * `*.swift` / `project.yml` / `*.pbxproj` produces an exact hit — and never a
 * save — when some OTHER compiled/configuration/resource input changes (an
 * Objective-C shim, an .xcconfig, Info.plist, an asset catalog, a font, …).
 * The rebuilt DerivedData for that changed input is silently discarded, and
 * every later run keeps restoring the stale output (PR #6953 review thread
 * PRRT_kwDOP-GF5M6h7WCL).
 */

const REQUIRED_EXTENSIONS = [
  ".swift",
  ".m",
  ".mm",
  ".h",
  ".c",
  ".cpp",
  ".xcconfig",
  ".plist",
  ".entitlements",
  ".storyboard",
  ".xib",
  ".xcassets",
  ".strings",
  ".ttf",
  ".otf",
  ".xcprivacy",
  ".pbxproj",
  ".xcscheme",
  "project.yml",
  "Package.swift",
  "Package.resolved",
];
// At least one project-descriptor pattern must be present; xcodegen projects
// use project.yml, hand-maintained ones use .pbxproj directly.
const REQUIRED_PROJECT_DESCRIPTOR_EXTENSIONS = [".pbxproj", "project.yml"];
// Never allow a hashFiles() pattern that would re-admit the excluded
// directories the SwiftPM cache-path guard (workflowCacheSwiftPmPaths) keeps
// out of the cache *contents* — hashing them would make the key nondeterministic
// / needlessly volatile across otherwise-identical source trees.
const FORBIDDEN_HASH_SEGMENTS = [".build", "SourcePackages", "DerivedData"];

function isDerivedDataCacheStep(step: WorkflowStep): boolean {
  if (typeof step.uses !== "string" || !step.uses.startsWith("actions/cache")) {
    return false;
  }
  const path = step.with?.path;
  return typeof path === "string" && /DerivedData|ModuleCache\.noindex/.test(path);
}

function extractHashFilesPatterns(key: string): string[] {
  const call = /hashFiles\(([^)]*)\)/.exec(key);
  if (!call) {
    return [];
  }
  return [...call[1].matchAll(/'([^']*)'/g)].map((match) => match[1]);
}

function validateDerivedDataCacheKeyPatterns(patterns: string[]): string[] {
  const violations: string[] = [];
  const scopes = new Set(
    patterns
      .filter((pattern) => pattern.includes("**"))
      .map((pattern) => pattern.slice(0, pattern.indexOf("**"))),
  );
  if (scopes.size === 0) {
    scopes.add("");
  }

  for (const scope of scopes) {
    for (const extension of REQUIRED_EXTENSIONS) {
      const expectedSuffix =
        extension === ".xcassets"
          ? ".xcassets/**"
          : extension.startsWith(".")
            ? `*${extension}`
            : extension;
      if (
        !patterns.some((pattern) => pattern.startsWith(scope) && pattern.endsWith(expectedSuffix))
      ) {
        violations.push(`scope '${scope}' does not hash '${expectedSuffix}' inputs`);
      }
    }

    if (
      !REQUIRED_PROJECT_DESCRIPTOR_EXTENSIONS.some((suffix) =>
        patterns.some((pattern) => pattern.startsWith(scope) && pattern.endsWith(suffix)),
      )
    ) {
      violations.push(
        `scope '${scope}' does not hash a project-descriptor input (.pbxproj or project.yml)`,
      );
    }
  }

  for (const pattern of patterns) {
    for (const forbidden of FORBIDDEN_HASH_SEGMENTS) {
      if (pattern.includes(forbidden)) {
        violations.push(`pattern '${pattern}' re-includes forbidden segment '${forbidden}'`);
      }
    }
  }

  return violations;
}

function collectDerivedDataCacheSteps(workflowRelativePath: string): JobStep[] {
  return loadAllJobSteps(workflowRelativePath).filter(({ step }) => isDerivedDataCacheStep(step));
}

describe("DerivedData cache keys hash every build input", () => {
  for (const workflow of [
    ".github/workflows/pull_request.yml",
    ".github/workflows/merge.yml",
    ".github/workflows/nightly.yml",
  ]) {
    test(`${workflow} DerivedData cache keys cover non-Swift build inputs`, () => {
      const steps = collectDerivedDataCacheSteps(workflow);

      expect(steps.length).toBeGreaterThan(0);

      for (const { jobId, step } of steps) {
        const withKey = typeof step.with?.key === "string" ? step.with.key : undefined;
        expect(withKey, `${workflow}/${jobId}: DerivedData cache step missing a key`).toBeDefined();

        const patterns = extractHashFilesPatterns(withKey as string);
        expect(
          patterns.length,
          `${workflow}/${jobId}: DerivedData cache key has no hashFiles(...) call: ${withKey}`,
        ).toBeGreaterThan(0);

        expect(
          validateDerivedDataCacheKeyPatterns(patterns),
          `${workflow}/${jobId}: ${patterns.join(", ")}`,
        ).toEqual([]);
      }
    });
  }
});

test("DerivedData cache guard checks every required input in every directory scope", () => {
  const patterns = ["ios/Playground/**/*.xcprivacy", "ios/Playground/**/*.pbxproj"];
  for (const extension of REQUIRED_EXTENSIONS) {
    if (extension !== ".xcprivacy") {
      const suffix =
        extension === ".xcassets"
          ? ".xcassets/**"
          : extension.startsWith(".")
            ? `*${extension}`
            : extension;
      patterns.push(`ios/Playground/**/${suffix}`);
      patterns.push(`ios/auto-mobile-sdk/**/${suffix}`);
    }
  }
  patterns.push("ios/auto-mobile-sdk/**/*.pbxproj");

  expect(validateDerivedDataCacheKeyPatterns(patterns)).toContain(
    "scope 'ios/auto-mobile-sdk/' does not hash '*.xcprivacy' inputs",
  );
});
