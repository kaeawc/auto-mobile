import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { load } from "js-yaml";
import { loadWorkflow, type WorkflowDefinition, type WorkflowStep } from "../helpers/workflowSteps";

const repoRoot = join(import.meta.dir, "../..");
const docsWorkflow = ".github/workflows/docs.yml";
const circlePaths = [".circleci/config.yml", ".circleci/continue_config.yml"];

function isWorkflowFile(name: string): boolean {
  return name.endsWith(".yml") || name.endsWith(".yaml");
}

function isActionFile(name: string): boolean {
  return name === "action.yml" || name === "action.yaml";
}

function actionFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      return actionFiles(path);
    }
    return isActionFile(entry.name) ? [relative(repoRoot, path).split(sep).join("/")] : [];
  });
}

const workflowPaths = readdirSync(join(repoRoot, ".github/workflows"))
  .filter(isWorkflowFile)
  .map((name) => `.github/workflows/${name}`);
const compositePaths = actionFiles(join(repoRoot, ".github/actions"));
const workflowDocuments = workflowPaths.map((path) => ({ path, document: loadWorkflow(path) }));

interface StepLocation {
  path: string;
  jobId?: string;
  step: WorkflowStep;
}

function workflowStepLocations(path: string, document: WorkflowDefinition): StepLocation[] {
  return Object.entries(document.jobs ?? {}).flatMap(([jobId, job]) =>
    (job?.steps ?? []).map((step) => ({ path, jobId, step })),
  );
}

