import { readFileSync } from "node:fs";
import { join } from "node:path";
import { load } from "js-yaml";

/**
 * Helpers for asserting the *structure* of a GitHub Actions job's steps.
 *
 * Workflow guards must parse the YAML rather than line-match it (CLAUDE.md:
 * don't regex-parse YAML when a structured parser exists — `js-yaml` is already
 * a direct dependency). Parsing also makes the assertions immune to reflows,
 * comments, and text that happens to appear inside another step's block scalar.
 *
 * Extracted when the second consumer arrived (the parallel-steps guards for
 * #4124 and #4125); keep the surface to what those guards actually need.
 */

export interface WorkflowStep {
  name?: string;
  id?: string;
  run?: string;
  uses?: string;
  /** Native parallel-steps: run this step asynchronously. */
  background?: boolean;
  /** Native parallel-steps barrier: a single step id or a list of them. */
  wait?: string | string[];
  if?: string | boolean;
  env?: Record<string, string | number | boolean>;
  with?: Record<string, string | number | boolean>;
}

export interface WorkflowPermissions {
  actions?: string;
  contents?: string;
  pages?: string;
  "id-token"?: string;
}

export interface WorkflowConcurrency {
  group?: string;
  "cancel-in-progress"?: boolean;
}

/** A job's own configuration, minus its steps. */
export interface WorkflowJob {
  "timeout-minutes"?: number;
  /** Set when the job delegates to a reusable workflow. */
  uses?: string;
  if?: string | boolean;
  concurrency?: WorkflowConcurrency;
  permissions?: WorkflowPermissions;
  env?: Record<string, string | number | boolean>;
  steps?: WorkflowStep[];
}

export interface WorkflowDefinition {
  permissions?: WorkflowPermissions;
  concurrency?: WorkflowConcurrency;
  jobs?: Record<string, WorkflowJob | undefined>;
}

const repoRoot = join(import.meta.dir, "../..");

/** Parse one workflow through the repository's canonical YAML reader. */
export function loadWorkflow(workflowRelativePath: string): WorkflowDefinition {
  return load(readFileSync(join(repoRoot, workflowRelativePath), "utf8")) as WorkflowDefinition;
}

/**
 * Steps of one job, or an empty array when the workflow or job is missing.
 *
 * Callers should assert the result is non-empty before ordering assertions —
 * otherwise a renamed job would let every other assertion pass vacuously.
 */
export function loadJobSteps(workflowRelativePath: string, jobId: string): WorkflowStep[] {
  const document = loadWorkflow(workflowRelativePath);
  return document.jobs?.[jobId]?.steps ?? [];
}

/**
 * Every job in a workflow, keyed by job id.
 *
 * Parsing rather than line-matching matters especially here: a job key may be
 * quoted (`"my-job":`), which an indentation regex silently skips — so a guard
 * built on one reports success for a job it never looked at.
 */
export function loadJobs(workflowRelativePath: string): Record<string, WorkflowJob> {
  const document = loadWorkflow(workflowRelativePath);
  const jobs: Record<string, WorkflowJob> = {};
  for (const [id, job] of Object.entries(document.jobs ?? {})) {
    if (job) {
      jobs[id] = job;
    }
  }
  return jobs;
}

/** Every step of every job in a workflow, paired with its job id. */
export function loadAllJobSteps(
  workflowRelativePath: string
): { jobId: string; step: WorkflowStep }[] {
  const document = loadWorkflow(workflowRelativePath);
  return Object.entries(document.jobs ?? {}).flatMap(([jobId, job]) =>
    (job?.steps ?? []).map(step => ({ jobId, step }))
  );
}

export function stepNamed(steps: WorkflowStep[], name: string): WorkflowStep | undefined {
  return steps.find(step => step.name === name);
}

export function indexOfNamed(steps: WorkflowStep[], name: string): number {
  return steps.findIndex(step => step.name === name);
}

/** Index of the first step invoking `uses`, for the unnamed `- uses:` steps. */
export function indexOfUses(steps: WorkflowStep[], uses: string): number {
  return steps.findIndex(step => step.uses === uses);
}

/**
 * Index of the `wait` barrier targeting `id`. A wait step carries no name, and
 * `wait` accepts either a single id or a list, so normalize before comparing.
 */
export function indexOfWaitOn(steps: WorkflowStep[], id: string): number {
  return steps.findIndex(step => {
    if (step.wait === undefined) {
      return false;
    }
    return (Array.isArray(step.wait) ? step.wait : [step.wait]).includes(id);
  });
}
