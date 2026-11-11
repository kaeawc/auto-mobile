#!/usr/bin/env bun
/** Advisory nightly Android XR headset emulator smoke. */
import { join } from "node:path";
import {
  assertHasHierarchy,
  expectForeground,
  expectNotForeground,
  passes,
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

export { expectNotForeground, type Payload };
export type XrSmokeStep = SmokeStep;
export type XrSmokeStepStatus = SmokeStepStatus;
export type XrSmokeStepResult = SmokeStepResult;
export type XrSmokeResult = SmokeResult;
export type XrSmokeDeps = SmokeDeps;
export type XrSmokeOutputDeps = SmokeOutputDeps;

export const XR_SMOKE_TITLE = "Android XR emulator smoke (advisory)";
export const XR_SETTINGS_APP_ID = "com.android.settings";
export const XR_SETTINGS_TAP_TEXT = "Connected devices";
const START_TIMEOUT_MS = 600_000;

export interface XrSmokePlanOptions {
  breakAssertion?: boolean;
  osVersion?: string;
  tapText?: string;
  /** Boot this exact AVD instead of createIfMissing (local runs on a private AVD). */
  avdName?: string;
}

export function assertXrHeadsetDevice(payload: Payload): string | undefined {
  return payload.formFactor === "xr-headset"
    ? undefined
    : `expected formFactor xr-headset, startDevice reported ${String(payload.formFactor ?? "none")}`;
}

export function assertXrObservation(payload: Payload): string | undefined {
  return assertHasHierarchy(payload);
}

function observeStep(id: string, expectation: string, assert: XrSmokeStep["assert"]) {
  return {
    id,
    tool: "observe",
    args: { platform: "android", screenshot: "settled" },
    expectation,
    assert,
  } satisfies XrSmokeStep;
}

export function buildXrSmokePlan(options: XrSmokePlanOptions = {}): XrSmokeStep[] {
  const osVersion = options.osVersion ?? "14";
  const tapText = options.tapText ?? XR_SETTINGS_TAP_TEXT;
  const settingsForeground = options.breakAssertion
    ? expectForeground("com.example.deliberately.broken")
    : expectForeground(XR_SETTINGS_APP_ID);
  return [
    {
      id: "start",
      tool: "startDevice",
      args: {
        platform: "android",
        formFactor: "xr-headset",
        ...(options.avdName
          ? { avdName: options.avdName }
          : { createIfMissing: true, minOsVersion: osVersion, maxOsVersion: osVersion }),
        timeoutMs: START_TIMEOUT_MS,
      },
      expectation: "an XR headset AVD is created or reused and boots",
      assert: assertXrHeadsetDevice,
    },
    observeStep("observe-initial", "XR headset hierarchy is observable", assertXrObservation),
    {
      id: "launch",
      tool: "launchApp",
      args: { platform: "android", appId: XR_SETTINGS_APP_ID },
      expectation: `${XR_SETTINGS_APP_ID} launches`,
      assert: passes,
    },
    observeStep("observe-launched", `${XR_SETTINGS_APP_ID} is foreground`, settingsForeground),
    {
      id: "tap-row",
      tool: "tapOn",
      args: { platform: "android", action: "tap", selector: { text: tapText } },
      expectation: `tap "${tapText}" in Settings`,
      assert: passes,
    },
    observeStep("observe-row", "Settings remains observable after row tap", assertXrObservation),
    {
      id: "tap-panel",
      tool: "tapAt",
      // Fixed native coordinates (1320, 1056), the right-pane heading of the 2560x2558 headset panel (see scripts/README.md).
      args: { platform: "android", x: 1320, y: 1056 },
      expectation: "tap a point inside the default XR panel",
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
      `${XR_SETTINGS_APP_ID} left the foreground`,
      expectNotForeground(XR_SETTINGS_APP_ID),
    ),
  ];
}

export function runXrSmoke(
  plan: readonly XrSmokeStep[],
  deps: XrSmokeDeps,
): Promise<XrSmokeResult> {
  return runSmoke(plan, deps);
}
export function renderXrSmokeSummary(result: XrSmokeResult): string {
  return renderSmokeSummary(XR_SMOKE_TITLE, result);
}
export function writeXrSmokeOutputs(
  result: XrSmokeResult,
  summary: string,
  deps: XrSmokeOutputDeps,
): string[] {
  return writeSmokeOutputs(result, summary, deps);
}

if (import.meta.main) {
  void runSmokeMain({
    title: XR_SMOKE_TITLE,
    outDir: process.env.XR_SMOKE_OUT_DIR ?? join(process.cwd(), "scratch", "xr-smoke"),
    plan: buildXrSmokePlan({
      breakAssertion: process.env.XR_SMOKE_BREAK_ASSERTION === "1",
      osVersion: process.env.XR_SMOKE_OS_VERSION,
      tapText: process.env.XR_SMOKE_TAP_TEXT,
      avdName: process.env.XR_SMOKE_AVD_NAME || undefined,
    }),
  });
}