const workflowSteps: StepLocation[] = workflowDocuments.flatMap(({ path, document }) =>
  workflowStepLocations(path, document),
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

type CircleStep = string | Record<string, unknown>;

interface CircleConfig {
  jobs?: Record<string, CircleJob>;
  commands?: Record<string, { steps?: CircleStep[] }>;
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

function checkoutLfsOffenders(locations: StepLocation[]): string[] {
  return locations
    .filter(
      (location) =>
        location.step.uses?.startsWith("actions/checkout@") &&
        String(location.step.with?.lfs) === "true" &&
        !permitsLfs(location),
    )
    .map(({ path, jobId }) => `${path}:${jobId ?? "composite action"}`);
}

function circleRunCommand(step: string | Record<string, unknown>): string | undefined {
  if (typeof step === "string") {
    return undefined;
  }
  const run = step.run;
  if (typeof run === "string") {
    return run;
  }
  if (run !== null && typeof run === "object" && "command" in run) {
    return typeof run.command === "string" ? run.command : undefined;
  }
  return undefined;
}

function circleLfsDownloadOffenders(path: string, config: CircleConfig): string[] {
  return Object.entries(config.jobs ?? {}).flatMap(([name, job]) =>
    (job.steps ?? [])
      .filter((step) => {
        const command = circleRunCommand(step);
        return command !== undefined && runsGitLfsDownload(command);
      })
      .map(() => `${path}:${name}`),
  );
}

function circleStepName(step: CircleStep): string | undefined {
  return typeof step === "string" ? step : Object.keys(step)[0];
}

// Inline reusable `commands:` so a job's effective step sequence is inspectable.
function expandCircleSteps(steps: CircleStep[], config: CircleConfig): CircleStep[] {
  return steps.flatMap((step) => {
    const command = config.commands?.[circleStepName(step) ?? ""];
    return command ? expandCircleSteps(command.steps ?? [], config) : [step];
  });
}

function isCheckout(step: CircleStep): boolean {
  return circleStepName(step) === "checkout";
}

function hasCheckout(job: CircleJob, config: CircleConfig): boolean {
  return expandCircleSteps(job.steps ?? [], config).some(isCheckout);
}

// CircleCI's native checkout ignores GIT_LFS_SKIP_SMUDGE (git-lfs#4858), so the
// only effective guard is a run step that neutralizes the lfs filter in global
// git config BEFORE the checkout step.
function disablesLfsFilter(step: CircleStep): boolean {
  const command = circleRunCommand(step);
  return (
    command !== undefined &&
    command.includes(`git config --global filter.lfs.process ""`) &&
    command.includes("git config --global filter.lfs.smudge cat")
  );
}

function skipsLfs(job: CircleJob, config: CircleConfig): boolean {
  const steps = expandCircleSteps(job.steps ?? [], config);
  const checkoutIndex = steps.findIndex(isCheckout);
  return checkoutIndex > 0 && steps.slice(0, checkoutIndex).some(disablesLfsFilter);
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
    const offenders = checkoutLfsOffenders([...workflowSteps, ...compositeSteps]);
    expect(offenders).toEqual([]);
  });

  test("discovers .yaml workflows and composite actions and rejects their LFS checkouts", () => {
    expect(isWorkflowFile("example.yaml")).toBe(true);
    expect(isActionFile("action.yaml")).toBe(true);

    const workflow = load(`
jobs:
  build:
    steps:
      - uses: actions/checkout@v4
        with:
          lfs: true
`) as WorkflowDefinition;
    const composite = load(`
runs:
  steps:
    - uses: actions/checkout@v4
      with:
        lfs: true
`) as { runs: { steps: WorkflowStep[] } };
    expect(
      checkoutLfsOffenders([
        ...workflowStepLocations(".github/workflows/example.yaml", workflow),
        ...composite.runs.steps.map((step) => ({
          path: ".github/actions/example/action.yaml",
          step,
        })),
      ]),
    ).toEqual([
      ".github/workflows/example.yaml:build",
      ".github/actions/example/action.yaml:composite action",
    ]);
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

  test("every CircleCI checkout disables the lfs filter before checkout", () => {
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
        if (hasCheckout(job, document) && !skipsLfs(job, document)) {
          missing.push(`${path}:${name}`);
        }
      }
    }
    expect(missing).toEqual([]);
    expect(
      circleDocuments.flatMap(({ path, document }) => circleLfsDownloadOffenders(path, document)),
    ).toEqual([]);
    const setupConfig = circleDocuments[0]!.document;
    expect(setupConfig.workflows?.["detect-ios-changes"]?.jobs).toContainEqual({
      "detect-ios-changes": { filters: { branches: { ignore: "main" } } },
    });
    expect(hasCheckout(setupConfig.jobs?.["detect-ios-changes"] ?? {}, setupConfig)).toBe(true);
  });

  test("CircleCI run steps reject git lfs pull and fetch in both run forms", () => {
    const config = load(`
jobs:
  string-run:
    steps:
      - run: git lfs pull --include=docs/**
  map-run:
    steps:
      - run:
          name: Fetch assets
          command: git lfs fetch --include=assets/**
`) as CircleConfig;
    expect(circleLfsDownloadOffenders(".circleci/fixture.yml", config)).toEqual([
      ".circleci/fixture.yml:string-run",
      ".circleci/fixture.yml:map-run",
    ]);
  });
  test("CircleCI checkout policy rejects env-only skips and a late filter override", () => {
    const config = load(`
commands:
  safe_checkout:
    steps:
      - run: |
          git config --global filter.lfs.process ""
          git config --global filter.lfs.smudge cat
      - checkout
jobs:
  via-command:
    steps:
      - safe_checkout
  env-only:
    environment:
      GIT_LFS_SKIP_SMUDGE: "1"
    steps:
      - checkout
  late-override:
    steps:
      - checkout
      - run: |
          git config --global filter.lfs.process ""
          git config --global filter.lfs.smudge cat
`) as CircleConfig;
    const jobs = config.jobs ?? {};
    expect(hasCheckout(jobs["via-command"]!, config)).toBe(true);
    expect(skipsLfs(jobs["via-command"]!, config)).toBe(true);
    expect(skipsLfs(jobs["env-only"]!, config)).toBe(false);
    expect(skipsLfs(jobs["late-override"]!, config)).toBe(false);
  });
});
