#!/usr/bin/env bun
/**
 * Advisory nightly Android Automotive OS emulator smoke (#16746).
 *
 * Drives one persistent MCP session through a fixed plan: create and boot an automotive AVD
 * with startDevice `createIfMissing`, then observe, launch, tap, scroll, back, home and the
 * driving/parked vehicle states. Every step carries an assertion over its tool payload; the
 * run writes each payload as JSON, copies observe screenshots, and renders a Markdown summary
 * whose failing rows name the step, the tool and the assertion that broke.
 *
 * All I/O goes through {@link AaosSmokeDeps}, so the unit tests drive it with a fake client.
 */
import { join } from "node:path";
import { applySession, readEnvelope, type DriveClient } from "../../mcp-drive";
import { isCliToolFailure } from "../../../src/cli/index";
import { getDeviceSessionIdFromResult } from "../../../src/daemon/deviceSessionResult";

export type Payload = Record<string, unknown>;

/** One plan step: a tool call plus what its payload must show. */
export interface AaosSmokeStep {
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

export type AaosSmokeStepStatus = "passed" | "failed" | "skipped";

export interface AaosSmokeStepResult {
  id: string;
  tool: string;
  expectation: string;
  status: AaosSmokeStepStatus;
  detail?: string;
  durationMs: number;
}

export interface AaosSmokeResult {
  ok: boolean;
  session?: string;
  steps: AaosSmokeStepResult[];
}

/** Car Settings ships on every `android-automotive` image and has a scrollable list. */
export const AAOS_SETTINGS_APP_ID = "com.android.car.settings";
/** A top-level Car Settings entry visible without scrolling on the 1024p landscape profile. */
export const AAOS_SETTINGS_TAP_TEXT = "Display";

const START_TIMEOUT_MS = 600_000;

export interface AaosSmokePlanOptions {
  /** Replace one assertion with an impossible one, to prove a broken assertion fails the job. */
  breakAssertion?: boolean;
  /** Android major version the automotive image is pinned to. */
  osVersion?: string;
}

function readObject(value: unknown): Payload | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Payload)
    : undefined;
}

/** The foreground app id an observe payload reports. */
export function activeAppId(payload: Payload): string | undefined {
  const appId = readObject(payload.activeWindow)?.appId;
  return typeof appId === "string" ? appId : undefined;
}

function expectForeground(appId: string) {
  return (payload: Payload): string | undefined => {
    const actual = activeAppId(payload);
    return actual === appId
      ? undefined
      : `expected foreground app ${appId}, observed ${actual ?? "none"}`;
  };
}

function expectNotForeground(appId: string) {
  return (payload: Payload): string | undefined =>
    activeAppId(payload) === appId ? `${appId} is still in the foreground` : undefined;
}

/** An observe payload must carry a hierarchy and a landscape screen, as a car head unit has. */
export function assertLandscapeObservation(payload: Payload): string | undefined {
  if (payload.viewHierarchy === undefined && payload.elements === undefined) {
    return "observe returned no view hierarchy";
  }
  const size = readObject(payload.screenSize);
  const width = size?.width;
  const height = size?.height;
  if (typeof width !== "number" || typeof height !== "number") {
    return "observe returned no screenSize";
  }
  return width > height ? undefined : `expected a landscape head unit, got ${width}x${height}`;
}

/** The device must be reported as an automotive emulator. */
export function assertAutomotiveDevice(payload: Payload): string | undefined {
  return payload.formFactor === "automotive"
    ? undefined
    : `expected formFactor automotive, startDevice reported ${String(payload.formFactor ?? "none")}`;
}

/** A vehicle.motion change must be applied (not unsupported) and the call must succeed. */
export function assertMotionApplied(motion: "driving" | "parked") {
  return (payload: Payload): string | undefined => {
    const condition = readObject(payload.deviceCondition);
    if (condition?.success !== true) {
      return `vehicle.motion=${motion} did not succeed: ${String(condition?.error ?? payload.message ?? "no deviceCondition result")}`;
    }
    const changes = Array.isArray(condition.changes) ? condition.changes : [];
    const motionChange = changes.map(readObject).find((change) => change?.key === "vehicle.motion");
    const status = motionChange?.status;
    return status === "applied" || status === "unchanged"
      ? undefined
      : `vehicle.motion=${motion} reported ${String(status ?? "no change")}: ${String(motionChange?.detail ?? "")}`.trim();
  };
}

