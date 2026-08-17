import { describe, expect, test } from "bun:test";
import { loadJobSteps, loadJobs, stepNamed } from "../helpers/workflowSteps";

// Guards issue #4155: every job must declare `timeout-minutes`.
//
// A job without one inherits GitHub's default of 360 minutes, so any hang costs
// six hours of runner time before the platform intervenes. `bats-tests` hung on
// #4146 and was cancelled at 6h0m17s, matching that default exactly — the
// underlying bug was a single unbounded `wait`, but the reason it cost six hours
// instead of ten minutes was the missing ceiling.
//
// The ceilings are sized from measured per-job durations (scripts/ci/measure-ci.sh)
// with generous headroom: the goal is catching hangs, not policing slow-but-healthy
// runs, since a too-tight ceiling turns a slow run into a flake.
//
// This lives here rather than in bats because the guard must parse the workflow
// structurally (CLAUDE.md), and `js-yaml` — the repo's structured parser — is
// reachable from bun tests. An earlier bats version shelled out to python3+PyYAML,
// which is not installed on the macOS runner.

const WORKFLOW = ".github/workflows/pull_request.yml";

describe("pull_request job timeouts", () => {
  test("the workflow parses and defines a plausible number of jobs", () => {
    // Without this, a parser returning nothing would pass the check below by
    // finding zero offenders among zero jobs.
    expect(Object.keys(loadJobs(WORKFLOW)).length).toBeGreaterThanOrEqual(20);
  });

  test("every job declares timeout-minutes", () => {
    const missing = Object.entries(loadJobs(WORKFLOW))
      // A `uses:` job delegates to a reusable workflow, where GitHub rejects
      // timeout-minutes on the caller side; requiring one would be unsatisfiable.
      .filter(([, job]) => job.uses === undefined && job["timeout-minutes"] === undefined)
      .map(([id]) => id);

    expect(missing).toEqual([]);
  });

  test("cross-platform Node validation fetches the main comparison ref", () => {
    const checkout = stepNamed(loadJobSteps(WORKFLOW, "mcp-build-and-test"), "Git Checkout");
    expect(checkout?.with?.["fetch-depth"]).toBe(0);
  });

});
