#!/usr/bin/env bun
/** Advisory Android TV smoke for focus navigation and fixture selection. */
import { join } from "node:path";
import {
  assertHasHierarchy,
  expectForeground,
  passes,
  runSmokeMain,
  type Payload,
  type SmokeStep,
} from "../emulator-smoke/smokeRunner";

export const TV_SMOKE_TITLE = "Android TV emulator smoke (advisory)";

/** Exact fixture contract mirrored from TvFixtureCatalog in android/tv-fixture. */
export const TV_FIXTURE = {
  appId: "dev.jasonpearson.automobile.tvfixture",
  appTitle: "AutoMobile TV",
  statusReady: "Ready",
  focusNone: "Focused: none",
  navSearch: "Search",
  navPlayer: "Player",
  featuredRow: "Featured",
  moviesRow: "Movies",
  showsRow: "Shows",
  focusTarget: "Movies 03",
  focusTargetStatus: "Focused: Movies 03",
  selectedDetail: "Detail for Movies 03",
} as const;

const START_TIMEOUT_MS = 600_000;
const BROKEN_APP_ID = "com.example.deliberately.broken";

export interface TvSmokePlanOptions {
  fixtureApkPath?: string;
  avdName?: string;
  osVersion?: string;
  breakAssertion?: boolean;
}

export function assertTvDevice(payload: Payload): string | undefined {
  return payload.formFactor === "tv"
    ? undefined
    : `expected formFactor tv, startDevice reported ${String(payload.formFactor ?? "none")}`;
}

export function payloadMentions(payload: Payload, text: string): boolean {
  return JSON.stringify(payload).includes(text);
}

export function expectText(appId: string, text: string) {
  const foreground = expectForeground(appId);
  return (payload: Payload): string | undefined =>
    foreground(payload) ??
    (payloadMentions(payload, text) ? undefined : `"${text}" is not on screen`);
}

export function assertFocusChanged(payload: Payload): string | undefined {
  const text = JSON.stringify(payload);
  return text.includes("Focused: ") && !text.includes(TV_FIXTURE.focusNone)
    ? undefined
    : "D-pad right did not move focus from the initial state";
}

export function assertFocusedTarget(payload: Payload): string | undefined {
  if (payload.status !== "focused") {
    return `expected focusNavigate status focused, observed ${String(payload.status ?? "none")}`;
  }
  return payloadMentions(payload, TV_FIXTURE.focusTarget)
    ? undefined
    : `focusNavigate did not report ${TV_FIXTURE.focusTarget}`;
}

export function assertSelected(payload: Payload): string | undefined {
  if (payload.status !== "focused" || payload.selected !== true) {
    return `expected focusNavigate to select ${TV_FIXTURE.focusTarget}`;
  }
  return undefined;
}

function observeStep(id: string, expectation: string, assert: SmokeStep["assert"]): SmokeStep {
  return {
    id,
    tool: "observe",
    args: { platform: "android", screenshot: "settled" },
    expectation,
    assert,
  };
}

function step(
  id: string,
  tool: string,
  args: Record<string, unknown>,
  expectation: string,
  assert: SmokeStep["assert"] = passes,
): SmokeStep {
  return { id, tool, args: { platform: "android", ...args }, expectation, assert };
}

export function buildTvSmokePlan(options: TvSmokePlanOptions = {}): SmokeStep[] {
  const { appId } = TV_FIXTURE;
  const osVersion = options.osVersion ?? "16";
  const target = options.avdName
    ? { avdName: options.avdName }
    : { createIfMissing: true, minOsVersion: osVersion, maxOsVersion: osVersion };
  return [
    step(
      "start",
      "startDevice",
      {
        formFactor: "tv",
        ...target,
        timeoutMs: START_TIMEOUT_MS,
        enableTools: ["focusNavigate"],
      },
      options.avdName
        ? `the ${options.avdName} TV boots`
        : "a TV AVD is created or reused and boots",
      assertTvDevice,
    ),
    observeStep("observe-initial", "the TV has an observable hierarchy", assertHasHierarchy),
    step(
      "install",
      "installApp",
      { artifactPath: options.fixtureApkPath ?? "", grantAllPermissions: true },
      "the TV fixture installs with its permissions granted",
    ),
    step("launch", "launchApp", { appId }, `${appId} launches`),
    observeStep(
      "observe-launched",
      `the fixture is foreground and shows ${TV_FIXTURE.appTitle}`,
      expectText(options.breakAssertion ? BROKEN_APP_ID : appId, TV_FIXTURE.appTitle),
    ),
    observeStep(
      "observe-catalog",
      "the fixture shows its navigation, rows, and ready status",
      (payload) => {
        const foreground = expectForeground(appId)(payload);
        if (foreground) {
          return foreground;
        }
        const required = [
          TV_FIXTURE.statusReady,
          TV_FIXTURE.navSearch,
          TV_FIXTURE.navPlayer,
          TV_FIXTURE.featuredRow,
          TV_FIXTURE.moviesRow,
          TV_FIXTURE.showsRow,
        ];
        const missing = required.find((text) => !payloadMentions(payload, text));
        return missing ? `"${missing}" is not on screen` : undefined;
      },
    ),
    step("dpad-right", "pressButton", { button: "right" }, "D-pad right moves focus"),
    observeStep("observe-dpad-right", "focus status changed after D-pad right", assertFocusChanged),
    step(
      "navigate-to-card",
      "focusNavigate",
      { until: { text: TV_FIXTURE.focusTarget }, maxSteps: 30 },
      `focusNavigate reaches ${TV_FIXTURE.focusTarget}`,
      assertFocusedTarget,
    ),
    observeStep(
      "observe-focused-card",
      `the fixture reports ${TV_FIXTURE.focusTargetStatus}`,
      expectText(appId, TV_FIXTURE.focusTargetStatus),
    ),
    step(
      "select-card",
      "focusNavigate",
      { until: { text: TV_FIXTURE.focusTarget }, maxSteps: 5, select: true },
      `focusNavigate selects ${TV_FIXTURE.focusTarget}`,
      assertSelected,
    ),
    observeStep(
      "observe-selected-card",
      `the detail screen shows ${TV_FIXTURE.selectedDetail}`,
      expectText(appId, TV_FIXTURE.selectedDetail),
    ),
    step("back", "pressButton", { button: "back" }, "back is delivered"),
    step("home", "pressButton", { button: "home" }, "home is delivered"),
  ];
}

export function tvSmokeOptionsFromEnv(env: Record<string, string | undefined>): TvSmokePlanOptions {
  const nonEmpty = (value: string | undefined) =>
    value !== undefined && value.length > 0 ? value : undefined;
  return {
    fixtureApkPath: nonEmpty(env.TV_SMOKE_FIXTURE_APK),
    avdName: nonEmpty(env.TV_SMOKE_AVD_NAME),
    osVersion: nonEmpty(env.TV_SMOKE_OS_VERSION),
    breakAssertion: env.TV_SMOKE_BREAK_ASSERTION === "1",
  };
}

if (import.meta.main) {
  const options = tvSmokeOptionsFromEnv(process.env);
  void runSmokeMain({
    title: TV_SMOKE_TITLE,
    outDir: process.env.TV_SMOKE_OUT_DIR ?? join(process.cwd(), "scratch", "tv-smoke"),
    plan: buildTvSmokePlan(options),
  });
}
