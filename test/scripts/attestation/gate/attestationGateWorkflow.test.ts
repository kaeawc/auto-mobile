import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { load } from "js-yaml";
import { loadJobs, loadWorkflow, type WorkflowStep } from "../../../helpers/workflowSteps";

const id = "attestation-gate-shadow";
const path = ".github/workflows/pull_request.yml";
const workflow = loadWorkflow(path);
const jobs = loadJobs(path);
const job = jobs[id];
interface Tolerant {
  "continue-on-error"?: boolean;
}
interface Composite {
  inputs: Record<string, { default?: string }>;
  runs: { steps: (WorkflowStep & Tolerant)[] };
}
const root = join(import.meta.dir, "../../../..");
const action = load(
  readFileSync(join(root, ".github/actions/attestation-gate/action.yml"), "utf8"),
) as Composite;
const mergeJobs = loadJobs(".github/workflows/merge.yml");
const cli = readFileSync(join(root, "scripts/ci/attestation-gate.ts"), "utf8");

test("shadow job is explicitly advisory and minimally privileged", () => {
  expect(workflow.jobs?.[id]).toBeDefined();
  expect((job as typeof job & Tolerant)["continue-on-error"]).toBe(true);
  expect(job.permissions).toEqual({ contents: "read" });
  expect(job.needs).toBe("detect-changes");
  expect(job["runs-on"]).toBe("ubuntu-latest");
  expect(job["timeout-minutes"]).toBe(10);
  expect(job.if).toBe(
    "always() && !cancelled() && needs.detect-changes.outputs.sha256_only != 'true' && needs.detect-changes.outputs.auto_chore != 'true'",
  );
  expect(job.steps?.find((step) => step.uses === "actions/checkout@v6")?.with).toEqual({
    lfs: false,
    "fetch-depth": 1,
    ref: "${{ github.event.pull_request.head.sha }}",
  });
  expect(
    job.steps?.find((step) => step.uses === "./.github/actions/attestation-gate")?.with,
  ).toEqual({
    "commit-sha": "${{ github.event.pull_request.head.sha }}",
    "base-sha": "${{ github.event.pull_request.base.sha }}",
  });
});
test("every other job is independent of the shadow job", () => {
  for (const [otherId, other] of Object.entries(jobs)) {
    if (otherId === id) {
      continue;
    }
    const needs = typeof other.needs === "string" ? [other.needs] : (other.needs ?? []);
    expect(needs).not.toContain(id);
    expect(String(other.if ?? "")).not.toContain(id);
  }
  for (const gate of ["ide-plugin-gate", "ios-build-gate", "shell-tests-gate"]) {
    expect(jobs[gate]).toBeDefined();
    expect(JSON.stringify(jobs[gate])).not.toContain(id);
  }
});
test("composite execution is tolerant and artifact is uniquely named", () => {
  const step = action.runs.steps.find((s) => s.run?.includes("bun scripts/ci/attestation-gate.ts"));
  expect(step).toBeDefined();
  expect(step?.["continue-on-error"]).toBe(true);
  expect(action.inputs["commit-sha"].default).toBe("${{ github.sha }}");
  expect(step?.env).toEqual({
    ATTESTATION_BASE_SHA: "${{ inputs.base-sha }}",
    ATTESTATION_CI_RESULT: "${{ inputs.ci-result }}",
    ATTESTATION_TIER: "${{ inputs.tier }}",
    ATTESTATION_COMMIT_SHA: "${{ inputs.commit-sha }}",
    AUTOMOBILE_LOG_SINK: "stderr",
  });
  const upload = action.runs.steps.find((s) => s.uses === "actions/upload-artifact@v6");
  expect(upload?.if).toBe("always()");
  expect(upload?.with?.name).toBe(
    "attestation-shadow-${{ inputs.tier }}-${{ github.run_id }}-${{ github.run_attempt }}",
  );
  expect(
    action.runs.steps.some((s) => s.uses === "./.github/actions/setup-auto-mobile-npm-package"),
  ).toBe(false);
});
test("merge workflow has no shadow job and CLI has no enforcement flag", () => {
  expect(mergeJobs[id]).toBeUndefined();
  expect(JSON.stringify(mergeJobs)).not.toContain(id);
  expect(cli).not.toContain("--enforce");
});
