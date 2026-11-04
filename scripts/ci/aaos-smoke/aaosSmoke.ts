#!/usr/bin/env bun
/**
 * Advisory nightly Android Automotive OS emulator smoke (#16746).
 *
 * Drives one persistent MCP session through a fixed plan: create and boot an automotive AVD
 * with startDevice `createIfMissing`, then observe, launch, tap, scroll, back, home and the
 * driving/parked vehicle states. The plan runs on the shared emulator smoke runner
 * (`scripts/ci/emulator-smoke/smokeRunner.ts`), which records each payload and screenshot and
 * renders the Markdown summary.
 */
import { join } from "node:path";
import {
  activeAppId,
  assertHasHierarchy,
  expectForeground,
  expectNotForeground,
  passes,
  readObject,
  renderSmokeSummary,
  runSmoke,
  runSmokeMain,
  writeSmokeOutputs,
  type Payload,
  type SmokeDeps,
  type SmokeOutputDeps,
  type SmokeResult,
  type SmokeStep,
  type SmokeStepResult,
  type SmokeStepStatus,
} from "../emulator-smoke/smokeRunner";

export { activeAppId, expectNotForeground, type Payload };
export type AaosSmokeStep = SmokeStep;
export type AaosSmokeStepStatus = SmokeStepStatus;
export type AaosSmokeStepResult = SmokeStepResult;
export type AaosSmokeResult = SmokeResult;
export type AaosSmokeDeps = SmokeDeps;
export type AaosSmokeOutputDeps = SmokeOutputDeps;

export const AAOS_SMOKE_TITLE = "AAOS emulator smoke (advisory)";

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

/** An observe payload must carry a hierarchy and a landscape screen, as a car head unit has. */
export function assertLandscapeObservation(payload: Payload): string | undefined {
  const missing = assertHasHierarchy(payload);
  if (missing) {
    return missing;
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

/** Run the plan over one session; see {@link runSmoke}. */
export function runAaosSmoke(
  plan: readonly AaosSmokeStep[],
  deps: AaosSmokeDeps,
): Promise<AaosSmokeResult> {
  return runSmoke(plan, deps);
}

/** Markdown for `$GITHUB_STEP_SUMMARY`. */
export function renderAaosSmokeSummary(result: AaosSmokeResult): string {
  return renderSmokeSummary(AAOS_SMOKE_TITLE, result);
}

/** Write `summary.md`, `result.json` and the job step summary; see {@link writeSmokeOutputs}. */
export function writeAaosSmokeOutputs(
  result: AaosSmokeResult,
  summary: string,
  deps: AaosSmokeOutputDeps,
): string[] {
  return writeSmokeOutputs(result, summary, deps);
}

if (import.meta.main) {
  void runSmokeMain({
    title: AAOS_SMOKE_TITLE,
    outDir: process.env.AAOS_SMOKE_OUT_DIR ?? join(process.cwd(), "scratch", "aaos-smoke"),
    plan: buildAaosSmokePlan({
      breakAssertion: process.env.AAOS_SMOKE_BREAK_ASSERTION === "1",
      osVersion: process.env.AAOS_SMOKE_OS_VERSION,
    }),
  });
}
