import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import {
  DisplayTransitionTracker,
  displayTransitions,
} from "../../../src/features/observe/DisplayTransition";
import { RealObserveScreen } from "../../../src/features/observe/ObserveScreen";
import { TapOnElement } from "../../../src/features/action/TapOnElement";
import type { HierarchyCapture } from "../../../src/features/observe/HierarchyCapture";
import type { BootedDevice, ObserveResult } from "../../../src/models";
import { FakeAdbExecutor } from "../../fakes/FakeAdbExecutor";
import { FakeAdbClientFactory } from "../../fakes/FakeAdbClientFactory";
import { FakeObserveCacheStore } from "../../fakes/FakeObserveCacheStore";
import { FakeTimer } from "../../fakes/FakeTimer";
import { FakeViewHierarchy } from "../../fakes/FakeViewHierarchy";
import { resetObserveCacheStore } from "../../../src/features/observe/cache/ObserveCacheRegistry";
import { setObserveCacheStore } from "../../../src/features/observe/cache/ObserveCacheRegistry";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const deviceStateFixture = (name: string): string =>
  readFileSync(join(import.meta.dir, "../../fixtures/android-display", name), "utf8");

const device: BootedDevice = {
  deviceId: "display-transition-test",
  name: "Foldable",
  platform: "android",
  displays: {
    panels: [
      { key: "inner", role: "inner", sizePx: { width: 200, height: 200 } },
      { key: "cover", role: "cover", sizePx: { width: 100, height: 100 } },
    ],
    postures: ["closed", "opened"],
  },
};

const options = {
  skipScreenshot: true,
  skipBackStack: true,
  skipRecompositionTracking: true,
  skipPerformanceAudit: true,
  skipAccessibilityAudit: true,
};

beforeEach(() => {
  displayTransitions.reset(device.deviceId);
  displayTransitions.reset("same-size-panels");
});

afterEach(() => {
  displayTransitions.reset(device.deviceId);
  displayTransitions.reset("same-size-panels");
  resetObserveCacheStore();
});

