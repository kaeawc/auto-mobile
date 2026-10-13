import { describe, expect, test } from "bun:test";
import { load } from "js-yaml";
import {
  loadAllJobSteps,
  loadJobSteps,
  type WorkflowDefinition,
  type WorkflowStep,
} from "../helpers/workflowSteps";

type JobStep = { jobId: string; step: WorkflowStep };

function collectCachePaths(steps: JobStep[]): { cacheStepCount: number; entries: string[] } {
  const cacheSteps = steps.filter(
    ({ step }) => typeof step.uses === "string" && step.uses.startsWith("actions/cache"),
  );

  return {
    cacheStepCount: cacheSteps.length,
    entries: cacheSteps.flatMap(({ step }) => {
      const path = step.with?.path;
      return typeof path === "string"
        ? path
            .split(/\r?\n/)
            .map((entry) => entry.trim())
            .filter(Boolean)
        : [];
    }),
  };
}

function loadWorkflowCachePaths(workflowRelativePath: string) {
  return collectCachePaths(loadAllJobSteps(workflowRelativePath));
}

function globMatchesLiteral(segment: string, literal: string): boolean {
  const pattern = segment.replace(/\$\{\{.*?\}\}/g, "<github-expression>");
  return new Bun.Glob(pattern).match(literal);
}

function collectForbiddenCachePaths(entries: string[]): string[] {
  return entries.filter((entry) => {
    const path = entry.replace(/\/+$/, "");
    const segments = path.split("/");
    const hasForbiddenSwiftPmState =
      segments[0] === "~" &&
      segments[1] === ".swiftpm" &&
      (segments.length === 2 ||
        (segments.length >= 3 && (segments[2] === "configuration" || segments[2] === "security")));
    return (
      hasForbiddenSwiftPmState ||
      segments.some(
        (segment) =>
          globMatchesLiteral(segment, ".build") || globMatchesLiteral(segment, "SourcePackages"),
      )
    );
  });
}

function allJobSteps(workflow: WorkflowDefinition): JobStep[] {
  return Object.entries(workflow.jobs ?? {}).flatMap(([jobId, job]) =>
    (job?.steps ?? []).map((step) => ({ jobId, step })),
  );
}

