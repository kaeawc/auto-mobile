#!/usr/bin/env bun
/**
 * Advisory nightly Wear OS emulator smoke (#16829).
 *
 * Drives one persistent MCP session through a fixed plan on a round x86_64 Wear OS emulator:
 * start the watch, observe (hierarchy and `isScreenRound`), then, when the Wear fixture APK
 * (#16828) is supplied, install and launch it, scroll to a list row, tap it, go back, move the
 * rotary picker with `rotaryScroll`, post the fixture notification, go home, find the
 * notification and tap one of its actions with `systemTray`, check the app reports that action,
 * and finally enter and exit ambient. Without the fixture only the device-level steps run and the
 * summary says why. The plan runs on the shared emulator smoke runner
 * (`scripts/ci/emulator-smoke/smokeRunner.ts`).
 */
import { join } from "node:path";
import {
  assertHasHierarchy,
  expectForeground,
  expectNotForeground,
  passes,
  runSmokeMain,
  type Payload,
  type SmokeStep,
} from "../emulator-smoke/smokeRunner";

export const WEAR_SMOKE_TITLE = "Wear OS emulator smoke (advisory)";

/**
 * What the smoke expects of the Wear fixture app (#16828): its package, a list row that is
 * below the first screen, the text its detail screen shows, the row above the item list that
 * opens the rotary picker, the picker's initial value, the row that posts the notification, the
 * notification's title, the action the smoke taps, and the status line that action leaves.
 * These mirror `WearFixtureCatalog` in android/wear-fixture; keep them in step with it.
 */
export const WEAR_FIXTURE = {
  appId: "dev.jasonpearson.automobile.wearfixture",
  listRowText: "Item 20",
  detailText: "Detail for Item 20",
  pickerRowText: "Rotary picker",
  pickerInitialText: "Level 0",
  postNotificationRowText: "Post notification",
  notificationTitle: "Fixture alert",
  notificationActionLabel: "Archive",
  notificationActionStatus: "Notification action: Archive",
} as const;

const START_TIMEOUT_MS = 600_000;

export interface WearSmokePlanOptions {
  /** Host path of the built fixture APK; without it only the device-level steps run. */
  fixtureApkPath?: string;
  /**
   * Exact name of an AVD the runner created. When unset, startDevice creates the watch itself
   * with `createIfMissing` (#16823).
   */
  avdName?: string;
  /** Android major version startDevice is pinned to when it creates the watch. */
  osVersion?: string;
  /** Replace one assertion with an impossible one, to prove a broken assertion fails the job. */
  breakAssertion?: boolean;
}

/** startDevice must report a watch. */
export function assertWatchDevice(payload: Payload): string | undefined {
  return payload.formFactor === "watch"
    ? undefined
    : `expected formFactor watch, startDevice reported ${String(payload.formFactor ?? "none")}`;
}

/** observe on the round profile must carry a hierarchy and `isScreenRound: true`. */
export function assertRoundObservation(payload: Payload): string | undefined {
  const missing = assertHasHierarchy(payload);
  if (missing) {
    return missing;
  }
  return payload.isScreenRound === true
    ? undefined
    : `expected isScreenRound true on a round watch, observed ${String(payload.isScreenRound ?? "none")}`;
}

/** Whether `text` appears anywhere in the payload (hierarchy, skeleton labels, or elements). */
export function payloadMentions(payload: Payload, text: string): boolean {
  return JSON.stringify(payload).includes(text);
}

export function expectText(appId: string, text: string) {
  const foreground = expectForeground(appId);
  return (payload: Payload): string | undefined =>
    foreground(payload) ??
    (payloadMentions(payload, text) ? undefined : `"${text}" is not on screen`);
}

export function expectNoText(appId: string, text: string) {
  const foreground = expectForeground(appId);
  return (payload: Payload): string | undefined =>
    foreground(payload) ??
    (payloadMentions(payload, text) ? `"${text}" is still on screen` : undefined);
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
  extra: Partial<Pick<SmokeStep, "assert" | "always">> = {},
): SmokeStep {
  return {
    id,
    tool,
    args: { platform: "android", ...args },
    expectation,
    assert: passes,
    ...extra,
  };
}

function startStep(options: WearSmokePlanOptions): SmokeStep {
  const target = options.avdName
    ? { avdName: options.avdName }
    : {
        createIfMissing: true,
        minOsVersion: options.osVersion ?? "17",
        maxOsVersion: options.osVersion ?? "17",
      };
  return step(
    "start",
    "startDevice",
    {
      formFactor: "watch",
      ...target,
      timeoutMs: START_TIMEOUT_MS,
      enableTools: ["rotaryScroll", "ambient"],
    },
    options.avdName
      ? `the ${options.avdName} watch boots`
      : "a round watch AVD is created or reused and boots",
    { assert: assertWatchDevice },
  );
}

const BROKEN_APP_ID = "com.example.deliberately.broken";

