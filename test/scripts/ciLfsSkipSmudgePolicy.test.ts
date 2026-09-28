import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { load } from "js-yaml";
import { loadWorkflow, type WorkflowStep } from "../helpers/workflowSteps";

const repoRoot = join(import.meta.dir, "../..");
const docsWorkflow = ".github/workflows/docs.yml";
const circlePaths = [".circleci/config.yml", ".circleci/continue_config.yml"];

function actionFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      return actionFiles(path);
    }
    return entry.name === "action.yml" ? [relative(repoRoot, path).split(sep).join("/")] : [];
  });
}

const workflowPaths = readdirSync(join(repoRoot, ".github/workflows"))
  .filter((name) => name.endsWith(".yml"))
  .map((name) => `.github/workflows/${name}`);
const compositePaths = actionFiles(join(repoRoot, ".github/actions"));
const workflowDocuments = workflowPaths.map((path) => ({ path, document: loadWorkflow(path) }));

interface StepLocation {
  path: string;
  jobId?: string;
  step: WorkflowStep;
}

const workflowSteps: StepLocation[] = workflowDocuments.flatMap(({ path, document }) =>
  Object.entries(document.jobs ?? {}).flatMap(([jobId, job]) =>
    (job?.steps ?? []).map((step) => ({ path, jobId, step })),
  ),
);
const compositeSteps: StepLocation[] = compositePaths.flatMap((path) => {
  const document = load(readFileSync(join(repoRoot, path), "utf8")) as {
    runs?: { steps?: WorkflowStep[] };
  };
  return (document.runs?.steps ?? []).map((step) => ({ path, step }));
});

interface CircleJob {
  executor?: string | { name?: string };
  environment?: Record<string, string>;
  steps?: Array<string | Record<string, unknown>>;
}

interface CircleConfig {
  jobs?: Record<string, CircleJob>;
  executors?: Record<string, { environment?: Record<string, string> }>;
  workflows?: Record<string, { jobs?: Array<string | Record<string, unknown>> }>;
}

const circleDocuments = circlePaths.map((path) => ({
  path,
  document: load(readFileSync(join(repoRoot, path), "utf8")) as CircleConfig,
}));

function permitsLfs(location: StepLocation): boolean {
  return location.path === docsWorkflow && location.jobId === "deploy-docs";
}

function runsGitLfsDownload(run: string): boolean {
  return run.split("\n").some((line) => {
    const tokens = line.split(/[\s;&|()]+/);
    return tokens.some(
      (token, index) =>
        token === "git" &&
        tokens[index + 1] === "lfs" &&
        (tokens[index + 2] === "pull" || tokens[index + 2] === "fetch"),
    );
  });
}

function hasCheckout(job: CircleJob): boolean {
  return (job.steps ?? []).some(
    (step) => step === "checkout" || (typeof step === "object" && "checkout" in step),
  );
}

function skipsLfs(job: CircleJob, config: CircleConfig): boolean {
  if (job.environment?.GIT_LFS_SKIP_SMUDGE === "1") {
    return true;
  }
  const executor = typeof job.executor === "string" ? job.executor : job.executor?.name;
  return (
    executor !== undefined && config.executors?.[executor]?.environment?.GIT_LFS_SKIP_SMUDGE === "1"
  );
}

describe("CI LFS checkout policy", () => {
  test("enumerates workflows, composite actions, and both CircleCI configs", () => {
    expect(workflowPaths.length).toBeGreaterThanOrEqual(20);
    expect(workflowSteps.length).toBeGreaterThanOrEqual(100);
    expect(compositePaths.length).toBeGreaterThanOrEqual(5);
    expect(compositeSteps.length).toBeGreaterThanOrEqual(5);
    expect(Object.keys(circleDocuments[0]!.document.jobs ?? {}).length).toBeGreaterThanOrEqual(1);
    expect(Object.keys(circleDocuments[1]!.document.jobs ?? {}).length).toBeGreaterThanOrEqual(3);
  });

  test("only docs-publish checkout enables Git LFS", () => {
    const offenders = [...workflowSteps, ...compositeSteps]
      .filter(
        (location) =>
          location.step.uses?.startsWith("actions/checkout@") &&
          String(location.step.with?.lfs) === "true" &&
          !permitsLfs(location),
      )
      .map(({ path, jobId }) => `${path}:${jobId ?? "composite action"}`);
    expect(offenders).toEqual([]);
  });

  test("only docs-publish may run git lfs pull or fetch", () => {
    const offenders = [...workflowSteps, ...compositeSteps]
      .filter(
        (location) =>
          location.step.run !== undefined &&
          runsGitLfsDownload(location.step.run) &&
          !permitsLfs(location),
      )
      .map(({ path, jobId }) => `${path}:${jobId ?? "composite action"}`);
    expect(offenders).toEqual([]);
  });

  test("every CircleCI checkout inherits GIT_LFS_SKIP_SMUDGE before checkout", () => {
    const missing: string[] = [];
    for (const { path, document } of circleDocuments) {
      // Orb jobs hide their own checkout, so workflow invocations must resolve
      // to local jobs whose checkout and environment are inspectable here.
      for (const workflow of Object.values(document.workflows ?? {})) {
        for (const invocation of workflow.jobs ?? []) {
          const name = typeof invocation === "string" ? invocation : Object.keys(invocation)[0];
          if (!name || !document.jobs?.[name]) {
            missing.push(`${path}:uninspectable workflow job ${name ?? "unknown"}`);
          }
        }
      }
      for (const [name, job] of Object.entries(document.jobs ?? {})) {
        if (hasCheckout(job) && !skipsLfs(job, document)) {
          missing.push(`${path}:${name}`);
        }
      }
    }
    expect(missing).toEqual([]);
    const setupConfig = circleDocuments[0]!.document;
    expect(setupConfig.workflows?.["detect-ios-changes"]?.jobs).toContainEqual({
      "detect-ios-changes": { filters: { branches: { ignore: "main" } } },
    });
    expect(hasCheckout(setupConfig.jobs?.["detect-ios-changes"] ?? {})).toBe(true);
  });
});
