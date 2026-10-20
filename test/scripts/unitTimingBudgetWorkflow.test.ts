import { describe, expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { loadJobs } from "../helpers/workflowSteps";

const workflowDir = join(import.meta.dir, "../../.github/workflows");
// Parse once outside timed tests. Discover direct and prepush callers so a new
// workflow cannot silently inherit the validator's 600s local default.
const callers = readdirSync(workflowDir)
  .filter((file) => /\.ya?ml$/.test(file))
  .flatMap((file) =>
    Object.entries(loadJobs(`.github/workflows/${file}`)).flatMap(([id, job]) =>
      (job.steps ?? []).flatMap((step, index) =>
        /scripts\/(?:validate-bun-test-timings|prepush-node)\.sh/.test(step.run ?? "")
          ? [{ file, id, job, step, index }]
          : [],
      ),
    ),
  );

describe("unit timing validator workflow budgets", () => {
  test("discovers both existing timing gates", () => {
    expect(callers.map(({ file, id }) => `${file}:${id}`)).toContain(
      "pull_request.yml:ts-build-and-test",
    );
    expect(callers.map(({ file, id }) => `${file}:${id}`)).toContain("merge.yml:ts-code-coverage");
  });

  for (const { file, id, job, step, index } of callers) {
    test(`${file}:${id} leaves time for setup, prior tests, and the verdict`, () => {
      const env = { ...job.env, ...step.env };
      const budget = Number(env.BUN_TEST_TIMING_RECHECK_BUDGET_SECONDS ?? 600);
      const priorLanes = (job.steps ?? [])
        .slice(0, index)
        .filter((prior) =>
          /scripts\/(?:test-ts.sh unit|ci\/run-ts-coverage.sh)/.test(prior.run ?? ""),
        );
      let priorSeconds = 0;
      for (const lane of priorLanes) {
        const wall = Number(lane.env?.AUTOMOBILE_TEST_WALL_TIMEOUT_SECONDS);
        expect(Number.isInteger(wall) && wall > 0).toBe(true);
        // A timed-out or signalled shard is retried once (#10583), so the lane
        // can run up to its cap: 2 x (wall + 60s attempt overhead) by default.
        const laneCap = Number(
          lane.env?.AUTOMOBILE_UNIT_LANE_WALL_TIMEOUT_SECONDS ?? 2 * (wall + 60),
        );
        expect(Number.isInteger(laneCap) && laneCap >= wall).toBe(true);
        priorSeconds += laneCap;
      }
      // Coverage setup builds and globally installs the package; also reserve
      // post-lane probes, merging and badge work. Other combined jobs reserve
      // two minutes, standalone/prepush jobs three.
      const margin =
        file === "merge.yml" && id === "ts-code-coverage" ? 480 : priorLanes.length > 0 ? 120 : 180;
      expect(Number.isInteger(budget) && budget > 0).toBe(true);
      expect(budget + priorSeconds + margin).toBeLessThan(Number(job["timeout-minutes"]) * 60);
      // Direct CI gates must reuse the completed lane, avoiding an unaccounted
      // second initial test run before the recheck clock starts.
      if (step.run?.includes("scripts/validate-bun-test-timings.sh")) {
        expect(env.BUN_TEST_TIMING_REPORT_DIR).toBeTruthy();
      }
    });
  }
});

const prJobs = loadJobs(".github/workflows/pull_request.yml");
// The required Ubuntu job is the one Linux unit run per PR (#10893).
const budgetSteps = prJobs["ts-build-and-test"].steps ?? [];

test("timing budget runs on the leg that produced the reports, not a separate job", () => {
  // A separate job cost a runner slot, queue wait, checkout and bun install
  // per PR just to download these JUnit reports.
  expect(prJobs["node-unit-timing-budget"]).toBeUndefined();
  // No other PR job runs the timing validator (the Windows unit lane is in
  // mcp-build-and-test, #10894).
  expect(
    Object.entries(prJobs)
      .filter(([id]) => id !== "ts-build-and-test")
      .some(([, job]) =>
        (job.steps ?? []).some((step) =>
          step.run?.includes("scripts/validate-bun-test-timings.sh"),
        ),
      ),
  ).toBe(false);
  const laneIndex = budgetSteps.findIndex((step) =>
    step.run?.includes("bash scripts/test-ts.sh unit"),
  );
  const enforceIndex = budgetSteps.findIndex((step) =>
    step.run?.includes("scripts/validate-bun-test-timings.sh"),
  );
  const enforce = budgetSteps[enforceIndex];
  expect(laneIndex).toBeGreaterThanOrEqual(0);
  expect(enforceIndex).toBeGreaterThan(laneIndex);
  expect(enforce?.if).toBeUndefined();
  expect(enforce?.env?.BUN_TEST_TIMING_REPORT_DIR).toBe(
    budgetSteps[laneIndex].env?.AUTOMOBILE_UNIT_JUNIT_DIR,
  );
  expect(enforce?.env?.BUN_TEST_TIMING_BASE_REF).toBe("${{ github.event.pull_request.base.sha }}");
});

test("timing budget uploads its summary after enforcement even on failure", () => {
  const enforceIndex = budgetSteps.findIndex((step) =>
    step.run?.includes("scripts/validate-bun-test-timings.sh"),
  );
  const uploadIndex = budgetSteps.findIndex(
    (step) => step.with?.name === "node-unit-timing-budget-summary",
  );
  expect(enforceIndex).toBeGreaterThanOrEqual(0);
  expect(uploadIndex).toBeGreaterThan(enforceIndex);
  const upload = budgetSteps[uploadIndex];
  expect(upload.uses).toBe("actions/upload-artifact@v6");
  expect(upload.if).toBe("always() && !cancelled()");
  expect(upload.with).toEqual({
    name: "node-unit-timing-budget-summary",
    path: "scratch/timing-unit-reports/unit-timing-budget-summary.md",
    "if-no-files-found": "ignore",
    "retention-days": 7,
  });
});

const mergeJobs = loadJobs(".github/workflows/merge.yml");
const coverage = mergeJobs["ts-code-coverage"];
const coverageSteps = coverage.steps ?? [];

test("merge coverage owns the Ubuntu unit gate and plain isolated timing verdict", () => {
  expect(mergeJobs["node-unit-tests"].strategy?.matrix?.os).toEqual(["windows-latest"]);
  expect(
    mergeJobs["node-unit-tests"].steps?.some((s) => s.run?.includes("validate-bun-test-timings")),
  ).toBe(false);
  const windows = mergeJobs["node-unit-tests"];
  expect(
    windows.steps?.find((s) => s.uses === "actions/checkout@v6")?.with?.["fetch-depth"],
  ).toBeUndefined();
  expect(windows.steps?.some((s) => s.env?.AUTOMOBILE_UNIT_JUNIT_DIR)).toBe(false);
  expect(coverage["timeout-minutes"]).toBe(45);
  expect(coverage["runs-on"]).toBe("ubuntu-latest");
  expect(coverage.permissions).toEqual({ actions: "write", contents: "read" });
  expect(coverageSteps.find((s) => s.uses === "actions/checkout@v6")?.with?.["fetch-depth"]).toBe(
    2,
  );
  const lane = coverageSteps.findIndex((s) => s.run?.includes("ci/run-ts-coverage.sh"));
  const timing = coverageSteps.findIndex((s) => s.run?.includes("validate-bun-test-timings.sh"));
  expect(lane).toBeGreaterThanOrEqual(0);
  expect(coverageSteps[lane].env).toEqual({
    AUTOMOBILE_TEST_MODE: "true",
    AUTOMOBILE_TEST_WALL_TIMEOUT_SECONDS: "720",
    AUTOMOBILE_UNIT_LANE_WALL_TIMEOUT_SECONDS: "1560",
  });
  const badge = coverageSteps.findIndex((s) => s.name === "Upload Coverage Badge");
  expect(badge).toBeGreaterThan(lane);
  expect(timing).toBeGreaterThan(badge);
  expect(coverageSteps[timing].if).toBeUndefined();
  expect(coverageSteps[timing].env).toEqual({
    AUTOMOBILE_TEST_MODE: "true",
    BUN_TEST_TIMING_BASE_REF: "HEAD^",
    BUN_TEST_TIMING_REPORT_DIR: "coverage/shards",
    BUN_TEST_TIMING_REPORTS_INSTRUMENTED: "true",
    BUN_TEST_TIMING_RECHECK_BUDGET_SECONDS: "600",
  });
  const diagnostics = coverageSteps.findIndex((s) => s.with?.name === "ts-coverage-diagnostics");
  expect(diagnostics).toBeGreaterThan(timing);
  expect(coverageSteps[diagnostics].if).toBe("always()");
  expect(coverageSteps[diagnostics].with?.path).toContain("coverage/shards/**");
  expect(coverageSteps[diagnostics].with?.path).toContain("scratch/bun-test-report.recheck.d/**");
  const dispatch = coverageSteps.at(-1);
  expect(dispatch?.run).toBe(
    'bash scripts/ci/rerun-contended-runner.sh dispatch "$GITHUB_STEP_SUMMARY" "$RUN_ID" "$RUN_ATTEMPT"',
  );
  expect(dispatch?.if).toContain("failure()");
  expect(dispatch?.env).toEqual({
    GH_TOKEN: "${{ github.token }}",
    REPO: "${{ github.repository }}",
    RUN_ID: "${{ github.run_id }}",
    RUN_ATTEMPT: "${{ github.run_attempt }}",
  });
});
