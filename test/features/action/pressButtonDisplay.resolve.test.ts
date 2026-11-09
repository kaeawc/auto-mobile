import { describe, expect, test } from "bun:test";
import {
  resolvePressButtonDisplay,
  type PressButtonDisplayState,
} from "../../../src/features/action/pressButtonDisplay";
import type { BootedDevice } from "../../../src/models";
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
