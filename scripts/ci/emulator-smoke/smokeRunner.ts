/**
 * Shared runner for the advisory emulator smoke lanes (AAOS #16746, Wear OS #16829).
 *
 * A lane supplies a fixed plan of tool calls, each with an assertion over its payload. The runner
 * drives the plan over one persistent MCP session, writes each payload as JSON, copies observe
 * screenshots, and renders a Markdown summary whose failing rows name the step, the tool and the
 * assertion that broke. After the first failure only `always` steps (cleanup) still run.
 *
 * All I/O goes through {@link SmokeDeps} and {@link SmokeOutputDeps}, so unit tests drive it
 * with a fake client.
 */
import { join } from "node:path";
import { applySession, readEnvelope, type DriveClient } from "../../mcp-drive";
import { isCliToolFailure } from "../../../src/cli/index";
import { getDeviceSessionIdFromResult } from "../../../src/daemon/deviceSessionResult";

export type Payload = Record<string, unknown>;

/** One plan step: a tool call plus what its payload must show. */
export interface SmokeStep {
  id: string;
  tool: string;
  args: Record<string, unknown>;
  /** What the assertion checks, shown in the summary. */
  expectation: string;
  /** Returns why the payload fails the expectation, or undefined when it passes. */
  assert(payload: Payload): string | undefined;
  /** Run even after an earlier step failed (cleanup). */
  always?: boolean;
}

export type SmokeStepStatus = "passed" | "failed" | "skipped";

export interface SmokeStepResult {
  id: string;
  tool: string;
  expectation: string;
  status: SmokeStepStatus;
  detail?: string;
  durationMs: number;
}

export interface SmokeResult {
  ok: boolean;
  session?: string;
  steps: SmokeStepResult[];
}

export function readObject(value: unknown): Payload | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Payload)
    : undefined;
}

/** The foreground app id an observe payload reports. */
export function activeAppId(payload: Payload): string | undefined {
  const appId = readObject(payload.activeWindow)?.appId;
  return typeof appId === "string" ? appId : undefined;
}

export function expectForeground(appId: string) {
  return (payload: Payload): string | undefined => {
    const actual = activeAppId(payload);
    return actual === appId
      ? undefined
      : `expected foreground app ${appId}, observed ${actual ?? "none"}`;
  };
}

/** Fails on a missing app id too: home is unproven when the payload names no foreground app. */
export function expectNotForeground(appId: string) {
  return (payload: Payload): string | undefined => {
    const actual = activeAppId(payload);
    if (actual === undefined) {
      return `expected ${appId} to leave the foreground, observed no foreground app`;
    }
    return actual === appId ? `${appId} is still in the foreground` : undefined;
  };
}

/**
 * An observe payload must carry a hierarchy. The default `skeleton` projection replaces
 * `viewHierarchy`/`elements` with a `skeleton` list.
 */
export function assertHasHierarchy(payload: Payload): string | undefined {
  const skeleton = payload.skeleton;
  if (Array.isArray(skeleton)) {
    return skeleton.length === 0 ? "observe returned an empty skeleton" : undefined;
  }
  return payload.viewHierarchy === undefined && payload.elements === undefined
    ? "observe returned no skeleton or view hierarchy"
    : undefined;
}

export function passes(): string | undefined {
  return undefined;
}

/** I/O the runner needs; faked in tests. */
export interface SmokeDeps {
  client: DriveClient;
  outDir: string;
  /** Write an artifact; may throw (a full disk, a permissions error). */
  writeFile(path: string, contents: string): void;
  /** Copy a host file into the artifact dir; returns false when it cannot. */
  copyFile(from: string, to: string): boolean;
  now(): number;
  log(message: string): void;
}

function stepFileName(index: number, step: SmokeStep, suffix: string): string {
  return `${String(index + 1).padStart(2, "0")}-${step.id}${suffix}`;
}

async function callStep(
  step: SmokeStep,
  session: string | undefined,
  deps: SmokeDeps,
): Promise<{ envelope?: unknown; error?: string }> {
  const call = applySession({ tool: step.tool, args: step.args }, session);
  try {
    return { envelope: await deps.client.callTool(call.tool, call.args) };
  } catch (error) {
    return { error: errorText(error) };
  }
}

