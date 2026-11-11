import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { TapOnElement } from "../../../src/features/action/TapOnElement";
import { CachedAndroidXrDisplaySize } from "../../../src/features/observe/android/AndroidXrDisplaySize";
import { DisplayTransitionTracker } from "../../../src/features/observe/DisplayTransition";
import { StaleDisplayError } from "../../../src/features/observe/StaleDisplayError";
import { queryDisplaySize } from "../../../src/features/record/android/AxisRanges";
import type { ViewHierarchyResult } from "../../../src/models";
import { FakeAdbClient } from "../../fakes/FakeAdbClient";
import { FakeAndroidXrDetector } from "../../fakes/FakeAndroidXrDetector";
import { FakeHierarchyCapture } from "../../fakes/FakeHierarchyCapture";
import { FakeHierarchyCollector } from "../../fakes/FakeHierarchyCollector";
import { FakeObserveScreen } from "../../fakes/FakeObserveScreen";
import { FakeTimer } from "../../fakes/FakeTimer";
import { createObserveResultForTest } from "../observe/flatHierarchyBuilders";

const fixture: { viewHierarchy: ViewHierarchyResult } = JSON.parse(
  readFileSync(
    new URL(
      "../../fixtures/android-xr/observe-settings-search-ime-up-screensize-17881.json",
      import.meta.url,
    ),
    "utf8",
  ),
);

async function setup(xr: boolean, fromObserver = false) {
  const device = { platform: "android", deviceId: "fake-xr-refresh", name: "fake" } as const;
  const adb = new FakeAdbClient();
  adb.setCommandResult("shell wm size", "Physical size: 2560x2558");
  const timer = new FakeTimer();
  const xrDetector = new FakeAndroidXrDetector(xr);
  const xrDisplaySize = new CachedAndroidXrDisplaySize({
    device: () => device,
    adb: () => adb,
    xrDetector,
    readDisplaySize: () => queryDisplaySize(adb),
    hierarchyCollector: () => new FakeHierarchyCollector(),
  });
  const initial = structuredClone(fixture.viewHierarchy);
  const result = createObserveResultForTest({ screenSize: { width: 2560, height: 2558 } });
  await xrDisplaySize.prime(result, initial);
  const transitions = new DisplayTransitionTracker(() => undefined);
  transitions.record(device.deviceId, result);
  const captured = structuredClone(fixture.viewHierarchy);
  const tap = new TapOnElement(device, adb, {
    ...(fromObserver ? {} : { xrDisplaySize }),
    timer,
    xrDetector: new FakeAndroidXrDetector(xr),
    displayTransitions: transitions,
    hierarchyCapture: new FakeHierarchyCapture(() => captured, "android", timer),
  });
  if (fromObserver) {
    tap.observeScreen = Object.assign(new FakeObserveScreen(), { xrDisplaySize });
  }
  return { tap, captured, result, transitions, device, adb, timer, xrDetector };
}

test.each([false, true])(
  "XR refresh uses the primed shared size (observer=%s)",
  async (fromObserver) => {
    const h = await setup(true, fromObserver);
    const revision = h.transitions.revision(h.device.deviceId);
    const refreshed = await h.tap.refreshViewHierarchy(10, h.result.screenSize);
    expect(refreshed).toMatchObject({
      screenWidth: 2560,
      screenHeight: 2558,
      pixelWidth: 2560,
      pixelHeight: 2558,
    });
    expect(h.transitions.revision(h.device.deviceId)).toBe(revision);
    expect(h.transitions.geometryChanged(h.device.deviceId, h.result.screenSize)).toBe(false);
    expect(h.adb.getAllCommands()).toEqual(["shell wm size"]);
    expect(h.xrDetector.queries).toEqual([h.device.deviceId]);
    expect(h.timer.getSleepHistory()).toEqual([]);
  },
);

test("non-XR refresh still fences differing geometry", async () => {
  const h = await setup(false);
  await expect(h.tap.refreshViewHierarchy(10, h.result.screenSize)).rejects.toBeInstanceOf(
    StaleDisplayError,
  );
  expect(h.adb.getAllCommands().filter((command) => command === "shell wm size")).toHaveLength(0);
  expect(h.timer.getSleepHistory()).toEqual([]);
});

test("XR refresh on another display does not use the default-display cache", async () => {
  const h = await setup(true);
  h.captured.displayId = 2;
  await expect(h.tap.refreshViewHierarchy(10, h.result.screenSize)).rejects.toBeInstanceOf(
    StaleDisplayError,
  );
  expect(h.captured.screenWidth).toBe(1080);
  expect(h.adb.getAllCommands().filter((command) => command === "shell wm size")).toHaveLength(1);
});

test("XR refresh primes a new rotation and still fences the changed geometry", async () => {
  const h = await setup(true);
  h.captured.rotation = 1;
  await expect(h.tap.refreshViewHierarchy(10, h.result.screenSize)).rejects.toBeInstanceOf(
    StaleDisplayError,
  );
  expect(h.adb.getAllCommands().filter((command) => command === "shell wm size")).toHaveLength(2);
  expect(h.timer.getSleepHistory()).toEqual([]);
});

test("XR search corrects the hierarchy-derived comparison size before polling", async () => {
  const h = await setup(true);
  h.timer.enableAutoAdvance();
  h.result.viewHierarchy = structuredClone(fixture.viewHierarchy);
  h.result.screenSize = { width: 1080, height: 608 };
  const revision = h.transitions.revision(h.device.deviceId);
  const searched = await h.tap.searchForElement(
    { action: "tap", text: "absent XR search target", searchUntil: { duration: 100 } },
    h.result,
  );
  expect(searched.selection.element).toBeNull();
  expect(h.result.screenSize).toEqual({ width: 2560, height: 2558 });
  expect(h.transitions.revision(h.device.deviceId)).toBe(revision);
  expect(h.adb.getAllCommands()).toEqual(["shell wm size"]);
  expect(h.xrDetector.queries).toEqual([h.device.deviceId]);
  expect(h.timer.getSleepHistory()).toEqual([50]);
});