function fixtureSteps(apkPath: string, breakAssertion: boolean): SmokeStep[] {
  const { appId, listRowText, detailText, pickerRowText, pickerInitialText } = WEAR_FIXTURE;
  return [
    // The grant covers POST_NOTIFICATIONS, so posting never stops at a permission dialog.
    step(
      "install",
      "installApp",
      { artifactPath: apkPath, grantAllPermissions: true },
      "the Wear fixture installs with its permissions granted",
    ),
    step("launch", "launchApp", { appId }, `${appId} launches`),
    observeStep(
      "observe-launched",
      `${appId} is foreground`,
      expectForeground(breakAssertion ? BROKEN_APP_ID : appId),
    ),
    step(
      "scroll-to-row",
      "swipeOn",
      { direction: "up", lookFor: { text: listRowText } },
      `scroll the list until "${listRowText}" is visible`,
    ),
    step(
      "tap-row",
      "tapOn",
      { action: "tap", selector: { text: listRowText } },
      `tap "${listRowText}"`,
    ),
    observeStep("observe-detail", `"${detailText}" is shown`, expectText(appId, detailText)),
    step("back", "pressButton", { button: "back" }, "back closes the detail screen"),
    observeStep("observe-list", "the detail screen is gone", expectNoText(appId, detailText)),
    // The picker row sits above the item list, so scroll back towards the top.
    step(
      "scroll-to-picker",
      "swipeOn",
      { direction: "down", lookFor: { text: pickerRowText } },
      `scroll the list until "${pickerRowText}" is visible`,
    ),
    step(
      "open-picker",
      "tapOn",
      { action: "tap", selector: { text: pickerRowText } },
      `tap "${pickerRowText}"`,
    ),
    observeStep(
      "observe-picker",
      `the picker shows "${pickerInitialText}"`,
      expectText(appId, pickerInitialText),
    ),
    step("rotary", "rotaryScroll", { delta: 3 }, "three crown detents move the picker"),
    observeStep(
      "observe-rotated",
      `the picker left "${pickerInitialText}"`,
      expectNoText(appId, pickerInitialText),
    ),
    step("picker-back", "pressButton", { button: "back" }, "back closes the picker"),
    ...notificationSteps(),
  ];
}

/**
 * Post the fixture notification from the app, leave for the watch face, then find it in the
 * notification stream and tap one of its actions; the action reopens the app with a status line
 * naming it.
 */
function notificationSteps(): SmokeStep[] {
  const {
    appId,
    postNotificationRowText,
    notificationTitle,
    notificationActionLabel,
    notificationActionStatus,
  } = WEAR_FIXTURE;
  const notification = { title: notificationTitle, appId };
  return [
    step(
      "scroll-to-post",
      "swipeOn",
      { direction: "up", lookFor: { text: postNotificationRowText } },
      `scroll the list until "${postNotificationRowText}" is visible`,
    ),
    step(
      "post-notification",
      "tapOn",
      { action: "tap", selector: { text: postNotificationRowText } },
      `tap "${postNotificationRowText}"`,
    ),
    // systemTray opens the watch stream from the watch face.
    step("home", "homeScreen", {}, "home is delivered"),
    observeStep("observe-home", `${appId} left the foreground`, expectNotForeground(appId)),
    step(
      "find-notification",
      "systemTray",
      { action: "find", notification },
      `the "${notificationTitle}" notification is in the stream`,
    ),
    step(
      "notification-action",
      "systemTray",
      { action: "tap", notification: { ...notification, tapActionLabel: notificationActionLabel } },
      `tap the "${notificationActionLabel}" action`,
    ),
    observeStep(
      "observe-notification-action",
      `the fixture reports "${notificationActionStatus}"`,
      expectText(appId, notificationActionStatus),
    ),
  ];
}

function deviceOnlySteps(breakAssertion: boolean): SmokeStep[] {
  return [
    step("home", "homeScreen", {}, "home is delivered"),
    step("back", "pressButton", { button: "back" }, "back is delivered"),
    observeStep(
      "observe-after-back",
      "the watch is still observable",
      breakAssertion ? expectForeground(BROKEN_APP_ID) : assertHasHierarchy,
    ),
  ];
}

/** The fixed nightly plan. */
export function buildWearSmokePlan(options: WearSmokePlanOptions = {}): SmokeStep[] {
  const breakAssertion = options.breakAssertion === true;
  return [
    startStep(options),
    observeStep(
      "observe-initial",
      "hierarchy is observable and isScreenRound is true",
      assertRoundObservation,
    ),
    ...(options.fixtureApkPath
      ? fixtureSteps(options.fixtureApkPath, breakAssertion)
      : deviceOnlySteps(breakAssertion)),
    step("ambient-enter", "ambient", { action: "enter" }, "the watch dozes or sleeps"),
    // Always wake the watch, so diagnostics and later steps see an awake screen.
    step("ambient-exit", "ambient", { action: "exit" }, "the watch is awake again", {
      always: true,
    }),
  ];
}

/** Summary notes: say when the fixture steps did not run, so a pass is not over-read. */
export function wearSmokeNotes(options: WearSmokePlanOptions): string[] {
  return options.fixtureApkPath
    ? []
    : [
        "The Wear fixture app (#16828) was not built, so only the device-level steps ran: list, detail, rotary picker, notification and fixture assertions were skipped.",
      ];
}

/** Read the plan options from the environment the runner script sets. */
export function wearSmokeOptionsFromEnv(
  env: Record<string, string | undefined>,
): WearSmokePlanOptions {
  const nonEmpty = (value: string | undefined) =>
    value !== undefined && value.length > 0 ? value : undefined;
  return {
    fixtureApkPath: nonEmpty(env.WEAR_SMOKE_FIXTURE_APK),
    avdName: nonEmpty(env.WEAR_SMOKE_AVD_NAME),
    osVersion: nonEmpty(env.WEAR_SMOKE_OS_VERSION),
    breakAssertion: env.WEAR_SMOKE_BREAK_ASSERTION === "1",
  };
}

if (import.meta.main) {
  const options = wearSmokeOptionsFromEnv(process.env);
  void runSmokeMain({
    title: WEAR_SMOKE_TITLE,
    outDir: process.env.WEAR_SMOKE_OUT_DIR ?? join(process.cwd(), "scratch", "wear-smoke"),
    plan: buildWearSmokePlan(options),
    notes: wearSmokeNotes(options),
  });
}
