import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { load } from "js-yaml";

const WORKFLOW_PATH = ".github/workflows/pull_request.yml";
const JOB_ID = "ios-xctest-runner-simulator-tests";
const FORCE_LABELS = new Set(["run-ios", "run-native"]);

type WorkflowDocument = { jobs?: Record<string, unknown> };

function workflowWiring(workflow: string): unknown {
  const jobs = (load(workflow) as WorkflowDocument).jobs;
  const detectChanges = jobs?.["detect-changes"] as { steps?: unknown[] } | undefined;
  const producerSteps = detectChanges?.steps?.filter(step =>
    typeof step === "object" && step !== null &&
    ["filter-native-integration", "ios_integration_should_run"].includes((step as Record<string, unknown>).id as string)
  );
  return {
    job: jobs?.[JOB_ID],
    producerSteps,
  };
}

function executionGate(job: unknown): Pick<Record<string, unknown>, "if" | "needs"> | undefined {
  if (typeof job !== "object" || job === null || Array.isArray(job)) {
    return undefined;
  }
  const record = job as Record<string, unknown>;
  return { if: record.if, needs: record.needs };
}

function structurallyEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) {
    return true;
  }
  if (Array.isArray(left) && Array.isArray(right)) {
    return left.length === right.length && left.every((value, index) => structurallyEqual(value, right[index]));
  }
  if (typeof left !== "object" || left === null || typeof right !== "object" || right === null) {
    return false;
  }

  const leftEntries = Object.entries(left as Record<string, unknown>);
  const rightEntries = Object.entries(right as Record<string, unknown>);
  return (
    leftEntries.length === rightEntries.length &&
    leftEntries.every(([key, value]) => Object.hasOwn(right, key) && structurallyEqual(value, right[key]))
  );
}

/**
 * Returns the author-facing error only when the iOS simulator integration job's
 * parsed YAML changes without a label that makes the existing workflow run it.
 * Comments and edits to every other job intentionally do not require a label.
 */
export function iosIntegrationWorkflowChangeError(
  baseWorkflow: string,
  headWorkflow: string,
  labels: readonly string[],
  xctestRunnerResult?: string
): string | undefined {
  const baseWiring = workflowWiring(baseWorkflow);
  const headWiring = workflowWiring(headWorkflow);
  if (structurallyEqual(baseWiring, headWiring)) {
    return undefined;
  }
  const baseJob = (baseWiring as { job: unknown }).job;
  const headJob = (headWiring as { job: unknown }).job;
  if (!structurallyEqual(executionGate(baseJob), executionGate(headJob))) {
    return [
      `[ERROR] ${JOB_ID}'s execution gate changed, so it cannot be forced safely.`,
      "        Keep its needs and if wiring unchanged, then apply run-ios (or run-native) for step changes.",
    ].join("\n");
  }
  if (labels.some(label => FORCE_LABELS.has(label))) {
    if (xctestRunnerResult !== undefined && xctestRunnerResult !== "success") {
      return `[ERROR] ${JOB_ID} was forced but did not complete successfully (result: ${xctestRunnerResult}).`;
    }
    return undefined;
  }

  return [
    `[ERROR] ${JOB_ID} changed but this PR does not force its macOS integration job.`,
    "        Apply the run-ios label (or run-native) and wait for the resulting run before merge.",
    "        This avoids charging unrelated pull_request.yml edits 20-25 macOS minutes.",
  ].join("\n");
}

function labelsFromEnvironment(): string[] {
  const rawLabels = process.env.IOS_INTEGRATION_WORKFLOW_LABELS ?? "[]";
  const labels = JSON.parse(rawLabels);
  if (!Array.isArray(labels) || !labels.every(label => typeof label === "string")) {
    throw new Error("IOS_INTEGRATION_WORKFLOW_LABELS must be a JSON array of label names.");
  }
  return labels;
}

function baseWorkflowFromGit(baseRef: string): string {
  return execFileSync("git", ["show", `${baseRef}:${WORKFLOW_PATH}`], { encoding: "utf8" });
}

if (import.meta.main) {
  const baseRef = process.env.IOS_INTEGRATION_WORKFLOW_BASE_REF;
  if (!baseRef) {
    throw new Error("IOS_INTEGRATION_WORKFLOW_BASE_REF must name the PR base commit.");
  }

  const error = iosIntegrationWorkflowChangeError(
    baseWorkflowFromGit(baseRef),
    readFileSync(WORKFLOW_PATH, "utf8"),
    labelsFromEnvironment(),
    process.env.IOS_INTEGRATION_WORKFLOW_XCTEST_RESULT
  );
  if (error) {
    console.error(error);
    process.exitCode = 1;
  }
}
