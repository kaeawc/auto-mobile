import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { load } from "js-yaml";
import {
  iosIntegrationWorkflowChangeError,
  requiresXctestRunnerResult,
} from "../../scripts/ci/validate-ios-integration-workflow-changes";

const workflow = (job: Record<string, unknown>, unrelatedJob: Record<string, unknown> = {}) =>
  JSON.stringify({
    jobs: {
      "ios-xctest-runner-simulator-tests": job,
      "unrelated-job": unrelatedJob,
    },
  });

const originalJob = {
  "runs-on": "macos-26",
  needs: "detect-changes",
  if: "needs.detect-changes.outputs.ios_integration_should_run == 'true'",
  steps: [{ name: "Run test", run: "./scripts/ios/test.sh" }],
};

describe("#4137 iOS integration workflow-change guard", () => {
  test("Fast Validation runs the guard with the PR base SHA and labels", () => {
    const document = load(readFileSync(".github/workflows/pull_request.yml", "utf8")) as {
      jobs?: Record<
        string,
        {
          needs?: string | string[];
          if?: string;
          "timeout-minutes"?: number;
          steps?: {
            name?: string;
            run?: string;
            uses?: string;
            id?: string;
            if?: string;
            env?: Record<string, string>;
          }[];
        }
      >;
    };
    const fastValidation = document.jobs?.["fast-validation"];
    const guard = fastValidation?.steps?.find((step) =>
      step.run?.includes("validate-ios-integration-workflow-changes.ts"),
    );

    expect(guard).toBeDefined();
    expect(guard?.env?.IOS_INTEGRATION_WORKFLOW_BASE_REF).toContain(
      "github.event.pull_request.base.sha",
    );
    expect(guard?.env?.IOS_INTEGRATION_WORKFLOW_LABELS).toContain(
      "toJson(github.event.pull_request.labels.*.name)",
    );
    expect(fastValidation?.needs).toBe("detect-changes");
    expect(fastValidation?.if).toBe("always()");
    expect(fastValidation?.["timeout-minutes"]).toBe(70);
    const waitIndex =
      fastValidation?.steps?.findIndex(
        (step) =>
          step.uses === "actions/github-script@v8" && step.if?.includes("requires_xctest_result"),
      ) ?? -1;
    const versionCheckIndex =
      fastValidation?.steps?.findIndex(
        (step) => step.name === "Check iOS version constant is in sync with package.json",
      ) ?? -1;
    const waitForXctest = fastValidation?.steps?.[waitIndex];
    expect(waitForXctest).toBeDefined();
    expect(waitForXctest?.env?.IOS_INTEGRATION_WORKFLOW_XCTEST_RESULT).toBeUndefined();
    expect(waitIndex).toBeGreaterThan(versionCheckIndex);
  });

  test("does not require a label when the integration job is unchanged", () => {
    expect(
      iosIntegrationWorkflowChangeError(workflow(originalJob), workflow(originalJob), []),
    ).toBeUndefined();
  });

  test("requires run-ios when the integration job's step wiring changes", () => {
    const changedJob = {
      ...originalJob,
      steps: [{ name: "Run test", run: "./scripts/ios/test.sh", timeout: 10 }],
    };

    expect(
      iosIntegrationWorkflowChangeError(workflow(originalJob), workflow(changedJob), []),
    ).toContain("Apply the run-ios label");
  });

  test("accepts run-ios when the integration job changes", () => {
    const changedJob = { ...originalJob, "timeout-minutes": 50 };

    expect(
      iosIntegrationWorkflowChangeError(workflow(originalJob), workflow(changedJob), ["run-ios"]),
    ).toBeUndefined();
  });

  test("accepts run-native when the integration job changes", () => {
    const changedJob = { ...originalJob, "timeout-minutes": 50 };

    expect(
      iosIntegrationWorkflowChangeError(workflow(originalJob), workflow(changedJob), [
        "run-native",
      ]),
    ).toBeUndefined();
  });

  test("requires the forced XCTestRunner job to pass", () => {
    const changedJob = { ...originalJob, "timeout-minutes": 50 };

    expect(
      iosIntegrationWorkflowChangeError(
        workflow(originalJob),
        workflow(changedJob),
        ["run-ios"],
        "failure",
      ),
    ).toContain("did not complete successfully");
    expect(
      iosIntegrationWorkflowChangeError(
        workflow(originalJob),
        workflow(changedJob),
        ["run-ios"],
        "success",
      ),
    ).toBeUndefined();
  });

  test("waits for XCTestRunner only after a labeled workflow-wiring change", () => {
    const changedJob = { ...originalJob, "timeout-minutes": 50 };

    expect(
      requiresXctestRunnerResult(workflow(originalJob), workflow(originalJob), ["run-ios"]),
    ).toBe(false);
    expect(requiresXctestRunnerResult(workflow(originalJob), workflow(changedJob), [])).toBe(false);
    expect(
      requiresXctestRunnerResult(workflow(originalJob), workflow(changedJob), ["run-ios"]),
    ).toBe(true);
  });

  test("does not let a force label bypass removal of the integration job", () => {
    expect(
      iosIntegrationWorkflowChangeError(workflow(originalJob), JSON.stringify({ jobs: {} }), [
        "run-ios",
      ]),
    ).toContain("cannot be forced");
  });

  test("does not let a force label bypass a changed integration-job condition", () => {
    const disabledJob = { ...originalJob, if: "false" };

    expect(
      iosIntegrationWorkflowChangeError(workflow(originalJob), workflow(disabledJob), [
        "run-native",
      ]),
    ).toContain("cannot be forced");
  });

  test("does not require a label for unrelated workflow job changes", () => {
    expect(
      iosIntegrationWorkflowChangeError(
        workflow(originalJob, { steps: [{ run: "echo before" }] }),
        workflow(originalJob, { steps: [{ run: "echo after" }] }),
        [],
      ),
    ).toBeUndefined();
  });

  test("requires a label when the XCTestRunner producer wiring changes", () => {
    const base = JSON.stringify({
      jobs: {
        "ios-xctest-runner-simulator-tests": originalJob,
        "detect-changes": {
          steps: [{ id: "ios_integration_should_run", run: "echo should_run=true" }],
        },
      },
    });
    const head = JSON.stringify({
      jobs: {
        "ios-xctest-runner-simulator-tests": originalJob,
        "detect-changes": {
          steps: [{ id: "ios_integration_should_run", run: "echo should_run=false" }],
        },
      },
    });

    expect(iosIntegrationWorkflowChangeError(base, head, [])).toContain("Apply the run-ios label");
  });

  test("requires a label when the XCTestRunner output binding changes", () => {
    const base = JSON.stringify({
      jobs: {
        "ios-xctest-runner-simulator-tests": originalJob,
        "detect-changes": {
          outputs: {
            ios_integration_should_run:
              "${{ steps.ios_integration_should_run.outputs.should_run }}",
          },
          steps: [],
        },
      },
    });
    const head = JSON.stringify({
      jobs: {
        "ios-xctest-runner-simulator-tests": originalJob,
        "detect-changes": {
          outputs: { ios_integration_should_run: "${{ steps.ios_should_run.outputs.should_run }}" },
          steps: [],
        },
      },
    });

    expect(iosIntegrationWorkflowChangeError(base, head, [])).toContain("Apply the run-ios label");
  });

  test("does not let a force label bypass a changed XCTestRunner producer output", () => {
    const base = JSON.stringify({
      jobs: {
        "ios-xctest-runner-simulator-tests": originalJob,
        "detect-changes": {
          outputs: {
            ios_integration_should_run:
              "${{ steps.ios_integration_should_run.outputs.should_run }}",
          },
          steps: [{ id: "ios_integration_should_run", run: "echo should_run=true" }],
        },
      },
    });
    const head = JSON.stringify({
      jobs: {
        "ios-xctest-runner-simulator-tests": originalJob,
        "detect-changes": {
          outputs: { ios_integration_should_run: "false" },
          steps: [{ id: "ios_integration_should_run", run: "echo should_run=true" }],
        },
      },
    });

    expect(iosIntegrationWorkflowChangeError(base, head, ["run-ios"], "skipped")).toContain(
      "did not complete successfully",
    );
  });

  test("does not let a force label bypass removal of the labeled trigger", () => {
    const base = JSON.stringify({
      on: { pull_request: { types: ["opened", "labeled"] } },
      jobs: {
        "ios-xctest-runner-simulator-tests": originalJob,
      },
    });
    const head = JSON.stringify({
      on: { pull_request: { types: ["opened"] } },
      jobs: {
        "ios-xctest-runner-simulator-tests": originalJob,
      },
    });

    expect(iosIntegrationWorkflowChangeError(base, head, ["run-ios"], "success")).toContain(
      "cannot be forced",
    );
  });

  test("rejects addition or removal of the integration job until its execution gate is reviewed", () => {
    expect(
      iosIntegrationWorkflowChangeError(JSON.stringify({ jobs: {} }), workflow(originalJob), []),
    ).toContain("cannot be forced");
    expect(
      iosIntegrationWorkflowChangeError(workflow(originalJob), JSON.stringify({ jobs: {} }), []),
    ).toContain("cannot be forced");
  });
});
