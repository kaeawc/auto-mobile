import { describe, expect, test } from "bun:test";
import { loadJobSteps, loadWorkflow, stepNamed } from "../helpers/workflowSteps";

// Guards the GitHub-hosted (Linux) nightly diagnostics. The macOS nightly lanes,
// including the Xcode sweeps that #4128 parallelized, run on CircleCI since
// #11010 and are guarded by test/scripts/circleciMacosMigrationPolicy.test.ts.

const WORKFLOW = ".github/workflows/nightly.yml";

describe("nightly auto-advance race guard", () => {
  test("keeps the race guard advisory, standalone and exclusive to nightly", () => {
    const nightly = loadWorkflow(WORKFLOW);
    const guard = nightly.jobs?.["auto-advance-race-guard"];
    expect(guard).toBeDefined();
    expect(guard).toHaveProperty("continue-on-error", true);
    expect(guard?.["runs-on"]).toBe("ubuntu-latest");
    expect(guard?.["timeout-minutes"]).toBe(20);
    expect(guard?.needs).toBeUndefined();
    const steps = loadJobSteps(WORKFLOW, "auto-advance-race-guard");
    expect(stepNamed(steps, "Setup Bun")?.with?.["bun-version"]).toBe("1.3.14");
    expect(stepNamed(steps, "Install Bun dependencies")?.run).toBe(
      "scripts/ci/install-bun-deps.sh",
    );
    expect(stepNamed(steps, "Run auto-advance race guard")?.run).toBe(
      "bash scripts/ci/auto-advance-race-guard.sh",
    );
    for (const job of Object.values(nightly.jobs ?? {})) {
      expect(Array.isArray(job?.needs) ? job.needs : [job?.needs]).not.toContain(
        "auto-advance-race-guard",
      );
    }
    for (const workflow of [".github/workflows/pull_request.yml", ".github/workflows/merge.yml"]) {
      expect(loadWorkflow(workflow).jobs?.["auto-advance-race-guard"]).toBeUndefined();
    }
  });
});

describe("nightly randomized unit diagnostic", () => {
  const jobId = "node-randomized-unit-tests";
  const nightly = loadWorkflow(WORKFLOW);
  const job = nightly.jobs?.[jobId];
  const steps = loadJobSteps(WORKFLOW, jobId);

  test("is bounded, advisory, independent and exclusive to nightly", () => {
    expect(job).toHaveProperty("continue-on-error", true);
    expect(job?.["runs-on"]).toBe("ubuntu-latest");
    expect(job?.["timeout-minutes"]).toBe(15);
    expect(job?.needs).toBeUndefined();
    for (const other of Object.values(nightly.jobs ?? {})) {
      expect(Array.isArray(other?.needs) ? other.needs : [other?.needs]).not.toContain(jobId);
    }
    for (const file of ["pull_request.yml", "merge.yml"]) {
      expect(loadWorkflow(`.github/workflows/${file}`).jobs?.[jobId]).toBeUndefined();
    }
  });

  test("runs the canonical selector with a reproducible run-derived seed", () => {
    expect(stepNamed(steps, "Setup Bun")?.with?.["bun-version"]).toBe("1.3.14");
    expect(stepNamed(steps, "Install Bun dependencies")?.run).toBe(
      "scripts/ci/install-bun-deps.sh",
    );
    const run = stepNamed(steps, "Run randomized unit lane");
    expect(run?.run).toBe("bash scripts/test-ts.sh unit");
    expect(run?.env?.AUTOMOBILE_TEST_MODE).toBe("true");
    expect(run?.env?.AUTOMOBILE_UNIT_RANDOM_SEED).toBe("${{ github.run_number }}");
    expect(Number(run?.env?.AUTOMOBILE_TEST_WALL_TIMEOUT_SECONDS)).toBeLessThan(
      (job?.["timeout-minutes"] ?? 0) * 60,
    );
  });
});

describe("nightly unit process recycling", () => {
  // The chunked macOS complete-unit lane moved to CircleCI (#11010); see
  // test/scripts/circleciMacosMigrationPolicy.test.ts.
  test("no GitHub nightly job opts into chunking", () => {
    for (const job of Object.values(loadWorkflow(WORKFLOW).jobs ?? {})) {
      expect(job?.env?.AUTOMOBILE_UNIT_TEST_CHUNK_FILES).toBeUndefined();
      for (const step of job?.steps ?? []) {
        expect(step.env?.AUTOMOBILE_UNIT_TEST_CHUNK_FILES).toBeUndefined();
      }
    }
  });
});

describe("nightly Bun 1.4 canary", () => {
  const jobId = "node-bun-14-canary";
  const workflow = loadWorkflow(WORKFLOW);
  const job = workflow.jobs?.[jobId];
  const steps = loadJobSteps(WORKFLOW, jobId);

  test("is an independent advisory ubuntu job exclusive to nightly", () => {
    expect(job).toHaveProperty("continue-on-error", true);
    expect(job?.["runs-on"]).toBe("ubuntu-latest");
    expect(job?.["timeout-minutes"]).toBe(60);
    expect(job?.needs).toBeUndefined();
    for (const other of Object.values(workflow.jobs ?? {})) {
      const needs = other?.needs;
      expect(Array.isArray(needs) ? needs : needs ? [needs] : []).not.toContain(jobId);
    }
    for (const file of ["pull_request.yml", "merge.yml"]) {
      expect(loadWorkflow(`.github/workflows/${file}`).jobs?.[jobId]).toBeUndefined();
    }
  });

  test("runs the unit and integration lanes on Bun 1.4.x only", () => {
    expect(String(stepNamed(steps, "Setup Bun 1.4")?.with?.["bun-version"])).toMatch(/^1\.4\.\d+$/);
    const run = stepNamed(steps, "Run unit and integration lanes on Bun 1.4");
    expect(run?.run).toContain("scripts/test-ts.sh");
    expect(run?.run).toContain("unit integration");
  });

  test("always uploads the summary artifact", () => {
    const upload = stepNamed(steps, "Upload Bun 1.4 canary summary");
    expect(upload?.uses).toBe("actions/upload-artifact@v6");
    expect(upload?.if).toBe("always()");
    expect(String(upload?.with?.path)).toContain("scratch/bun-14-canary/");
  });
});
