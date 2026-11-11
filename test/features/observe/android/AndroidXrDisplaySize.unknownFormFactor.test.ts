import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { CachedAndroidXrDisplaySize } from "../../../../src/features/observe/android/AndroidXrDisplaySize";
import { queryDisplaySize } from "../../../../src/features/record/android/AxisRanges";
import type { BootedDevice, ViewHierarchyResult } from "../../../../src/models";
import {
  CachedAndroidXrDetector,
  XR_SPATIAL_FEATURE,
} from "../../../../src/utils/android-cmdline-tools/androidXrDevice";
import { FakeAdbClient } from "../../../fakes/FakeAdbClient";
import { FakeHierarchyCollector } from "../../../fakes/FakeHierarchyCollector";
import { FakeTimer } from "../../../fakes/FakeTimer";
import { createObserveResultForTest } from "../flatHierarchyBuilders";

// Captured on the XR headset with the IME up (#17881): the hierarchy reports 1080x608.
const fixture: { viewHierarchy: ViewHierarchyResult } = JSON.parse(
  readFileSync(
    new URL(
      "../../../fixtures/android-xr/observe-settings-search-ime-up-screensize-17881.json",
      import.meta.url,
    ),
    "utf8",
  ),
);

const PROBE = `shell pm has-feature ${XR_SPATIAL_FEATURE}`;

function setup(formFactor: BootedDevice["formFactor"], declaresXr: boolean) {
  const device: BootedDevice = {
    platform: "android",
    deviceId: `fake-${formFactor ?? "unset"}-${declaresXr}`,
    name: "fake",
    ...(formFactor ? { formFactor } : {}),
  };
  const adb = new FakeAdbClient();
  adb.setCommandResult(PROBE, String(declaresXr));
  adb.setCommandResult("shell wm size", "Physical size: 2560x2558");
  const xrDisplaySize = new CachedAndroidXrDisplaySize({
    device: () => device,
    adb: () => adb,
    xrDetector: new CachedAndroidXrDetector(new FakeTimer()),
    readDisplaySize: () => queryDisplaySize(adb),
    hierarchyCollector: () => new FakeHierarchyCollector(),
  });
  async function observe() {
    const hierarchy = structuredClone(fixture.viewHierarchy);
    const result = createObserveResultForTest({ screenSize: { width: 1080, height: 608 } });
    await xrDisplaySize.prime(result, hierarchy);
    xrDisplaySize.applyCached(result, hierarchy);
    return result.screenSize;
  }
  const count = (command: string) =>
    adb.getAllCommands().filter((issued) => issued === command).length;
  return { observe, count };
}

test.each([undefined, "unknown"] as const)(
  "an unclassified (%s) device declaring the XR feature uses the wm size",
  async (formFactor) => {
    const h = setup(formFactor, true);
    expect(await h.observe()).toEqual({ width: 2560, height: 2558 });
    expect(await h.observe()).toEqual({ width: 2560, height: 2558 });
    expect(h.count(PROBE)).toBe(1);
    expect(h.count("shell wm size")).toBe(1);
  },
);

test("an unclassified device without the XR feature keeps its size and probes once", async () => {
  const h = setup(undefined, false);
  expect(await h.observe()).toEqual({ width: 1080, height: 608 });
  expect(await h.observe()).toEqual({ width: 1080, height: 608 });
  expect(h.count(PROBE)).toBe(1);
  expect(h.count("shell wm size")).toBe(0);
});

test.each(["phone", "tablet", "foldable", "tv"] as const)(
  "a known %s is never probed and keeps its size",
  async (formFactor) => {
    const h = setup(formFactor, true);
    expect(await h.observe()).toEqual({ width: 1080, height: 608 });
    expect(h.count(PROBE)).toBe(0);
    expect(h.count("shell wm size")).toBe(0);
  },
);