function judgeEnvelope(step: SmokeStep, envelope: unknown): string | undefined {
  const { payload, errorText } = readEnvelope(envelope);
  if (errorText) {
    return `tool error: ${errorText}`;
  }
  if (isCliToolFailure(envelope)) {
    const message = payload && typeof payload.message === "string" ? payload.message : "";
    return `tool reported success:false ${message}`.trim();
  }
  const failure = step.assert(payload ?? {});
  return failure ? `assertion failed: ${failure}` : undefined;
}

export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Write the step payload; returns why it could not be written, so the step can report it. */
function saveStepPayload(
  index: number,
  step: SmokeStep,
  envelope: unknown,
  deps: SmokeDeps,
): string | undefined {
  const path = join(deps.outDir, "steps", stepFileName(index, step, ".json"));
  try {
    deps.writeFile(path, JSON.stringify(envelope, null, 2));
    return undefined;
  } catch (error) {
    // A lost artifact must not abort the plan: the always-run cleanup and the summary still run.
    deps.log(`### ${step.id}: could not write ${path}: ${errorText(error)}`);
    return `could not write step JSON: ${errorText(error)}`;
  }
}

function saveScreenshot(index: number, step: SmokeStep, envelope: unknown, deps: SmokeDeps) {
  const path = readEnvelope(envelope).payload?.screenshotPath;
  if (typeof path === "string" && path.length > 0) {
    const target = join(deps.outDir, "screenshots", stepFileName(index, step, ".png"));
    if (!deps.copyFile(path, target)) {
      deps.log(`### ${step.id}: could not copy screenshot ${path}`);
    }
  }
}

function describeStep(step: SmokeStep): Pick<SmokeStepResult, "id" | "tool" | "expectation"> {
  return { id: step.id, tool: step.tool, expectation: step.expectation };
}

/** Run the plan over one session, recording payloads, screenshots and a verdict per step. */
export async function runSmoke(plan: readonly SmokeStep[], deps: SmokeDeps): Promise<SmokeResult> {
  const steps: SmokeStepResult[] = [];
  let session: string | undefined;
  let failed = false;
  try {
    for (const [index, step] of plan.entries()) {
      if (failed && !step.always) {
        steps.push({ ...describeStep(step), status: "skipped", durationMs: 0 });
        continue;
      }
      const started = deps.now();
      const { envelope, error } = await callStep(step, session, deps);
      let writeError: string | undefined;
      if (envelope !== undefined) {
        writeError = saveStepPayload(index, step, envelope, deps);
        saveScreenshot(index, step, envelope, deps);
        session ??= getDeviceSessionIdFromResult(envelope);
      }
      const verdict = error !== undefined ? `call threw: ${error}` : judgeEnvelope(step, envelope);
      const status: SmokeStepStatus = verdict === undefined ? "passed" : "failed";
      failed ||= status === "failed";
      // The artifact error is a detail, not a verdict: the tool call itself met its expectation.
      const detail = [verdict, writeError].filter((part) => part !== undefined).join("; ");
      steps.push({
        ...describeStep(step),
        status,
        detail: detail.length > 0 ? detail : undefined,
        durationMs: deps.now() - started,
      });
      deps.log(`### ${step.id} (${step.tool}): ${status}${detail ? ` — ${detail}` : ""}`);
    }
  } finally {
    await deps.client.close();
  }
  return { ok: !failed, session, steps };
}

