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
    expect(
      steps.some(
        (step) => typeof step.if === "string" && step.if.includes("requires_xctest_result"),
      ),
    ).toBe(false);
    expect(steps.some((step) => step.name?.includes("forced XCTestRunner"))).toBe(false);
  });

  test("calls the shared XCTestRunner simulator workflow on label opt-in or SDK contract inputs", () => {
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
    expect(decide?.env?.CONTRACT_INPUTS).toContain("filter-ios-sdk-contract");
    // The path filter that used to auto-run the lane on src/** is gone (#10895).
    expect(
      loadJobSteps(WORKFLOW, "detect-changes").some(
        (step) => step.id === "filter-native-integration",
      ),
    ).toBe(false);
  });

  test("auto-runs the lane only for layers the iOS SDK contract suite crosses (#5164)", () => {
    const filter = loadJobSteps(WORKFLOW, "detect-changes").find(
      (step) => step.id === "filter-ios-sdk-contract",
    );
    const filters = load(String(filter?.with?.filters ?? "")) as { ios_sdk_contract?: string[] };
    const paths = filters.ios_sdk_contract ?? [];
    expect(paths).toContain("src/features/observe/ios/**");
    expect(paths).toContain("ios/auto-mobile-sdk/Sources/**");
    expect(paths).toContain("ios/control-proxy/Sources/**");
    // Broad trees would bring back the PR-minute cost #10895 removed.
    for (const broad of ["src/**", "ios/**", "test/**"]) {
      expect(paths).not.toContain(broad);
    }
    const steps = loadJobSteps(XCTESTRUNNER_WORKFLOW, "ios-xctest-runner-simulator-tests");
    expect(steps.find((step) => step.name === "Run iOS SDK contract suite")?.run).toContain(
      "sdk-contract-integration.sh",
    );
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

describe("advisory watchOS simulator smoke", () => {
  const watchWorkflow = ".github/workflows/watchos-sim-smoke.yml";

  test("runs standalone on nightly, dispatch and labelled PR updates", () => {
    const document = load(readFileSync(join(repoRoot, watchWorkflow), "utf8")) as {
      on: {
        schedule: { cron: string }[];
        workflow_dispatch: unknown;
        pull_request: { types: string[] };
      };
    };
    expect(document.on.schedule).toHaveLength(1);
    expect(document.on).toHaveProperty("workflow_dispatch");
    expect(document.on.pull_request.types).toEqual([
      "opened",
      "synchronize",
      "reopened",
      "labeled",
    ]);
    const job = loadWorkflow(watchWorkflow).jobs?.["watchos-sim-smoke"];
    expect(job?.["runs-on"]).toBe("macos-26");
    expect(job?.if).toBe(
      "github.event_name != 'pull_request' || contains(github.event.pull_request.labels.*.name, 'run-watchos-sim')",
    );
    expect(job?.needs).toBeUndefined();
    expect(Object.keys(loadWorkflow(watchWorkflow).jobs ?? {})).toEqual(["watchos-sim-smoke"]);
    expect(JSON.stringify(loadWorkflow(WORKFLOW))).not.toContain("watchos-sim-smoke");
  });

  test("pins Xcode and preserves private namespace and failure artifacts", () => {
    const steps = loadJobSteps(watchWorkflow, "watchos-sim-smoke");
    expect(steps.find((step) => step.name === "Select Xcode 26.5")?.with?.["xcode-version"]).toBe(
      "26.5",
    );
    expect(steps.find((step) => step.name === "Ensure watchOS runtime")?.run).toContain(
      "xcodebuild -downloadPlatform watchOS",
    );
    const smoke = steps.find((step) => step.name === "Run watch smoke");
    expect(smoke?.run).toContain('mktemp -d "${RUNNER_TEMP}/watch-aux.XXXXXX"');
    expect(smoke?.run).toContain('watch-smoke-lane.sh "${WATCH_SMOKE_VERSION}"');
    const upload = steps.find((step) => step.uses?.startsWith("actions/upload-artifact@"));
    expect(upload?.if).toBe("failure()");
    expect(upload?.with?.path).toContain("scratch/watch-smoke-lane/");
    expect(upload?.with?.path).toContain("!scratch/watch-smoke-lane/**/derived-data/**");
  });
});
