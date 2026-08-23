import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
import { load } from "js-yaml";

const WORKFLOW_PATH = ".github/workflows/pull_request.yml";
const JOB_ID = "ios-xctest-runner-simulator-tests";
const FORCE_LABELS = new Set(["run-ios", "run-native"]);

type WorkflowDocument = {
  jobs?: Record<string, unknown>;
  on?: { pull_request?: { types?: unknown } };
};

function workflowWiring(workflow: string): unknown {
  const document = load(workflow) as WorkflowDocument;
  const jobs = document.jobs;
  const detectChanges = jobs?.["detect-changes"] as
    | {
        outputs?: Record<string, unknown>;
        steps?: unknown[];
      }
    | undefined;
  const producerSteps = detectChanges?.steps?.filter(
    (step) =>
      typeof step === "object" &&
      step !== null &&
      [
        "filter",
        "check-sha256",
        "check-auto-chore",
        "filter-native-integration",
        "ios_integration_should_run",
      ].includes((step as Record<string, unknown>).id as string),
  );
  return {
    job: jobs?.[JOB_ID],
    pullRequestTypes: document.on?.pull_request?.types,
    producerOutput: detectChanges?.outputs?.ios_integration_should_run,
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
    return (
      left.length === right.length &&
      left.every((value, index) => structurallyEqual(value, right[index]))
    );
  }
  if (typeof left !== "object" || left === null || typeof right !== "object" || right === null) {
    return false;
  }

  const leftEntries = Object.entries(left as Record<string, unknown>);
  const rightEntries = Object.entries(right as Record<string, unknown>);
  return (
    leftEntries.length === rightEntries.length &&
    leftEntries.every(
      ([key, value]) => Object.hasOwn(right, key) && structurallyEqual(value, right[key]),
    )
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
  xctestRunnerResult?: string,
): string | undefined {
  const baseWiring = workflowWiring(baseWorkflow);
  const headWiring = workflowWiring(headWorkflow);
  if (structurallyEqual(baseWiring, headWiring)) {
    return undefined;
  }
  const baseJob = (baseWiring as { job: unknown }).job;
  const headJob = (headWiring as { job: unknown }).job;
  if (
    !structurallyEqual(executionGate(baseJob), executionGate(headJob)) ||
    !structurallyEqual(
      (baseWiring as { pullRequestTypes: unknown }).pullRequestTypes,
      (headWiring as { pullRequestTypes: unknown }).pullRequestTypes,
    )
  ) {
    return [
      `[ERROR] ${JOB_ID}'s execution gate changed, so it cannot be forced safely.`,
      "        Keep its needs and if wiring unchanged, then apply run-ios (or run-native) for step changes.",
    ].join("\n");
  }
  if (labels.some((label) => FORCE_LABELS.has(label))) {
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

export function requiresXctestRunnerResult(
  baseWorkflow: string,
  headWorkflow: string,
  labels: readonly string[],
): boolean {
  return (
    !structurallyEqual(workflowWiring(baseWorkflow), workflowWiring(headWorkflow)) &&
    labels.some((label) => FORCE_LABELS.has(label))
  );
}

function labelsFromEnvironment(): string[] {
  const rawLabels = process.env.IOS_INTEGRATION_WORKFLOW_LABELS ?? "[]";
  const labels = JSON.parse(rawLabels);
  if (!Array.isArray(labels) || !labels.every((label) => typeof label === "string")) {
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

  const baseWorkflow = baseWorkflowFromGit(baseRef);
  const headWorkflow = readFileSync(WORKFLOW_PATH, "utf8");
  const labels = labelsFromEnvironment();
  const error = iosIntegrationWorkflowChangeError(
    baseWorkflow,
    headWorkflow,
    labels,
    process.env.IOS_INTEGRATION_WORKFLOW_XCTEST_RESULT,
  );
  if (error) {
    console.error(error);
    process.exitCode = 1;
  } else if (
    process.env.GITHUB_OUTPUT &&
    requiresXctestRunnerResult(baseWorkflow, headWorkflow, labels)
  ) {
    appendFileSync(process.env.GITHUB_OUTPUT, "requires_xctest_result=true\n");
  }
}
