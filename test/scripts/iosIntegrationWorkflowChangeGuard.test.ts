import { describe, expect, test } from "bun:test";
import { loadJobSteps, loadWorkflow } from "../helpers/workflowSteps";

const WORKFLOW = ".github/workflows/pull_request.yml";

describe("Fast Validation independence from XCTestRunner", () => {
  test("keeps the formatter gate without forcing or waiting for XCTestRunner", () => {
    const fastValidation = loadWorkflow(WORKFLOW).jobs?.["fast-validation"];
    const steps = loadJobSteps(WORKFLOW, "fast-validation");

    expect(fastValidation?.needs).toEqual(["detect-changes", "format-check"]);
    expect(fastValidation?.if).toBe("always()");
    expect(fastValidation?.["timeout-minutes"]).toBe(20);
    expect(steps.some((step) => step.id === "validate-ios-workflow-change")).toBe(false);
    expect(steps.some((step) => step.if?.includes("requires_xctest_result"))).toBe(false);
    expect(steps.some((step) => step.name?.includes("forced XCTestRunner"))).toBe(false);
  });

  test("retains the dedicated XCTestRunner simulator job", () => {
    const job = loadWorkflow(WORKFLOW).jobs?.["ios-xctest-runner-simulator-tests"];
    expect(job).toBeDefined();
    expect(job?.if).toContain("ios_integration_should_run");
    expect(loadJobSteps(WORKFLOW, "ios-xctest-runner-simulator-tests").length).toBeGreaterThan(0);
  });
});
