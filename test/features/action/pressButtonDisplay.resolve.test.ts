import { afterEach, describe, expect, test } from "bun:test";
import {
  defaultPressButtonDisplayState,
  resolvePressButtonDisplay,
  type PressButtonDisplayState,
} from "../../../src/features/action/pressButtonDisplay";
import { ObservedAndroidDisplayCache } from "../../../src/features/observe/ObservationDisplay";
import type { BootedDevice } from "../../../src/models";
import { displayInventoryOutcome } from "../../../src/models/DeviceInfo";
import { DisplayInventoryUnavailableError } from "../../../src/models/DisplayInventoryUnavailableError";
import { createExecResult } from "../../../src/utils/execResult";
import { FakeAdbExecutor } from "../../fakes/FakeAdbExecutor";

const LOGICAL_IDS: Record<string, number> = { main: 0, passenger: 4 };

const multiDisplay: BootedDevice = {
  deviceId: "aaos-multi",
  platform: "android",
  name: "AAOS",
  displays: {
    panels: [
      { key: "main", role: "inner", sizePx: { width: 1280, height: 720 } },
      { key: "passenger", role: "external", sizePx: { width: 1280, height: 720 } },
    ],
    postures: [],
  },
};

/** Fake display state: the unscoped observation's focused panel and the live focused display. */
function fakeState({ focused, live }: { focused?: string; live: string }) {
  const liveReads: string[] = [];
  const state: PressButtonDisplayState = {
    focusedPanel: () => (focused === undefined ? undefined : { key: focused }),
    liveDisplay: async (device) => {
      liveReads.push(device.deviceId);
      return { key: live, posture: "unknown" };
    },
    logicalIdForPanel: async (_device, _adb, key) => LOGICAL_IDS[key],
  };
  return { state, liveReads };
}

describe("resolvePressButtonDisplay (#17649)", () => {
  test("unreadable inventory rejects an explicit role before resolving a logical display", async () => {
    const adb = new FakeAdbExecutor();
    const { state, liveReads } = fakeState({ live: "main" });
    const target: BootedDevice = {
      ...multiDisplay,
      displays: undefined,
      [displayInventoryOutcome]: { kind: "unreadable", reason: "dumpsys display timed out" },
    };
    const read = resolvePressButtonDisplay(target, "inner", { adb, state });
    await expect(read).rejects.toBeInstanceOf(DisplayInventoryUnavailableError);
    await expect(read).rejects.toMatchObject({ details: { retryable: true } });
    expect(liveReads).toEqual([]);
    expect(adb.getExecutedCommands()).toEqual([]);
  });

  test("active is the unscoped observation's focused panel, not the last explicitly observed one", async () => {
    // The passenger panel was observed explicitly; that never moves the focused (main) panel.
    const { state, liveReads } = fakeState({ focused: "main", live: "passenger" });
    const target = await resolvePressButtonDisplay(multiDisplay, "active", {
      adb: new FakeAdbExecutor(),
      state,
    });
    expect(target).toEqual({ key: "main", displayId: 0 });
    expect(liveReads).toEqual([]);
  });

  test("active falls back to the live focused display before any unscoped observation", async () => {
    const { state, liveReads } = fakeState({ live: "passenger" });
    const target = await resolvePressButtonDisplay(multiDisplay, "active", {
      adb: new FakeAdbExecutor(),
      state,
    });
    expect(target).toEqual({ key: "passenger", displayId: 4 });
    expect(liveReads).toEqual(["aaos-multi"]);
  });

  test("an explicit main panel keeps logical display 0 while the passenger panel is focused", async () => {
    const { state, liveReads } = fakeState({ focused: "passenger", live: "passenger" });
    const target = await resolvePressButtonDisplay(multiDisplay, "main", {
      adb: new FakeAdbExecutor(),
      state,
    });
    expect(target).toEqual({ key: "main", displayId: 0 });
    expect(liveReads).toEqual([]);
  });

  test("a single-panel device resolves active without reading the live display", async () => {
    const single: BootedDevice = {
      ...multiDisplay,
      displays: { panels: [multiDisplay.displays!.panels[1]], postures: [] },
    };
    const { state, liveReads } = fakeState({ live: "main" });
    const target = await resolvePressButtonDisplay(single, "active", {
      adb: new FakeAdbExecutor(),
      state,
    });
    expect(target).toEqual({ key: "passenger", displayId: 4 });
    expect(liveReads).toEqual([]);
  });
});

describe("resolvePressButtonDisplay default display state (#17649)", () => {
  // Main is logical display 0 and passenger is logical display 4, as `cmd display get-displays` reports.
  const device: BootedDevice = {
    deviceId: "aaos-default-state",
    platform: "android",
    name: "AAOS",
    displays: {
      panels: [
        { key: "111", role: "inner", sizePx: { width: 1280, height: 720 } },
        { key: "222", role: "external", sizePx: { width: 1280, height: 720 } },
      ],
      postures: [],
    },
  };
  const GET_DISPLAYS = [
    'Display id 0: DisplayInfo{"Main", displayId 0, type INTERNAL, uniqueId "local:111", real 1280 x 720}',
    'Display id 4: DisplayInfo{"Passenger", displayId 4, type EXTERNAL, uniqueId "local:222", real 1280 x 720}',
  ].join("\n");
  // No unscoped observation has recorded a focused panel (only an explicit passenger observe ran).
  const state: PressButtonDisplayState = {
    ...defaultPressButtonDisplayState,
    focusedPanel: () => undefined,
  };

  function adbWithFocus(focusDump: string | Error): FakeAdbExecutor {
    const adb = new FakeAdbExecutor();
    adb.setCommandResponse("cmd display get-displays", createExecResult(GET_DISPLAYS, ""));
    if (focusDump instanceof Error) {
      adb.setCommandError("mTopFocusedDisplayId", focusDump);
    } else {
      adb.setCommandResponse("mTopFocusedDisplayId", createExecResult(focusDump, ""));
    }
    return adb;
  }

  afterEach(() => ObservedAndroidDisplayCache.release(device.deviceId));

  test("active resolves to the display holding input focus, not logical display 0", async () => {
    const adb = adbWithFocus("  mTopFocusedDisplayId=4\n");
    const target = await resolvePressButtonDisplay(device, "active", { adb, state });
    expect(target).toEqual({ key: "222", displayId: 4 });
  });

  test("active falls back to logical display 0 when input focus is unknown", async () => {
    const adb = adbWithFocus("");
    const target = await resolvePressButtonDisplay(device, "active", { adb, state });
    expect(target).toEqual({ key: "111", displayId: 0 });
  });

  test("active falls back to logical display 0 when the focus read fails", async () => {
    const adb = adbWithFocus(new Error("dumpsys window timed out"));
    const target = await resolvePressButtonDisplay(device, "active", { adb, state });
    expect(target).toEqual({ key: "111", displayId: 0 });
  });
});
