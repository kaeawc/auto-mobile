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

  test("retains the paused dedicated XCTestRunner simulator job", () => {
    const job = loadWorkflow(WORKFLOW).jobs?.["ios-xctest-runner-simulator-tests"];
    expect(job).toBeDefined();
    expect(job?.if).toBe("${{ false }}");
    expect(loadJobSteps(WORKFLOW, "ios-xctest-runner-simulator-tests").length).toBeGreaterThan(0);
  });

  test("runs Playground tests only with a run-native or run-ios label and iOS and Fast Validation gates", () => {
    const job = loadWorkflow(WORKFLOW).jobs?.["ios-playground-tests"];
    expect(job?.if).toBe(
      "(contains(github.event.pull_request.labels.*.name, 'run-native') || contains(github.event.pull_request.labels.*.name, 'run-ios')) && needs.detect-changes.outputs.ios_should_run == 'true' && needs.fast-validation.result == 'success'",
    );
    expect(loadJobSteps(WORKFLOW, "ios-playground-tests").length).toBeGreaterThan(0);
  });

  test("tracks recording cleanup helpers for future XCTestRunner runs", () => {
    const filterStep = loadJobSteps(WORKFLOW, "detect-changes").find(
      (step) => step.id === "filter-native-integration",
    );
    const filters = filterStep?.with?.filters;
    expect(typeof filters).toBe("string");

    const nativeIntegration = load(filters as string) as { native_integration?: string[] };
    expect(nativeIntegration.native_integration).toContain(
      "test/helpers/sessionOwnershipHeartbeat.ts",
    );
    expect(nativeIntegration.native_integration).toContain(
      "test/helpers/iosVideoRecordingSessionCleanup.ts",
    );
  });
});
