import { describe, expect, test } from "bun:test";
import { load } from "js-yaml";
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

  test("runs XCTestRunner when its recording session heartbeat helper changes", () => {
    const filterStep = loadJobSteps(WORKFLOW, "detect-changes").find(
      (step) => step.id === "filter-native-integration",
    );
    const filters = filterStep?.with?.filters;
    expect(typeof filters).toBe("string");

    const nativeIntegration = load(filters as string) as { native_integration?: string[] };
    expect(nativeIntegration.native_integration).toContain(
      "test/helpers/sessionOwnershipHeartbeat.ts",
    );
  });
});
