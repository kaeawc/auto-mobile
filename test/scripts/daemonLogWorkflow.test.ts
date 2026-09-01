import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { loadJobSteps, loadWorkflow, stepNamed } from "../helpers/workflowSteps";

const PULL_REQUEST_WORKFLOW = ".github/workflows/pull_request.yml";
const MERGE_WORKFLOW = ".github/workflows/merge.yml";
const CI_LOG_DIR = "${{ github.workspace }}/ci-logs/daemon-logs";
const BENCHMARK_SCRIPT = "scripts/benchmark-startup.sh";

describe("daemon log artifact wiring", () => {
  test("removed development installer jobs leave no daemon-log artifact wiring", () => {
    const pullRequestJob = loadWorkflow(PULL_REQUEST_WORKFLOW).jobs?.["installer-development"];
    const mergeJob = loadWorkflow(MERGE_WORKFLOW).jobs?.["installer-development"];

    expect(pullRequestJob).toBeUndefined();
    expect(mergeJob).toBeUndefined();
  });

  test("XCTestRunner uploads the same explicit directory inherited by AutoMobile", () => {
    const job = loadWorkflow(PULL_REQUEST_WORKFLOW).jobs?.["ios-xctest-runner-simulator-tests"];
    const steps = loadJobSteps(PULL_REQUEST_WORKFLOW, "ios-xctest-runner-simulator-tests");

    expect(job?.env?.AUTOMOBILE_LOG_DIR).toBe(CI_LOG_DIR);
    expect(stepNamed(steps, "Collect AutoMobile daemon logs")).toBeUndefined();
    expect(stepNamed(steps, "Upload AutoMobile daemon logs")?.with?.path).toBe(
      "ci-logs/daemon-logs/",
    );
  });
});

describe("startup benchmark log wiring", () => {
  test("delegates configured overrides to the canonical runtime resolver", () => {
    const script = readFileSync(BENCHMARK_SCRIPT, "utf8");

    expect(script).toContain(
      '[[ "${AUTOMOBILE_LOG_DIR+x}" == "x" || "${AUTO_MOBILE_LOG_DIR+x}" == "x" ]]',
    );
    expect(script).toContain('AUTOMOBILE_LOG_DIR="$(bun scripts/resolve-auto-mobile-log-dir.ts)"');
  });
});
