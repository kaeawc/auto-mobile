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
      "pull_request.yml:node-unit-timing-budget",
    );
    expect(callers.map(({ file, id }) => `${file}:${id}`)).toContain("merge.yml:node-unit-tests");
  });

  for (const { file, id, job, step, index } of callers) {
    test(`${file}:${id} leaves time for setup, prior tests, and the verdict`, () => {
      const env = { ...job.env, ...step.env };
      const budget = Number(env.BUN_TEST_TIMING_RECHECK_BUDGET_SECONDS ?? 600);
      const priorLanes = (job.steps ?? [])
        .slice(0, index)
        .filter((prior) => prior.run?.includes("scripts/test-ts.sh unit"));
      let priorSeconds = 0;
      for (const lane of priorLanes) {
        const wall = Number(lane.env?.AUTOMOBILE_TEST_WALL_TIMEOUT_SECONDS);
        expect(Number.isInteger(wall) && wall > 0).toBe(true);
        priorSeconds += wall;
      }
      // The combined main job has no artifact download; reserve two minutes.
      // Standalone/prepush jobs reserve three. Include the unit lane's full
      // configured allowance, rather than assuming it finishes quickly.
      const margin = priorLanes.length > 0 ? 120 : 180;
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
