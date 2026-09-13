import { describe, expect, test } from "bun:test";
import { load } from "js-yaml";
import {
  loadAllJobSteps,
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
  const opaqueSegment = segment.replace(/\$\{\{.*?\}\}/g, "<github-expression>");
  let pattern = "";
  for (let index = 0; index < opaqueSegment.length; index += 1) {
    const character = opaqueSegment[index];
    if (character === "*") {
      pattern += ".*";
    } else if (character === "?") {
      pattern += ".";
    } else if (character === "[") {
      const closingBracket = opaqueSegment.indexOf("]", index + 1);
      if (closingBracket === -1) {
        pattern += "\\[";
        continue;
      }

      const classBody = opaqueSegment.slice(index + 1, closingBracket);
      const negated = classBody.startsWith("!") || classBody.startsWith("^");
      const classCharacters = negated ? classBody.slice(1) : classBody;
      if (classCharacters.length === 0) {
        pattern += "\\[";
        continue;
      }

      const escapedClass = classCharacters.replace(/[\\[\]^]/g, "\\$&");
      pattern += `[${negated ? "^" : ""}${escapedClass}]`;
      index = closingBracket;
    } else {
      pattern += character.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(`^${pattern}$`).test(literal);
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
    ".github/workflows/pull_request.yml",
    ".github/workflows/merge.yml",
    ".github/workflows/nightly.yml",
  ]) {
    test(`${workflow} excludes SwiftPM build and package resolution state`, () => {
      const { cacheStepCount, entries } = loadWorkflowCachePaths(workflow);

      expect(cacheStepCount).toBeGreaterThan(0);
      expect(collectForbiddenCachePaths(entries)).toEqual([]);
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
    expect(globMatchesLiteral("[a-z]ourcePackages", "SourcePackages")).toBe(false);
    expect(globMatchesLiteral("[a-z]ourcePackages", "sourcePackages")).toBe(true);
    expect(globMatchesLiteral("[!.]build", ".build")).toBe(false);
    expect(globMatchesLiteral("[^.]build", ".build")).toBe(false);
    expect(globMatchesLiteral(".b*ild", ".build")).toBe(true);
    expect(globMatchesLiteral(".b?ild", ".build")).toBe(true);

    expect(collectForbiddenCachePaths(["ios/**/[.]build/**"])).toEqual(["ios/**/[.]build/**"]);
  });
});
