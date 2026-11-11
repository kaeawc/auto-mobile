import { describe, expect, test } from "bun:test";
import {
  assertXrHeadsetDevice,
  assertXrObservation,
  buildXrSmokePlan,
  expectNotForeground,
  XR_SETTINGS_APP_ID,
} from "../../scripts/ci/xr-smoke/xrSmoke";

describe("XR smoke plan", () => {
  test("pins start, UI flow and final home observation", () => {
    const plan = buildXrSmokePlan();
    expect(plan.map(({ id }) => id)).toEqual([
      "start",
      "observe-initial",
      "launch",
      "observe-launched",
      "tap-row",
      "observe-row",
      "tap-panel",
      "home",
      "observe-home",
    ]);
    expect(plan.map(({ tool }) => tool)).toEqual([
      "startDevice",
      "observe",
      "launchApp",
      "observe",
      "tapOn",
      "observe",
      "tapAt",
      "homeScreen",
      "observe",
    ]);
    expect(plan[0]?.args).toMatchObject({
      platform: "android",
      formFactor: "xr-headset",
      createIfMissing: true,
      timeoutMs: 600000,
    });
    expect(plan[4]?.args).toMatchObject({ selector: { text: "Connected devices" } });
    expect(plan[6]?.args).toMatchObject({ x: 1320, y: 1056 });
  });
  test("break assertion swaps foreground app expectation", () => {
    expect(
      buildXrSmokePlan()[3]?.assert({ activeWindow: { appId: XR_SETTINGS_APP_ID } }),
    ).toBeUndefined();
    expect(
      buildXrSmokePlan({ breakAssertion: true })[3]?.assert({
        activeWindow: { appId: XR_SETTINGS_APP_ID },
      }),
    ).toContain("com.example.deliberately.broken");
  });
});

describe("XR smoke assertions", () => {
  test("headset identity and hierarchy fail before passing", () => {
    expect(assertXrHeadsetDevice({ formFactor: "phone" })).toContain("phone");
    expect(assertXrHeadsetDevice({ formFactor: "xr-headset" })).toBeUndefined();
    expect(assertXrObservation({})).toContain("no skeleton or view hierarchy");
    expect(assertXrObservation({ skeleton: [{ elementId: "e1" }] })).toBeUndefined();
  });
  test("home observation rejects Settings foreground", () => {
    const check = expectNotForeground(XR_SETTINGS_APP_ID);
    expect(check({ activeWindow: { appId: XR_SETTINGS_APP_ID } })).toContain(
      "still in the foreground",
    );
    expect(check({ activeWindow: { appId: "com.android.launcher" } })).toBeUndefined();
  });
});
