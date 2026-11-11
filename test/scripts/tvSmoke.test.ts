import { describe, expect, test } from "bun:test";
import {
  assertFocusChanged,
  assertFocusedTarget,
  assertSelected,
  assertTvDevice,
  buildTvSmokePlan,
  expectText,
  TV_FIXTURE,
  tvSmokeOptionsFromEnv,
} from "../../scripts/ci/tv-smoke/tvSmoke";
import type { Payload } from "../../scripts/ci/emulator-smoke/smokeRunner";

function screen(appId: string, ...labels: string[]): Payload {
  return {
    activeWindow: { appId },
    skeleton: labels.map((label, index) => ({ elementId: `e${index}`, label })),
  };
}

describe("buildTvSmokePlan", () => {
  test("starts a TV at the pinned Android version and enables focus navigation", () => {
    const [start] = buildTvSmokePlan();
    expect(start.tool).toBe("startDevice");
    expect(start.args).toMatchObject({
      formFactor: "tv",
      createIfMissing: true,
      minOsVersion: "16",
      maxOsVersion: "16",
      enableTools: ["focusNavigate"],
    });
  });

  test("boots a named AVD without createIfMissing", () => {
    const [start] = buildTvSmokePlan({ avdName: "named-tv" });
    expect(start.args.avdName).toBe("named-tv");
    expect(start.args.createIfMissing).toBeUndefined();
  });

  test("installs, launches, drives D-pad focus, navigates, selects, and exits", () => {
    const plan = buildTvSmokePlan({ fixtureApkPath: "/tv.apk" });
    expect(plan.find((step) => step.id === "install")?.args).toMatchObject({
      artifactPath: "/tv.apk",
      grantAllPermissions: true,
    });
    expect(plan.find((step) => step.id === "launch")?.args).toMatchObject({
      appId: TV_FIXTURE.appId,
    });
    expect(plan.find((step) => step.id === "dpad-right")?.args).toMatchObject({ button: "right" });
    expect(plan.find((step) => step.id === "navigate-to-card")?.args).toMatchObject({
      until: { text: TV_FIXTURE.focusTarget },
      maxSteps: 30,
    });
    expect(plan.find((step) => step.id === "select-card")?.args).toMatchObject({
      until: { text: TV_FIXTURE.focusTarget },
      select: true,
    });
    expect(plan.slice(-2).map((step) => step.args.button)).toEqual(["back", "home"]);
  });

  test("reads smoke configuration from its environment", () => {
    expect(
      tvSmokeOptionsFromEnv({
        TV_SMOKE_FIXTURE_APK: "/fixture.apk",
        TV_SMOKE_AVD_NAME: "tv-avd",
        TV_SMOKE_OS_VERSION: "16",
        TV_SMOKE_BREAK_ASSERTION: "1",
      }),
    ).toEqual({
      fixtureApkPath: "/fixture.apk",
      avdName: "tv-avd",
      osVersion: "16",
      breakAssertion: true,
    });
  });
});

describe("TV smoke assertions", () => {
  test("requires Android TV form factor", () => {
    expect(assertTvDevice({ formFactor: "tv" })).toBeUndefined();
    expect(assertTvDevice({ formFactor: "phone" })).toContain("reported phone");
  });

  test("requires D-pad movement away from the initial focus state", () => {
    expect(assertFocusChanged(screen(TV_FIXTURE.appId, "Focused: Movies 01"))).toBeUndefined();
    expect(assertFocusChanged(screen(TV_FIXTURE.appId, TV_FIXTURE.focusNone))).toContain(
      "did not move focus",
    );
  });

  test("checks focusNavigate and selected results", () => {
    expect(
      assertFocusedTarget({ status: "focused", focusedElement: { text: TV_FIXTURE.focusTarget } }),
    ).toBeUndefined();
    expect(assertFocusedTarget({ status: "max_steps" })).toContain("status focused");
    expect(assertSelected({ status: "focused", selected: true })).toBeUndefined();
    expect(assertSelected({ status: "focused", selected: false })).toContain("select");
  });

  test("requires fixture text and the foreground app", () => {
    expect(
      expectText(
        TV_FIXTURE.appId,
        TV_FIXTURE.appTitle,
      )(screen(TV_FIXTURE.appId, TV_FIXTURE.appTitle)),
    ).toBeUndefined();
    expect(
      expectText(TV_FIXTURE.appId, TV_FIXTURE.appTitle)(screen(TV_FIXTURE.appId, "Ready")),
    ).toContain("is not on screen");
    expect(
      expectText(TV_FIXTURE.appId, TV_FIXTURE.appTitle)(screen("other", TV_FIXTURE.appTitle)),
    ).toContain("observed other");
  });
});
