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

function collectForbiddenCachePaths(entries: string[]): string[] {
  return entries.filter((entry) => {
    const path = entry.replace(/\/+$/, "");
    return path.split("/").some((segment) => segment === ".build" || segment === "SourcePackages");
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
    ]);
  });
});
