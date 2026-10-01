import { afterEach, expect, spyOn, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { BaseVisualChange } from "../../../src/features/action/BaseVisualChange";
import { SetPosture } from "../../../src/features/device/SetPosture";
import {
  DisplayTransitionTracker,
  displayTransitions,
} from "../../../src/features/observe/DisplayTransition";
import { ObservedAndroidDisplayCache } from "../../../src/features/observe/ObservationDisplay";
import { RealObserveScreen } from "../../../src/features/observe/ObserveScreen";
import { AndroidCtrlProxyClient } from "../../../src/features/observe/android";
import { IOSCtrlProxyClient } from "../../../src/features/observe/ios";
import { resetObserveCacheStore } from "../../../src/features/observe/cache/ObserveCacheRegistry";
import type { BootedDevice, DisplayRef, ViewHierarchyResult } from "../../../src/models";
import { FakeAdbClientFactory } from "../../fakes/FakeAdbClientFactory";
import { FakeAdbExecutor } from "../../fakes/FakeAdbExecutor";
import { FakeCtrlProxy } from "../../fakes/FakeCtrlProxy";
import { FakeIOSCtrlProxy } from "../../fakes/FakeIOSCtrlProxy";
import { FakeHierarchyCapture } from "../../fakes/FakeHierarchyCapture";
import { FakeIdGenerator } from "../../fakes/FakeIdGenerator";
import { FakeObserveCacheStore } from "../../fakes/FakeObserveCacheStore";
import { FakeTimer } from "../../fakes/FakeTimer";
import { FakeViewHierarchy } from "../../fakes/FakeViewHierarchy";

const fixture = (name: string): string =>
  readFileSync(join(import.meta.dir, "../../fixtures/android-display", name), "utf8");
const states = fixture("foldpf-print-states.txt");
const opened = fixture("foldpf-1-default-state.txt");
const closed = fixture("foldpf-5-after-reset-state.txt");
const options = {
  skipScreenshot: true,
  skipBackStack: true,
  skipRecompositionTracking: true,
  skipPerformanceAudit: true,
  skipAccessibilityAudit: true,
};
const devices = new Set<string>();
const restores: Array<() => void> = [];

afterEach(() => {
  for (const restore of restores.splice(0)) {
    restore();
  }
  for (const deviceId of devices) {
    AndroidCtrlProxyClient.removeInstance(deviceId);
    displayTransitions.reset(deviceId);
  }
  devices.clear();
  resetObserveCacheStore();
});

// Reuses the RealObserveScreen/FakeViewHierarchy seam from DisplayTransition.test.ts.
function harness(platform: "android" | "ios" = "android", singlePanel = false) {
  const device: BootedDevice = {
    deviceId: `display-generation-${platform}`,
    name: "Foldable",
    platform,
    displays: {
      panels: [
        { key: "inner", role: "inner", sizePx: { width: 200, height: 300 } },
        ...(singlePanel
          ? []
          : [{ key: "cover", role: "cover" as const, sizePx: { width: 100, height: 150 } }]),
      ],
      postures: ["opened", "closed"],
    },
  };
  devices.add(device.deviceId);
  displayTransitions.reset(device.deviceId);
  const timer = new FakeTimer();
  timer.enableAutoAdvance();
  const adb = new FakeAdbExecutor();
  const adbFactory = new FakeAdbClientFactory(adb);
  const hierarchy = new FakeViewHierarchy();
  const ids = new FakeIdGenerator();
  const client = new FakeIOSCtrlProxy(timer);
  if (platform === "ios") {
    const instance = spyOn(IOSCtrlProxyClient, "getInstance").mockReturnValue(
      client as unknown as IOSCtrlProxyClient,
    );
    restores.push(() => instance.mockRestore());
  }
  let timestamp = 0;
  const panel = (key: "inner" | "cover", extra: Partial<ViewHierarchyResult> = {}) => {
    const width = key === "inner" ? 200 : 100;
    const height = key === "inner" ? 300 : 150;
    adb.setCommandResponse("cmd display get-displays", {
      stdout: `Display id 0: DisplayInfo{uniqueId "local:${key}" type INTERNAL, real ${width} x ${height}}`,
      stderr: "",
    });
    adb.setCommandResponse("shell cmd device_state print-states", { stdout: states, stderr: "" });
    adb.setCommandResponse("shell cmd device_state state", {
      stdout: key === "inner" ? opened : closed,
      stderr: "",
    });
    ObservedAndroidDisplayCache.clear(device.deviceId);
    hierarchy.configureHierarchy({
      hierarchy: { node: {} },
      screenWidth: width,
      screenHeight: height,
      pixelWidth: width,
      pixelHeight: height,
      displayId: 0,
      panelUniqueId: `local:${key}`,
      updatedAt: ++timestamp,
      ...extra,
    });
  };
  panel("inner");
  const screen = new RealObserveScreen(
    device,
    adbFactory,
    {
      viewHierarchy: hierarchy,
      hierarchyCapture: new FakeHierarchyCapture(() => hierarchy.getViewHierarchy(), platform),
      cacheStore: new FakeObserveCacheStore(timer),
      // Explicit fake: no notifyutil/simulator operation, including the setPosture UDID test.
      iosLockStateProbe: { read: async () => undefined },
    },
    timer,
    ids,
  );
  return { device, timer, adb, adbFactory, hierarchy, ids, client, panel, screen };
}

test("fold increments surfaced generation once, unchanged observe keeps it, unfold increments again", async () => {
  const h = harness();
  const first = await h.screen.execute(options);
  expect(first.display).toEqual({ key: "inner", role: "inner", posture: "opened", generation: 0 });
  h.panel("cover");
  const folded = await h.screen.execute(options);
  expect(folded.display).toEqual({ key: "cover", role: "cover", posture: "closed", generation: 1 });
  expect((await h.screen.execute(options)).display.generation).toBe(1);
  h.panel("inner");
  expect((await h.screen.execute(options)).display.generation).toBe(2);
});

test("same-observation iOS geometry correction advances revision but preserves surfaced generation", async () => {
  const h = harness("ios");
  const display: DisplayRef = { key: "inner", role: "inner", posture: "opened", generation: 0 };
  displayTransitions.record(
    h.device.deviceId,
    {
      observationId: "same-observation",
      display,
      screenSize: { width: 201, height: 301 },
    },
    "ios",
  );
  h.ids.setScripted(["same-observation"]);
  const result = await h.screen.execute(options);
  expect(result.observationId).toBe("same-observation");
  expect(result.screenSize).toMatchObject({ width: 200, height: 300 });
  expect(result.display.generation).toBe(0);
  expect(result.displayRevision).toBe(1);
});

test("ordinary Android and single-panel iOS rotation preserve surfaced generation", async () => {
  for (const platform of ["android", "ios"] as const) {
    const h = harness(platform, true);
    const first = await h.screen.execute(options);
    h.panel("inner", { screenWidth: 300, screenHeight: 200 });
    const rotated = await h.screen.execute(options);
    expect(rotated.screenSize).toMatchObject({ width: 300, height: 200 });
    expect(rotated.display.generation).toBe(first.display.generation);
    expect(rotated.displayRevision).toBe(first.displayRevision);
  }
});

test("capture sequences 7, absent, 3 and CtrlProxy client replacement never rewind generation", async () => {
  const h = harness();
  await h.screen.execute(options);
  h.panel("cover");
  const folded = await h.screen.execute(options);
  expect(folded.display.generation).toBe(1);
  AndroidCtrlProxyClient.registerForTesting(
    new FakeCtrlProxy() as unknown as AndroidCtrlProxyClient,
    h.device.deviceId,
  );
  for (const sequence of [7, undefined, 3]) {
    if (sequence === undefined) {
      AndroidCtrlProxyClient.removeInstance(h.device.deviceId);
      AndroidCtrlProxyClient.registerForTesting(
        new FakeCtrlProxy() as unknown as AndroidCtrlProxyClient,
        h.device.deviceId,
      );
    }
    h.panel("cover", { captureSequence: sequence });
    const result = await h.screen.execute(options);
    expect(result.viewHierarchy?.captureSequence).toBe(sequence);
    expect(result.display.generation).toBe(1);
    expect(displayTransitions.identityRevision(h.device.deviceId)).toBe(1);
  }
});

test("iOS capture sequences and runner client replacement preserve the current generation", async () => {
  const h = harness("ios");
  await h.screen.execute(options);
  h.panel("cover");
  expect((await h.screen.execute(options)).display.generation).toBe(1);
  for (const sequence of [7, undefined, 3]) {
    if (sequence === undefined) {
      spyOn(IOSCtrlProxyClient, "getInstance").mockReturnValue(
        new FakeIOSCtrlProxy(h.timer) as unknown as IOSCtrlProxyClient,
      );
    }
    h.panel("cover", { captureSequence: sequence });
    const result = await h.screen.execute(options);
    expect(result.viewHierarchy?.captureSequence).toBe(sequence);
    expect(result.display.generation).toBe(1);
  }
});

test("Android pushed display_transition and matching observe advance surfaced generation only once", async () => {
  const h = harness();
  expect((await h.screen.execute(options)).display.generation).toBe(0);
  displayTransitions.notifyAndroidTransition(h.device.deviceId, {
    change: "changed",
    displayId: 0,
    panelUniqueId: "local:cover",
    width: 100,
    height: 150,
  });
  expect(displayTransitions.identityRevision(h.device.deviceId)).toBe(1);
  h.panel("cover");
  expect((await h.screen.execute(options)).display.generation).toBe(1);
  expect((await h.screen.execute(options)).display.generation).toBe(1);
});

test("action prepared at surfaced generation N is rejected after transition to N+1", async () => {
  const h = harness();
  await h.screen.execute(options);
  h.panel("cover");
  const prepared = await h.screen.execute(options);
  const generation = prepared.display.generation;
  expect(generation).toBe(1);
  expect(generation).toBe(displayTransitions.identityRevision(h.device.deviceId));
  const action = new BaseVisualChange(h.device, h.adb, h.timer, () => generation);
  h.panel("inner");
  expect((await h.screen.execute(options)).display.generation).toBe(generation + 1);
  let dispatched = false;
  await expect(
    action.observedInteraction(
      async () => {
        dispatched = true;
      },
      {
        changeExpected: false,
        predictionContext: { toolName: "dragAndDrop", toolArgs: {} },
      },
    ),
  ).rejects.toThrow("Re-observe");
  expect(dispatched).toBe(false);
  expect(prepared.display.generation).toBe(generation);
});

test("Android setPosture returns the tracker generation after its fresh observation", async () => {
  const h = harness();
  await h.screen.execute(options);
  h.panel("cover");
  const feature = new SetPosture(h.device, {
    adbFactory: h.adbFactory,
    timer: h.timer,
    transitionSink: displayTransitions,
    observeFactory: () => h.screen,
  });
  // The real observation assembly still uses fake data; suppress unrelated screenshot work.
  const execute = spyOn(h.screen, "execute");
  const realExecute = RealObserveScreen.prototype.execute;
  execute.mockImplementation(() => realExecute.call(h.screen, options));
  restores.push(() => execute.mockRestore());
  const result = await feature.execute("closed");
  expect(result).toMatchObject({ posture: "closed", display: { key: "cover", generation: 1 } });
  expect("display" in result && result.display.generation).toBe(
    displayTransitions.identityRevision(h.device.deviceId),
  );
});

test("iOS setPosture returns generation after hinge, observed identity, and settled fences", async () => {
  const h = harness("ios");
  h.device.deviceId = "34C35F33-224C-4E74-B8C0-668FF03E49F5";
  h.device.deviceType = "com.apple.CoreSimulator.SimDeviceType.iPhone-Duo";
  devices.add(h.device.deviceId);
  displayTransitions.reset(h.device.deviceId);
  await h.screen.execute(options);
  h.panel("cover");
  let observationGeneration: number | undefined;
  const realExecute = RealObserveScreen.prototype.execute;
  const execute = spyOn(h.screen, "execute").mockImplementation(async () => {
    const observation = await realExecute.call(h.screen, options);
    observationGeneration = observation.display.generation;
    return observation;
  });
  restores.push(() => execute.mockRestore());
  const feature = new SetPosture(h.device, {
    iosClientProvider: () => h.client,
    timer: h.timer,
    transitionSink: displayTransitions,
    observeFactory: () => h.screen,
  });
  const result = await feature.execute("closed");
  expect(observationGeneration).toBe(2);
  expect(result).toMatchObject({ posture: "closed", display: { key: "cover", generation: 3 } });
  expect(displayTransitions.identityRevision(h.device.deviceId)).toBe(3);
});

test("observer and explicitly routed reads expose current generation without advancing it", async () => {
  const h = harness();
  await h.screen.execute(options);
  h.panel("cover");
  expect((await h.screen.execute(options)).display.generation).toBe(1);
  h.panel("inner");
  expect((await h.screen.execute({ ...options, observerMode: true })).display.generation).toBe(1);
  expect((await h.screen.execute({ ...options, display: "inner" })).display.generation).toBe(1);
  expect(displayTransitions.identityRevision(h.device.deviceId)).toBe(1);
});

test("critical-error fallback keeps the no-display placeholder generation at zero", async () => {
  const h = harness();
  displayTransitions.notifyTransition(h.device.deviceId, "transition before failure");
  const aborted = new AbortController();
  aborted.abort(new Error("fake device unavailable"));
  const result = await h.screen.execute({ ...options, signal: aborted.signal });
  expect(result.display).toEqual({ key: "0", role: "unknown", posture: "unknown", generation: 0 });
  expect(result.errors?.some((error) => error.phase === "critical")).toBe(true);
});

test("Android notify paths keep full revision equal to identity revision", () => {
  const id = "android-invariant";
  const initial = {
    display: { key: "inner", role: "inner", posture: "opened", generation: 0 } as DisplayRef,
    screenSize: { width: 200, height: 300 },
  };
  for (const useCheckIdentity of [true, false]) {
    for (const change of [
      { key: "cover" },
      { role: "cover" as const },
      { posture: "closed" as const },
    ]) {
      const tracker = new DisplayTransitionTracker(() => {});
      tracker.record(id, initial, "android");
      expect(tracker.revision(id)).toBe(tracker.identityRevision(id));
      const changed = { ...initial, display: { ...initial.display, ...change } };
      if (useCheckIdentity) {
        expect(tracker.checkIdentity(id, changed.display, "android")).toBe(true);
        expect(tracker.revision(id)).toBe(1);
        expect(tracker.revision(id)).toBe(tracker.identityRevision(id));
      }
      tracker.record(id, changed, "android");
      expect(tracker.revision(id)).toBe(1);
      expect(tracker.revision(id)).toBe(tracker.identityRevision(id));
    }
  }
  for (const change of ["changed", "device_state", "added", "removed"] as const) {
    const tracker = new DisplayTransitionTracker(() => {});
    tracker.record(id, initial, "android");
    tracker.notifyAndroidTransition(id, {
      change,
      displayId: 0,
      panelUniqueId: "local:inner",
      width: 220,
      height: 300,
      deviceState: 1,
    });
    expect(tracker.revision(id)).toBe(1);
    expect(tracker.revision(id)).toBe(tracker.identityRevision(id));
    // The observation consumes the push fence, so the next event can bump again.
    tracker.record(id, initial, "android");
    expect(tracker.revision(id)).toBe(tracker.identityRevision(id));
    tracker.notifyTransition(id, "plain transition");
    expect(tracker.revision(id)).toBe(2);
    expect(tracker.revision(id)).toBe(tracker.identityRevision(id));
  }
});

test("Android record bumps generation once for resize, but not a pure width/height swap", () => {
  const tracker = new DisplayTransitionTracker(() => {});
  const id = "android-resize";
  const display: DisplayRef = { key: "inner", role: "inner", posture: "opened", generation: 0 };
  tracker.record(id, { display, screenSize: { width: 200, height: 300 } }, "android");
  expect(tracker.identityRevision(id)).toBe(0);
  expect(tracker.record(id, { display, screenSize: { width: 220, height: 300 } }, "android")).toBe(
    true,
  );
  expect(tracker.identityRevision(id)).toBe(1);
  expect(tracker.revision(id)).toBe(tracker.identityRevision(id));
  expect(tracker.record(id, { display, screenSize: { width: 300, height: 220 } }, "android")).toBe(
    false,
  );
  expect(tracker.identityRevision(id)).toBe(1);
  expect(tracker.revision(id)).toBe(tracker.identityRevision(id));
});

test("iOS-only same-observation geometry check is the full-revision-only exception", () => {
  const tracker = new DisplayTransitionTracker(() => {});
  const id = "ios-geometry-exception";
  const display: DisplayRef = { key: "inner", role: "inner", posture: "opened", generation: 0 };
  tracker.record(
    id,
    { display, screenSize: { width: 200, height: 300 }, observationId: "same" },
    "ios",
  );
  expect(tracker.checkIosGeometry(id, { width: 220, height: 300 }, "same", display)).toBe(true);
  expect(tracker.revision(id)).toBe(1);
  expect(tracker.identityRevision(id)).toBe(0);
  tracker.record(
    id,
    { display, screenSize: { width: 220, height: 300 }, observationId: "same" },
    "ios",
  );
  expect(tracker.revision(id)).toBe(1);
  expect(tracker.identityRevision(id)).toBe(0);
});

test("Android observe surfaces resize generation and keeps both revisions aligned through rotation", async () => {
  const h = harness();
  const first = await h.screen.execute(options);
  h.panel("inner", { screenWidth: 220, screenHeight: 300, pixelWidth: 220, pixelHeight: 300 });
  const resized = await h.screen.execute(options);
  expect(resized.screenSize).toMatchObject({ width: 220, height: 300 });
  expect(resized.display.generation).toBe(first.display.generation + 1);
  expect(resized.display.generation).toBe(displayTransitions.revision(h.device.deviceId));
  h.panel("inner", { screenWidth: 300, screenHeight: 220, pixelWidth: 300, pixelHeight: 220 });
  const rotated = await h.screen.execute(options);
  expect(rotated.screenSize).toMatchObject({ width: 300, height: 220 });
  expect(rotated.display.generation).toBe(resized.display.generation);
  expect(rotated.display.generation).toBe(displayTransitions.revision(h.device.deviceId));
});
