import { describe, expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { loadJobs } from "../helpers/workflowSteps";

// Extends #4155 to every workflow other than pull_request.yml, which is covered
// by workflowJobTimeouts.test.ts. Missing ceilings let hangs consume GitHub's
// default six hours of runner time. Job-level uses delegates to a reusable
// workflow: GitHub rejects timeout-minutes on those caller jobs, so they are exempt.

// TODO: Record a reason here for any future intentional exemption.
const ALLOWLIST: Record<string, string> = {};
const repoRoot = join(import.meta.dir, "../..");
const workflows = readdirSync(join(repoRoot, ".github/workflows"))
  .filter((file) => file.endsWith(".yml") && file !== "pull_request.yml")
  .sort();

// Read and parse once at module load so every assertion uses the cached jobs.
const jobs = workflows.flatMap((workflow) =>
  Object.entries(loadJobs(`.github/workflows/${workflow}`)).map(([jobId, job]) => ({
    id: `${workflow}:${jobId}`,
    job,
  })),
);
const checkedJobs = jobs.filter(({ job }) => {
  // Only job-level uses is exempt; step-level uses still needs a job timeout.
  return job.uses === undefined;
});

describe("non-PR workflow job timeouts", () => {
  test("workflows parse and define a plausible number of non-reusable jobs", () => {
    expect(workflows.length).toBeGreaterThanOrEqual(15);
    expect(checkedJobs.length).toBeGreaterThanOrEqual(60);
  });

  test("every non-reusable job declares timeout-minutes", () => {
    const missing = checkedJobs
      .filter(
        ({ id, job }) => job["timeout-minutes"] === undefined && !Object.hasOwn(ALLOWLIST, id),
      )
      .map(({ id }) => id);

    expect(missing).toEqual([]);
  });

  test("every present timeout is a valid duration or expression", () => {
    const invalid = jobs
      .filter(({ job }) => {
        const timeout: unknown = job["timeout-minutes"];
        if (timeout === undefined) {
          return false;
        }
        if (typeof timeout === "number") {
          return !Number.isFinite(timeout) || timeout <= 0 || timeout > 360;
        }
        return typeof timeout !== "string" || !/^\$\{\{\s*\S[\s\S]*\}\}$/.test(timeout);
      })
      .map(({ id }) => id);

    expect(invalid).toEqual([]);
  });

  test("allowlist entries reference existing jobs that still lack a timeout", () => {
    const stale = Object.keys(ALLOWLIST).filter((id) => {
      const entry = checkedJobs.find((candidate) => candidate.id === id);
      return entry === undefined || entry.job["timeout-minutes"] !== undefined;
    });

    expect(stale).toEqual([]);
  });
});