function passes(): string | undefined {
  return undefined;
}

function observeStep(id: string, expectation: string, assert: AaosSmokeStep["assert"]) {
  return {
    id,
    tool: "observe",
    args: { platform: "android", screenshot: "settled" },
    expectation,
    assert,
  } satisfies AaosSmokeStep;
}

/** The fixed nightly plan. */
export function buildAaosSmokePlan(options: AaosSmokePlanOptions = {}): AaosSmokeStep[] {
  const osVersion = options.osVersion ?? "14";
  const settingsForeground = options.breakAssertion
    ? expectForeground("com.example.deliberately.broken")
    : expectForeground(AAOS_SETTINGS_APP_ID);
  return [
    {
      id: "start",
      tool: "startDevice",
      args: {
        platform: "android",
        formFactor: "automotive",
        createIfMissing: true,
        minOsVersion: osVersion,
        maxOsVersion: osVersion,
        timeoutMs: START_TIMEOUT_MS,
        enableTools: ["setDeviceState"],
      },
      expectation: "an automotive AVD is created or reused and boots",
      assert: assertAutomotiveDevice,
    },
    observeStep("observe-initial", "landscape hierarchy is observable", assertLandscapeObservation),
    {
      id: "launch",
      tool: "launchApp",
      args: { platform: "android", appId: AAOS_SETTINGS_APP_ID },
      expectation: `${AAOS_SETTINGS_APP_ID} launches`,
      assert: passes,
    },
    observeStep("observe-launched", `${AAOS_SETTINGS_APP_ID} is foreground`, settingsForeground),
    {
      id: "tap",
      tool: "tapOn",
      args: { platform: "android", action: "tap", selector: { text: AAOS_SETTINGS_TAP_TEXT } },
      expectation: `tap "${AAOS_SETTINGS_TAP_TEXT}" in Car Settings`,
      assert: passes,
    },
    {
      id: "scroll",
      tool: "swipeOn",
      args: { platform: "android", direction: "up", gestureType: "scrollTowardsDirection" },
      expectation: "scroll the settings content",
      assert: passes,
    },
    {
      id: "back",
      tool: "pressButton",
      args: { platform: "android", button: "back" },
      expectation: "back is delivered",
      assert: passes,
    },
    {
      id: "home",
      tool: "homeScreen",
      args: { platform: "android" },
      expectation: "home is delivered",
      assert: passes,
    },
    observeStep(
      "observe-home",
      `${AAOS_SETTINGS_APP_ID} left the foreground`,
      expectNotForeground(AAOS_SETTINGS_APP_ID),
    ),
    {
      id: "driving",
      tool: "setDeviceState",
      args: { platform: "android", deviceCondition: { vehicle: { motion: "driving" } } },
      expectation: "vehicle.motion=driving is applied and verified MOVING",
      assert: assertMotionApplied("driving"),
    },
    observeStep("observe-driving", "observable while driving", assertLandscapeObservation),
    {
      id: "parked",
      tool: "setDeviceState",
      args: { platform: "android", deviceCondition: { vehicle: { motion: "parked" } } },
      expectation: "vehicle.motion=parked is applied and verified",
      assert: assertMotionApplied("parked"),
    },
    {
      id: "reset",
      tool: "setDeviceState",
      args: { platform: "android", deviceCondition: { reset: true } },
      expectation: "vehicle state is restored",
      assert: passes,
      always: true,
    },
  ];
}

/** I/O the runner needs; faked in tests. */
export interface AaosSmokeDeps {
  client: DriveClient;
  outDir: string;
  writeFile(path: string, contents: string): void;
  /** Copy a host file into the artifact dir; returns false when it cannot. */
  copyFile(from: string, to: string): boolean;
  now(): number;
  log(message: string): void;
}

function stepFileName(index: number, step: AaosSmokeStep, suffix: string): string {
  return `${String(index + 1).padStart(2, "0")}-${step.id}${suffix}`;
}

