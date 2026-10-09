import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { load } from "js-yaml";
import { loadJobSteps, loadWorkflow } from "../helpers/workflowSteps";

const repoRoot = join(import.meta.dir, "../..");
const CIRCLE_CONTINUE = ".circleci/continue_config.yml";

const WORKFLOW = ".github/workflows/pull_request.yml";
const NIGHTLY_WORKFLOW = ".github/workflows/nightly.yml";
const XCTESTRUNNER_WORKFLOW = ".github/workflows/xctestrunner-simulator-tests.yml";

describe("Fast Validation independence from XCTestRunner", () => {
  test("keeps the formatter gate without forcing or waiting for XCTestRunner", () => {
    const fastValidation = loadWorkflow(WORKFLOW).jobs?.["fast-validation"];
    const steps = loadJobSteps(WORKFLOW, "fast-validation");

    expect(fastValidation?.needs).toEqual(["detect-changes"]);
    expect(fastValidation?.if).toBe("always()");
    expect(fastValidation?.["timeout-minutes"]).toBe(20);
    expect(steps.some((step) => step.id === "validate-ios-workflow-change")).toBe(false);
    expect(steps.some((step) => step.if?.includes("requires_xctest_result"))).toBe(false);
    expect(steps.some((step) => step.name?.includes("forced XCTestRunner"))).toBe(false);
  });

  test("calls the shared XCTestRunner simulator workflow only on label opt-in (#10895)", () => {
    const job = loadWorkflow(WORKFLOW).jobs?.["ios-xctest-runner-simulator-tests"];
    expect(job).toBeDefined();
    expect(job?.uses).toBe(`./${XCTESTRUNNER_WORKFLOW}`);
    expect(job?.needs).toEqual(["detect-changes", "fast-validation"]);
    expect(job?.if).toContain("ios_sim_tests_should_run");
    expect(job?.if).toContain("fast-validation.result == 'success'");
    expect(
      loadJobSteps(XCTESTRUNNER_WORKFLOW, "ios-xctest-runner-simulator-tests").length,
    ).toBeGreaterThan(0);

    const decide = loadJobSteps(WORKFLOW, "detect-changes").find(
      (step) => step.id === "ios_sim_tests_should_run",
    );
    expect(decide?.env?.OPT_IN).toContain("'run-ios-sim'");
    // The path filter that used to auto-run the lane on src/** is gone.
    expect(
      loadJobSteps(WORKFLOW, "detect-changes").some(
        (step) => step.id === "filter-native-integration",
      ),
    ).toBe(false);
  });

  test("runs the XCTestRunner simulator lane nightly on CircleCI, not hosted GitHub (#11010)", () => {
    expect(loadWorkflow(NIGHTLY_WORKFLOW).jobs?.["xctestrunner-simulator-tests"]).toBeUndefined();
    const circle = load(readFileSync(join(repoRoot, CIRCLE_CONTINUE), "utf8")) as {
      jobs?: Record<string, unknown>;
      workflows?: Record<string, { when?: string; jobs?: unknown[] }>;
    };
    expect(circle.jobs?.["xctestrunner-simulator-tests"]).toBeDefined();
    const nightly = circle.workflows?.["nightly-macos"];
    expect(nightly?.when).toBe("<< pipeline.parameters.run-nightly-macos >>");
    expect(JSON.stringify(nightly?.jobs?.[0])).toContain("xctestrunner-simulator-tests");
  });

  test("keeps the advisory XCTestRunner job out of every job's needs", () => {
    const jobs = loadWorkflow(WORKFLOW).jobs ?? {};
    for (const [jobId, job] of Object.entries(jobs)) {
      if (jobId === "ios-xctest-runner-simulator-tests") {
        continue;
      }
      const needs = Array.isArray(job?.needs) ? job.needs : [job?.needs];
      expect(needs).not.toContain("ios-xctest-runner-simulator-tests");
    }
  });
});