describe("workflow cache paths", () => {
  for (const workflow of [
    // nightly.yml lost its macOS (SwiftPM-caching) jobs to CircleCI in #11010.
    ".github/workflows/pull_request.yml",
    ".github/workflows/merge.yml",
  ]) {
    test(`${workflow} excludes SwiftPM build and package resolution state`, () => {
      const { cacheStepCount, entries } = loadWorkflowCachePaths(workflow);

      expect(cacheStepCount).toBeGreaterThan(0);
      expect(collectForbiddenCachePaths(entries)).toEqual([]);
    });
  }

  for (const jobId of [
    "swift-code-coverage",
    "ios-swift-packages",
    "ios-xcode-build",
    "ios-spm-root-package-build",
  ]) {
    test(`${jobId} keeps the self-hosted dependency cache alive after home cleanup`, () => {
      const steps = loadJobSteps(".github/workflows/pull_request.yml", jobId);
      const cache = steps.find((step) => String(step.with?.path).includes("org.swift.swiftpm"));
      expect(cache?.uses).toBe("actions/cache@v5");
      expect(cache?.with?.path).toBe(
        "${{ runner.environment == 'self-hosted' && '../../_temp/automobile-swiftpm-cache' || '~/Library/Caches/org.swift.swiftpm' }}\n" +
          "${{ runner.environment != 'self-hosted' && '~/.swiftpm/cache' || '' }}\n",
      );
      const isolate = steps.find((step) => step.name?.startsWith("Isolate self-hosted"));
      expect(isolate?.if).toBe("runner.environment == 'self-hosted'");
      expect(isolate?.run).toContain(
        'mkdir -p "$RUNNER_TEMP/automobile-swiftpm-cache" "$isolated_home/Library/Caches"',
      );
      expect(isolate?.run).toContain(
        'ln -s "$RUNNER_TEMP/automobile-swiftpm-cache" "$isolated_home/Library/Caches/org.swift.swiftpm"',
      );
      expect(isolate?.run).toContain(
        'if [[ ! "$GITHUB_WORKSPACE/../../_temp/automobile-swiftpm-cache" -ef "$RUNNER_TEMP/automobile-swiftpm-cache" ]]; then',
      );
      expect(isolate?.run).toContain(
        "echo '::warning::SwiftPM cache path does not resolve to RUNNER_TEMP; the dependency cache will not be saved (#11580).'",
      );
      const cleanup = steps.find((step) => step.name?.startsWith("Remove isolated"));
      expect(cleanup?.run).toMatch(
        /^rm -rf -- "\$RUNNER_TEMP\/[a-z-]+-home-\$GITHUB_RUN_ID-\$GITHUB_RUN_ATTEMPT"$/,
      );
      expect(cleanup?.run).not.toContain("automobile-swiftpm-cache");
      expect(steps.indexOf(isolate!)).toBeLessThan(steps.indexOf(cache!));
      expect(steps.indexOf(cache!)).toBeLessThan(steps.indexOf(cleanup!));
      for (const path of collectCachePaths(steps.map((step) => ({ jobId, step }))).entries) {
        expect(path).not.toContain("-home-");
      }
    });
  }

  test("detects forbidden quoted and chomped cache paths", () => {
    // The former awk guard interpreted these valid YAML scalar forms as safe.
    const workflow = load(`
jobs:
  cache:
    steps:
      - uses: actions/cache@v4
        with:
          path: "ios/control-proxy/.build"
      - uses: actions/cache@v5
        with:
          path: |-
            ios/Package.swift/.build
            ios/SourcePackages
            ios/control-proxy/.build/workspace-state.json
            \${{ runner.temp }}/DerivedData/SourcePackages/**
            ios/x/.build/**
            ios/**/.build*
            \${{ runner.temp }}/DerivedData/SourcePackages*
            ~/.swiftpm
            ~/.swiftpm/security
            ~/.swiftpm/configuration
            ~/.swiftpm/cache
`) as WorkflowDefinition;

    const { cacheStepCount, entries } = collectCachePaths(allJobSteps(workflow));

    expect(cacheStepCount).toBe(2);
    expect(collectForbiddenCachePaths(entries)).toEqual([
      "ios/control-proxy/.build",
      "ios/Package.swift/.build",
      "ios/SourcePackages",
      "ios/control-proxy/.build/workspace-state.json",
      "${{ runner.temp }}/DerivedData/SourcePackages/**",
      "ios/x/.build/**",
      "ios/**/.build*",
      "${{ runner.temp }}/DerivedData/SourcePackages*",
      "~/.swiftpm",
      "~/.swiftpm/security",
      "~/.swiftpm/configuration",
    ]);
  });

  test("supports bracket classes when matching forbidden cache paths", () => {
    expect(globMatchesLiteral("[.]build", ".build")).toBe(true);
    expect(globMatchesLiteral("[].]build", ".build")).toBe(true);
    expect(globMatchesLiteral("[a-z]ourcePackages", "SourcePackages")).toBe(false);
    expect(globMatchesLiteral("[a-z]ourcePackages", "sourcePackages")).toBe(true);
    expect(globMatchesLiteral("[!.]build", ".build")).toBe(false);
    expect(globMatchesLiteral("[^.]build", ".build")).toBe(false);
    expect(globMatchesLiteral(".b*ild", ".build")).toBe(true);
    expect(globMatchesLiteral(".b?ild", ".build")).toBe(true);

    expect(collectForbiddenCachePaths(["ios/**/[.]build/**"])).toEqual(["ios/**/[.]build/**"]);
    expect(collectForbiddenCachePaths(["ios/**/[].]build/**"])).toEqual(["ios/**/[].]build/**"]);
  });
});