async function callStep(
  step: AaosSmokeStep,
  session: string | undefined,
  deps: AaosSmokeDeps,
): Promise<{ envelope?: unknown; error?: string }> {
  const call = applySession({ tool: step.tool, args: step.args }, session);
  try {
    return { envelope: await deps.client.callTool(call.tool, call.args) };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

function judgeEnvelope(step: AaosSmokeStep, envelope: unknown): string | undefined {
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

function saveScreenshot(
  index: number,
  step: AaosSmokeStep,
  envelope: unknown,
  deps: AaosSmokeDeps,
) {
  const path = readEnvelope(envelope).payload?.screenshotPath;
  if (typeof path === "string" && path.length > 0) {
    const target = join(deps.outDir, "screenshots", stepFileName(index, step, ".png"));
    if (!deps.copyFile(path, target)) {
      deps.log(`### ${step.id}: could not copy screenshot ${path}`);
    }
  }
}

/** Run the plan over one session, recording payloads, screenshots and a verdict per step. */
export async function runAaosSmoke(
  plan: readonly AaosSmokeStep[],
  deps: AaosSmokeDeps,
): Promise<AaosSmokeResult> {
  const steps: AaosSmokeStepResult[] = [];
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
      if (envelope !== undefined) {
        deps.writeFile(
          join(deps.outDir, "steps", stepFileName(index, step, ".json")),
          JSON.stringify(envelope, null, 2),
        );
        saveScreenshot(index, step, envelope, deps);
        session ??= getDeviceSessionIdFromResult(envelope);
      }
      const detail = error !== undefined ? `call threw: ${error}` : judgeEnvelope(step, envelope);
      const status: AaosSmokeStepStatus = detail === undefined ? "passed" : "failed";
      failed ||= status === "failed";
      steps.push({ ...describeStep(step), status, detail, durationMs: deps.now() - started });
      deps.log(`### ${step.id} (${step.tool}): ${status}${detail ? ` — ${detail}` : ""}`);
    }
  } finally {
    await deps.client.close();
  }
  return { ok: !failed, session, steps };
}

function describeStep(
  step: AaosSmokeStep,
): Pick<AaosSmokeStepResult, "id" | "tool" | "expectation"> {
  return { id: step.id, tool: step.tool, expectation: step.expectation };
}

function escapeCell(text: string): string {
  return text.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

const STATUS_ICON: Record<AaosSmokeStepStatus, string> = {
  passed: "✅",
  failed: "❌",
  skipped: "⏭️",
};

/** Markdown for `$GITHUB_STEP_SUMMARY`: verdict first, the first failure called out, then every step. */
export function renderAaosSmokeSummary(result: AaosSmokeResult): string {
  const firstFailure = result.steps.find((step) => step.status === "failed");
  const lines = [
    "## AAOS emulator smoke (advisory)",
    "",
    result.ok
      ? "**Passed**: every step met its expectation."
      : `**Failed** at \`${firstFailure?.id ?? "unknown"}\` (\`${firstFailure?.tool ?? "?"}\`): ${escapeCell(firstFailure?.detail ?? "no detail")}`,
    "",
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

async function main(): Promise<void> {
  const { copyFileSync, mkdirSync, writeFileSync, appendFileSync } = await import("node:fs");
  const { dirname } = await import("node:path");
  const { createSdkClient, defaultServerPath, resolveTimeoutMs } = await import("../../mcp-drive");
  const outDir = process.env.AAOS_SMOKE_OUT_DIR ?? join(process.cwd(), "scratch", "aaos-smoke");
  const plan = buildAaosSmokePlan({
    breakAssertion: process.env.AAOS_SMOKE_BREAK_ASSERTION === "1",
    osVersion: process.env.AAOS_SMOKE_OS_VERSION,
  });
  const client = await createSdkClient(
    defaultServerPath(),
    resolveTimeoutMs(undefined, process.env),
  );
  const result = await runAaosSmoke(plan, {
    client,
    outDir,
    writeFile: (path, contents) => {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, contents);
    },
    copyFile: (from, to) => {
      try {
        mkdirSync(dirname(to), { recursive: true });
        copyFileSync(from, to);
        return true;
      } catch (error) {
        console.warn(
          `copy ${from} failed: ${error instanceof Error ? error.message : String(error)}`,
        );
        return false;
      }
    },
    now: () => Date.now(),
    log: (message) => console.log(message),
  });
  const summary = renderAaosSmokeSummary(result);
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, "summary.md"), summary);
  writeFileSync(join(outDir, "result.json"), JSON.stringify(result, null, 2));
  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary);
  }
  console.log(summary);
  process.exit(result.ok ? 0 : 1);
}

if (import.meta.main) {
  void main();
}
