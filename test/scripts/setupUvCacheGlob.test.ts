import { describe, expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { loadWorkflow, type WorkflowStep } from "../helpers/workflowSteps";

// Guards #17068: with `enable-cache: true`, astral-sh/setup-uv hashes its
// `cache-dependency-glob`, whose default (`**/uv.lock`, `**/requirements*.txt`,
// ...) walks the whole workspace. A backgrounded setup-uv then scans
// node_modules/ while `bun install` creates and deletes its .bun-tmp-* staging
// dirs, and fails with ENOENT. Pinning the glob to the repo's only uv lockfile
// keeps the walk out of node_modules/ whatever the step ordering.

const WORKFLOW_DIR = ".github/workflows";
const UV_LOCK = "scripts/github/uv.lock";

interface CachedUvStep {
  location: string;
  step: WorkflowStep;
}

function cachedSetupUvSteps(): CachedUvStep[] {
  const files = readdirSync(join(import.meta.dir, "../..", WORKFLOW_DIR)).filter(
    (file) => file.endsWith(".yml") || file.endsWith(".yaml"),
  );
  return files.flatMap((file) =>
    Object.entries(loadWorkflow(`${WORKFLOW_DIR}/${file}`).jobs ?? {}).flatMap(([jobId, job]) =>
      (job?.steps ?? [])
        .filter((step) => step.uses?.startsWith("astral-sh/setup-uv@"))
        .filter((step) => step.with?.["enable-cache"] === true)
        .map((step) => ({ location: `${file}:${jobId}:${step.name ?? step.id}`, step })),
    ),
  );
}

describe("#17068 setup-uv cache glob stays out of node_modules", () => {
  const steps = cachedSetupUvSteps();

  test("the scan finds the cached setup-uv steps", () => {
    expect(steps.length).toBeGreaterThan(0);
  });

  test("every cached setup-uv step pins cache-dependency-glob to the uv lockfile", () => {
    const offenders = steps
      .filter(({ step }) => step.with?.["cache-dependency-glob"] !== UV_LOCK)
      .map(
        ({ location, step }) => `${location} -> ${String(step.with?.["cache-dependency-glob"])}`,
      );
    expect(offenders).toEqual([]);
  });
});