describe("display transitions", () => {
  test("geometry and identity changes invalidate once; unchanged captures preserve state", () => {
    const invalidations: string[] = [];
    const tracker = new DisplayTransitionTracker((_deviceId, reason) => invalidations.push(reason));
    const inner = {
      key: "inner",
      role: "inner" as const,
      posture: "opened" as const,
      generation: 1,
    };
    const cover = {
      key: "cover",
      role: "cover" as const,
      posture: "closed" as const,
      generation: 2,
    };
    expect(
      tracker.record(device.deviceId, { display: inner, screenSize: { width: 200, height: 200 } }),
    ).toBe(false);
    expect(
      tracker.record(device.deviceId, {
        display: { ...inner, generation: 3 },
        screenSize: { width: 200, height: 200 },
      }),
    ).toBe(false);
    expect(invalidations).toEqual([]);
    expect(tracker.checkIdentity(device.deviceId, cover)).toBe(true);
    expect(invalidations).toEqual(["display key, role, or posture changed"]);
    expect(
      tracker.record(device.deviceId, { display: cover, screenSize: { width: 100, height: 100 } }),
    ).toBe(false);
    expect(
      tracker.record(device.deviceId, { display: cover, screenSize: { width: 101, height: 100 } }),
    ).toBe(true);
    expect(invalidations).toHaveLength(2);
  });

  test("rotation keeps the panel and revision without invalidating", () => {
    const invalidations: string[] = [];
    const tracker = new DisplayTransitionTracker((_deviceId, reason) => invalidations.push(reason));
    const display = {
      key: "inner",
      role: "inner" as const,
      posture: "opened" as const,
      generation: 1,
    };
    tracker.record(device.deviceId, { display, screenSize: { width: 100, height: 200 } });
    expect(
      tracker.record(device.deviceId, {
        display,
        screenSize: { width: 200, height: 100 },
      }),
    ).toBe(false);
    expect(tracker.revision(device.deviceId)).toBe(0);
    expect(invalidations).toEqual([]);
  });

  test("a pushed fold invalidates once and the matching observation reconciles it", () => {
    const invalidations: string[] = [];
    const tracker = new DisplayTransitionTracker((_deviceId, reason) => invalidations.push(reason));
    const inner = {
      display: { key: "inner", role: "inner" as const, posture: "opened" as const, generation: 1 },
      screenSize: { width: 200, height: 100 },
    };
    const cover = {
      display: { key: "cover", role: "cover" as const, posture: "closed" as const, generation: 2 },
      screenSize: { width: 100, height: 100 },
    };
    tracker.record(device.deviceId, inner);
    tracker.notifyAndroidTransition(device.deviceId, {
      change: "changed",
      displayId: 0,
      panelUniqueId: "local:cover",
      width: 100,
      height: 100,
    });
    expect(tracker.revision(device.deviceId)).toBe(1);
    expect(invalidations).toEqual(["CtrlProxy changed"]);
    expect(tracker.checkIdentity(device.deviceId, cover.display)).toBe(false);
    expect(tracker.record(device.deviceId, cover)).toBe(false);
    expect(tracker.revision(device.deviceId)).toBe(1);
    expect(tracker.record(device.deviceId, cover)).toBe(false);
  });

  test("an unchanged observation consumes a later device-state push", () => {
    const invalidations: string[] = [];
    const tracker = new DisplayTransitionTracker((_deviceId, reason) => invalidations.push(reason));
    const inner = {
      display: { key: "inner", role: "inner" as const, posture: "opened" as const, generation: 1 },
      screenSize: { width: 200, height: 100 },
    };
    const cover = {
      display: { key: "cover", role: "cover" as const, posture: "closed" as const, generation: 2 },
      screenSize: { width: 100, height: 100 },
    };
    tracker.record(device.deviceId, cover);
    tracker.notifyAndroidTransition(device.deviceId, {
      change: "changed",
      displayId: 0,
      panelUniqueId: "local:inner",
      width: 200,
      height: 100,
    });
    expect(tracker.record(device.deviceId, inner)).toBe(false);
    expect(tracker.revision(device.deviceId)).toBe(1);
    tracker.notifyAndroidTransition(device.deviceId, {
      change: "device_state",
      displayId: 0,
      deviceState: 1,
    });
    expect(tracker.record(device.deviceId, inner)).toBe(false);
    expect(tracker.record(device.deviceId, inner)).toBe(false);
    expect(tracker.checkIdentity(device.deviceId, cover.display)).toBe(true);
    expect(tracker.record(device.deviceId, cover)).toBe(false);
    expect(tracker.revision(device.deviceId)).toBe(3);
    expect(invalidations).toEqual([
      "CtrlProxy changed",
      "CtrlProxy device_state",
      "display key, role, or posture changed",
    ]);
  });

  test("an added push absent from the stamp cannot suppress a later fold", () => {
    const invalidations: string[] = [];
    const tracker = new DisplayTransitionTracker((_deviceId, reason) => invalidations.push(reason));
    const inner = {
      display: { key: "inner", role: "inner" as const, posture: "opened" as const, generation: 1 },
      screenSize: { width: 200, height: 100 },
    };
    const cover = {
      display: { key: "cover", role: "cover" as const, posture: "closed" as const, generation: 2 },
      screenSize: { width: 100, height: 100 },
    };
    tracker.record(device.deviceId, inner);
    tracker.notifyAndroidTransition(device.deviceId, { change: "added", displayId: 0 });
    expect(tracker.record(device.deviceId, inner)).toBe(false);
    expect(tracker.checkIdentity(device.deviceId, cover.display)).toBe(true);
    expect(tracker.record(device.deviceId, cover)).toBe(false);
    expect(tracker.revision(device.deviceId)).toBe(2);
    expect(invalidations).toEqual(["CtrlProxy added", "display key, role, or posture changed"]);
  });

  test("a rotation-only push on the same panel is ignored", () => {
    const invalidations: string[] = [];
    const tracker = new DisplayTransitionTracker((_deviceId, reason) => invalidations.push(reason));
    tracker.record(device.deviceId, {
      display: { key: "inner", role: "inner", posture: "opened", generation: 1 },
      screenSize: { width: 100, height: 200 },
    });
    tracker.notifyAndroidTransition(device.deviceId, {
      change: "changed",
      displayId: 0,
      panelUniqueId: "local:inner",
      width: 200,
      height: 100,
    });
    expect(tracker.revision(device.deviceId)).toBe(0);
    expect(invalidations).toEqual([]);
  });

  test("rotation does not wipe observe cache or repeat the lock sample", async () => {
    const timer = new FakeTimer();
    const adb = new FakeAdbExecutor();
    adb.setCommandResponse("cmd display get-displays", {
      stdout: 'Display id 0: DisplayInfo{uniqueId "local:inner" type INTERNAL, real 200 x 100}',
      stderr: "",
    });
    const lockRead = spyOn(adb, "getDeviceLock");
    const cache = new FakeObserveCacheStore(timer);
    const hierarchy = new FakeViewHierarchy();
    hierarchy.configureHierarchySequence([
      { hierarchy: { node: {} }, screenWidth: 200, screenHeight: 100, updatedAt: 1 },
      { hierarchy: { node: {} }, screenWidth: 100, screenHeight: 200, updatedAt: 2 },
    ]);
    const screen = new RealObserveScreen(
      device,
      new FakeAdbClientFactory(adb),
      {
        viewHierarchy: hierarchy,
        cacheStore: cache,
      },
      timer,
    );
    try {
      await screen.execute(options);
      const generation = cache.currentGeneration(device.deviceId);
      const firstLockReads = lockRead.mock.calls.length;
      await screen.execute(options);
      expect(displayTransitions.revision(device.deviceId)).toBe(0);
      expect(cache.currentGeneration(device.deviceId)).toBe(generation);
      expect(lockRead.mock.calls.length - firstLockReads).toBe(1);
    } finally {
      lockRead.mockRestore();
    }
  });

  test("reset on release lets a new session establish its first panel", () => {
    const invalidations: string[] = [];
    const tracker = new DisplayTransitionTracker((_deviceId, reason) => invalidations.push(reason));
    const first = {
      display: { key: "inner", role: "inner" as const, posture: "opened" as const, generation: 1 },
      screenSize: { width: 200, height: 200 },
    };
    const next = {
      display: { key: "cover", role: "cover" as const, posture: "closed" as const, generation: 1 },
      screenSize: { width: 100, height: 100 },
    };
    tracker.record(device.deviceId, first);
    tracker.reset(device.deviceId);
    expect(tracker.checkIdentity(device.deviceId, next.display)).toBe(false);
    expect(tracker.record(device.deviceId, next)).toBe(false);
    expect(invalidations).toEqual([]);
  });

  test("a panel change clears the per-device observe cache and leaves other devices intact", async () => {
    const cache = new FakeObserveCacheStore(new FakeTimer());
    setObserveCacheStore(cache);
    const first = {
      display: { key: "inner", role: "inner", posture: "opened", generation: 1 },
      screenSize: { width: 200, height: 200 },
    } as ObserveResult;
    await cache.put(device.deviceId, first);
    await cache.put("other-device", first);
    displayTransitions.record(device.deviceId, first);
    expect(cache.getRecentInMemoryForDevice(device.deviceId)).toBe(first);
    displayTransitions.notifyTransition(device.deviceId, "display_transition frame");
    expect(cache.getRecentInMemoryForDevice(device.deviceId)).toBeUndefined();
    expect(cache.getRecentInMemoryForDevice("other-device")).toBe(first);
  });

  test("the first folded observation reports the newly locked keyguard", async () => {
    const timer = new FakeTimer();
    const adb = new FakeAdbExecutor();
    const hierarchy = new FakeViewHierarchy();
    const cache = new FakeObserveCacheStore(timer);
    adb.setCommandResponseSequence("cmd display get-displays", [
      {
        stdout: 'Display id 0: DisplayInfo{uniqueId "local:inner" type INTERNAL, real 200 x 200}',
        stderr: "",
      },
      {
        stdout: 'Display id 0: DisplayInfo{uniqueId "local:cover" type INTERNAL, real 100 x 100}',
        stderr: "",
      },
    ]);
    adb.setDeviceLockSequence([
      { locked: false, keyguardShowing: false },
      { locked: false, keyguardShowing: false },
      { locked: true, keyguardShowing: true },
    ]);
    hierarchy.configureHierarchySequence([
      {
        hierarchy: { node: {} },
        screenWidth: 200,
        screenHeight: 200,
        captureSequence: 1,
        updatedAt: 1,
      },
      {
        hierarchy: { node: {} },
        screenWidth: 100,
        screenHeight: 100,
        captureSequence: 2,
        updatedAt: 2,
      },
    ]);
    const screen = new RealObserveScreen(
      device,
      new FakeAdbClientFactory(adb),
      { viewHierarchy: hierarchy, cacheStore: cache },
      timer,
    );
    const first = await screen.execute(options);
    const folded = await screen.execute(options);
    expect(first.display.key).toBe("inner");
    expect(folded.display.key).toBe("cover");
    expect(first.displayRevision).toBe(0);
    expect(folded.displayRevision).toBe(1);
    expect(folded.deviceLock?.locked).toBe(true);
    expect(displayTransitions.revision(device.deviceId)).toBe(1);
    expect(
      adb.getExecutedCommands().filter((command) => command.includes("cmd display get-displays")),
    ).toHaveLength(2);
  });

  test("tapOn rejects a fresh hierarchy captured on a different sized panel", async () => {
    const adb = new FakeAdbExecutor();
    adb.setCommandResponse("cmd display get-displays", {
      stdout: 'Display id 0: DisplayInfo{uniqueId "local:cover" type INTERNAL, real 100 x 100}',
      stderr: "",
    });
    const capture = {
      capture: async () => ({
        hierarchy: { hierarchy: { node: {} }, screenWidth: 100, screenHeight: 100 },
      }),
    } as HierarchyCapture;
    const tap = new TapOnElement(device, adb, {
      timer: new FakeTimer(),
      hierarchyCapture: capture,
    });
    displayTransitions.record(device.deviceId, {
      display: { key: "inner", role: "inner", posture: "opened", generation: 1 },
      screenSize: { width: 200, height: 200 },
    });
    await expect(tap.refreshViewHierarchy(10, { width: 200, height: 200 })).rejects.toThrow(
      "Display changed during tap preparation",
    );
    expect(displayTransitions.revision(device.deviceId)).toBe(1);
  });

  test("observe then tapOn accepts the same focused logical-2 panel and posture", async () => {
    const focusedDevice: BootedDevice = {
      ...device,
      deviceId: "focused-logical-two-tap",
      displays: {
        panels: [
          { key: "cover", role: "cover", sizePx: { width: 100, height: 100 } },
          { key: "external", role: "external", sizePx: { width: 200, height: 200 } },
        ],
        postures: ["closed"],
      },
    };
    const timer = new FakeTimer();
    const adb = new FakeAdbExecutor();
    adb.setCommandResponse("cmd display get-displays", {
      stdout:
        'Display id 0: DisplayInfo{uniqueId "local:cover" type INTERNAL, real 100 x 100}\nDisplay id 2: DisplayInfo{uniqueId "local:external" type EXTERNAL, real 200 x 200}',
      stderr: "",
    });
    adb.setCommandResponse("shell cmd device_state state", {
      stdout: deviceStateFixture("foldpf-5-after-reset-state.txt"),
      stderr: "",
    });
    adb.setCommandResponse("shell cmd device_state print-states", {
      stdout: deviceStateFixture("foldpf-print-states.txt"),
      stderr: "",
    });
    const hierarchy = new FakeViewHierarchy();
    hierarchy.configureHierarchy({
      hierarchy: { node: {} },
      displayId: 2,
      screenWidth: 200,
      screenHeight: 200,
    });
    try {
      const screen = new RealObserveScreen(
        focusedDevice,
        new FakeAdbClientFactory(adb),
        {
          viewHierarchy: hierarchy,
          cacheStore: new FakeObserveCacheStore(timer),
        },
        timer,
      );
      const observed = await screen.execute(options);
      expect(observed.display).toMatchObject({ key: "external", posture: "closed" });
      const tap = new TapOnElement(focusedDevice, adb, {
        timer,
        hierarchyCapture: {
          capture: async () => ({
            hierarchy: {
              hierarchy: { node: {} },
              displayId: 2,
              screenWidth: 200,
              screenHeight: 200,
            },
          }),
        } as HierarchyCapture,
      });
      await expect(tap.refreshViewHierarchy(10, observed.screenSize)).resolves.toBeDefined();
      expect(displayTransitions.revision(focusedDevice.deviceId)).toBe(0);
    } finally {
      displayTransitions.reset(focusedDevice.deviceId);
      resetObserveCacheStore();
    }
  });

  test("tapOn rejects a same-sized panel with a different physical key", async () => {
    const sameSized = {
      ...device,
      deviceId: "same-size-panels",
      displays: {
        panels: [
          { key: "inner", role: "inner" as const, sizePx: { width: 200, height: 200 } },
          { key: "cover", role: "cover" as const, sizePx: { width: 200, height: 200 } },
        ],
        postures: ["opened" as const, "closed" as const],
      },
    };
    const adb = new FakeAdbExecutor();
    adb.setCommandResponse("cmd display get-displays", {
      stdout: 'Display id 0: DisplayInfo{uniqueId "local:cover" type INTERNAL, real 200 x 200}',
      stderr: "",
    });
    const capture = {
      capture: async () => ({
        hierarchy: { hierarchy: { node: {} }, screenWidth: 200, screenHeight: 200 },
      }),
    } as HierarchyCapture;
    const tap = new TapOnElement(sameSized, adb, {
      timer: new FakeTimer(),
      hierarchyCapture: capture,
    });
    displayTransitions.record(sameSized.deviceId, {
      display: { key: "inner", role: "inner", posture: "opened", generation: 1 },
      screenSize: { width: 200, height: 200 },
    });
    try {
      await expect(tap.refreshViewHierarchy(10, { width: 200, height: 200 })).rejects.toThrow(
        "Display changed during tap preparation",
      );
      expect(displayTransitions.revision(sameSized.deviceId)).toBe(1);
    } finally {
      displayTransitions.reset(sameSized.deviceId);
    }
  });
});
