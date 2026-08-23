import { readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { loadAllJobSteps } from "../helpers/workflowSteps";

// A `wait` barrier does not accept `if:`. Adding one is not a step-level error
// that skips the step — it fails whole-workflow validation, so the run dies at
// startup with zero jobs and no annotation pointing at the offending line
// (#4130: run 29912090109 finished `failure` in 0s). Nothing local catches it,
// hence this guard.
//
// A barrier needs no condition anyway: when the guarded background steps are
// themselves skipped, there is simply nothing outstanding for it to join.

const WORKFLOW_DIR = ".github/workflows";

const workflows = readdirSync(join(import.meta.dir, "../..", WORKFLOW_DIR))
  .filter((name) => name.endsWith(".yml") || name.endsWith(".yaml"))
  .map((name) => `${WORKFLOW_DIR}/${name}`);

describe("parallel-steps wait barriers", () => {
  test("there are workflows to check", () => {
    expect(workflows.length).toBeGreaterThan(0);
  });

  for (const workflow of workflows) {
    test(`no wait step in ${workflow} carries an if:`, () => {
      const offenders = loadAllJobSteps(workflow)
        .filter(({ step }) => step.wait !== undefined && step.if !== undefined)
        .map(({ jobId, step }) => `${jobId}: wait ${JSON.stringify(step.wait)}`);

      expect(offenders).toEqual([]);
    });
  }
});