function escapeCell(text: string): string {
  return text.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

const STATUS_ICON: Record<SmokeStepStatus, string> = {
  passed: "✅",
  failed: "❌",
  skipped: "⏭️",
};

/**
 * Markdown for `$GITHUB_STEP_SUMMARY`: verdict first, the first failure called out, any notes,
 * then every step.
 */
export function renderSmokeSummary(
  title: string,
  result: SmokeResult,
  notes: readonly string[] = [],
): string {
  const firstFailure = result.steps.find((step) => step.status === "failed");
  const lines = [
    `## ${title}`,
    "",
    result.ok
      ? "**Passed**: every step met its expectation."
      : `**Failed** at \`${firstFailure?.id ?? "unknown"}\` (\`${firstFailure?.tool ?? "?"}\`): ${escapeCell(firstFailure?.detail ?? "no detail")}`,
    "",
    ...notes.flatMap((note) => [`> ${escapeCell(note)}`, ""]),
    "| Step | Tool | Expectation | Result | Detail | ms |",
    "| --- | --- | --- | --- | --- | ---: |",
    ...result.steps.map(
      (step) =>
        `| ${step.id} | ${step.tool} | ${escapeCell(step.expectation)} | ${STATUS_ICON[step.status]} ${step.status} | ${escapeCell(step.detail ?? "")} | ${step.durationMs} |`,
    ),
    "",
  ];
  return lines.join("\n");
}

/** Where the run's verdict goes once the plan has finished; faked in tests. */
export interface SmokeOutputDeps {
  outDir: string;
  /** `$GITHUB_STEP_SUMMARY`, when set. */
  stepSummaryPath?: string;
  writeFile(path: string, contents: string): void;
  appendFile(path: string, contents: string): void;
  log(message: string): void;
}

/**
 * Write `summary.md`, `result.json` and the job step summary. Each write is attempted on its
 * own, so one failure cannot drop the others; returns the failures, already logged.
 */
export function writeSmokeOutputs(
  result: SmokeResult,
  summary: string,
  deps: SmokeOutputDeps,
): string[] {
  const writes: Array<[string, () => void]> = [
    ["summary.md", () => deps.writeFile(join(deps.outDir, "summary.md"), summary)],
    [
      "result.json",
      () => deps.writeFile(join(deps.outDir, "result.json"), JSON.stringify(result, null, 2)),
    ],
  ];
  const stepSummaryPath = deps.stepSummaryPath;
  if (stepSummaryPath) {
    writes.push(["GITHUB_STEP_SUMMARY", () => deps.appendFile(stepSummaryPath, summary)]);
  }
  const failures: string[] = [];
  for (const [name, write] of writes) {
    try {
      write();
    } catch (error) {
      // The summary is still printed to the log, and the exit status still carries the verdict.
      const failure = `could not write ${name}: ${errorText(error)}`;
      deps.log(failure);
      failures.push(failure);
    }
  }
  return failures;
}

/**
 * Process entry point shared by the lanes: connect to the MCP server, run the plan, write the
 * outputs and exit 0 on a pass, 1 otherwise.
 */
export async function runSmokeMain(options: {
  title: string;
  outDir: string;
  plan: readonly SmokeStep[];
  notes?: readonly string[];
}): Promise<never> {
  const { copyFileSync, mkdirSync, writeFileSync, appendFileSync } = await import("node:fs");
  const { dirname } = await import("node:path");
  const { createSdkClient, defaultServerPath, resolveTimeoutMs } = await import("../../mcp-drive");
  const client = await createSdkClient(
    defaultServerPath(),
    resolveTimeoutMs(undefined, process.env),
  );
  const writeFile = (path: string, contents: string): void => {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, contents);
  };
  const result = await runSmoke(options.plan, {
    client,
    outDir: options.outDir,
    writeFile,
    copyFile: (from, to) => {
      try {
        mkdirSync(dirname(to), { recursive: true });
        copyFileSync(from, to);
        return true;
      } catch (error) {
        console.warn(`copy ${from} failed: ${errorText(error)}`);
        return false;
      }
    },
    now: () => Date.now(),
    log: (message) => console.log(message),
  });
  const summary = renderSmokeSummary(options.title, result, options.notes);
  writeSmokeOutputs(result, summary, {
    outDir: options.outDir,
    stepSummaryPath: process.env.GITHUB_STEP_SUMMARY,
    writeFile,
    appendFile: (path, contents) => appendFileSync(path, contents),
    log: (message) => console.warn(message),
  });
  console.log(summary);
  process.exit(result.ok ? 0 : 1);
}
