import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { load } from "js-yaml";
import { iosIntegrationWorkflowChangeError } from "../../scripts/ci/validate-ios-integration-workflow-changes";

const workflow = (job: Record<string, unknown>, unrelatedJob: Record<string, unknown> = {}) =>
  JSON.stringify({
    jobs: {
      "ios-xctest-runner-simulator-tests": job,
      "unrelated-job": unrelatedJob,
    },
  });

const originalJob = {
  "runs-on": "macos-26",
  "needs": "detect-changes",
  "if": "needs.detect-changes.outputs.ios_integration_should_run == 'true'",
  "steps": [{ name: "Run test", run: "./scripts/ios/test.sh" }],
};

describe("#4137 iOS integration workflow-change guard", () => {
  test("Fast Validation runs the guard with the PR base SHA and labels", () => {
    const document = load(readFileSync(".github/workflows/pull_request.yml", "utf8")) as {
      jobs?: Record<string, { steps?: { name?: string; run?: string; env?: Record<string, string> }[] }>;
    };
    const guard = document.jobs?.["fast-validation"]?.steps?.find(step =>
      step.run?.includes("validate-ios-integration-workflow-changes.ts")
    );

    expect(guard).toBeDefined();
    expect(guard?.env?.IOS_INTEGRATION_WORKFLOW_BASE_REF).toContain("github.event.pull_request.base.sha");
    expect(guard?.env?.IOS_INTEGRATION_WORKFLOW_LABELS).toContain("toJson(github.event.pull_request.labels.*.name)");
    expect(document.jobs?.["fast-validation"]?.needs).toContain("ios-integration-workflow-change-gate");
    expect(document.jobs?.["fast-validation"]?.if).toBe("always()");
  });

  test("does not require a label when the integration job is unchanged", () => {
    expect(iosIntegrationWorkflowChangeError(workflow(originalJob), workflow(originalJob), [])).toBeUndefined();
  });

  test("requires run-ios when the integration job's step wiring changes", () => {
    const changedJob = {
      ...originalJob,
      steps: [{ name: "Run test", run: "./scripts/ios/test.sh", timeout: 10 }],
    };

    expect(iosIntegrationWorkflowChangeError(workflow(originalJob), workflow(changedJob), [])).toContain(
      "Apply the run-ios label"
    );
  });

  test("accepts run-ios when the integration job changes", () => {
    const changedJob = { ...originalJob, "timeout-minutes": 50 };

    expect(iosIntegrationWorkflowChangeError(workflow(originalJob), workflow(changedJob), ["run-ios"])).toBeUndefined();
  });

  test("accepts run-native when the integration job changes", () => {
    const changedJob = { ...originalJob, "timeout-minutes": 50 };

    expect(iosIntegrationWorkflowChangeError(workflow(originalJob), workflow(changedJob), ["run-native"])).toBeUndefined();
  });

  test("requires the forced XCTestRunner job to pass", () => {
    const changedJob = { ...originalJob, "timeout-minutes": 50 };

    expect(
      iosIntegrationWorkflowChangeError(workflow(originalJob), workflow(changedJob), ["run-ios"], "failure")
    ).toContain("did not complete successfully");
    expect(
      iosIntegrationWorkflowChangeError(workflow(originalJob), workflow(changedJob), ["run-ios"], "success")
    ).toBeUndefined();
  });

  test("does not let a force label bypass removal of the integration job", () => {
    expect(
      iosIntegrationWorkflowChangeError(workflow(originalJob), JSON.stringify({ jobs: {} }), ["run-ios"])
    ).toContain("cannot be forced");
  });

  test("does not let a force label bypass a changed integration-job condition", () => {
    const disabledJob = { ...originalJob, if: "false" };

    expect(iosIntegrationWorkflowChangeError(workflow(originalJob), workflow(disabledJob), ["run-native"])).toContain(
      "cannot be forced"
    );
  });

  test("does not require a label for unrelated workflow job changes", () => {
    expect(
      iosIntegrationWorkflowChangeError(
        workflow(originalJob, { steps: [{ run: "echo before" }] }),
        workflow(originalJob, { steps: [{ run: "echo after" }] }),
        []
      )
    ).toBeUndefined();
  });

  test("requires a label when the XCTestRunner producer wiring changes", () => {
    const base = JSON.stringify({ jobs: {
      "ios-xctest-runner-simulator-tests": originalJob,
      "detect-changes": { steps: [{ id: "ios_integration_should_run", run: "echo should_run=true" }] },
    } });
    const head = JSON.stringify({ jobs: {
      "ios-xctest-runner-simulator-tests": originalJob,
      "detect-changes": { steps: [{ id: "ios_integration_should_run", run: "echo should_run=false" }] },
    } });

    expect(iosIntegrationWorkflowChangeError(base, head, [])).toContain("Apply the run-ios label");
  });

  test("rejects addition or removal of the integration job until its execution gate is reviewed", () => {
    expect(
      iosIntegrationWorkflowChangeError(JSON.stringify({ jobs: {} }), workflow(originalJob), [])
    ).toContain("cannot be forced");
    expect(
      iosIntegrationWorkflowChangeError(workflow(originalJob), JSON.stringify({ jobs: {} }), [])
    ).toContain("cannot be forced");
  });
});
