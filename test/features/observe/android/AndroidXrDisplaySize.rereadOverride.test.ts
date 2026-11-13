import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { CachedAndroidXrDisplaySize } from "../../../../src/features/observe/android/AndroidXrDisplaySize";
import type { ViewHierarchyResult } from "../../../../src/models";
import { FakeAndroidXrDetector } from "../../../fakes/FakeAndroidXrDetector";
import { FakeHierarchyCollector } from "../../../fakes/FakeHierarchyCollector";

const fixture: { viewHierarchy: ViewHierarchyResult } = JSON.parse(
  readFileSync(
    new URL(
      "../../../fixtures/android-xr/observe-settings-home-hidden-systemui.json",
      import.meta.url,
    ),
    "utf8",
  ),
);

function setup() {
  let size = { width: 2560, height: 2558 };
  const detector = new FakeAndroidXrDetector(true);
  let reads = 0;
  const cache = new CachedAndroidXrDisplaySize({
    device: () => ({ name: "fake", deviceId: "xr-override", platform: "android" }),
    xrDetector: detector,
    hierarchyCollector: () => new FakeHierarchyCollector(),
    readDisplaySize: async () => {
      reads++;
      return { ...size };
    },
  });
  async function observe(rotation: number, reread: boolean) {
    const hierarchy = structuredClone(fixture.viewHierarchy);
    hierarchy.rotation = rotation;
    const result = { backStack: undefined, screenSize: { width: 0, height: 0 } };
    await (reread ? cache.refresh(result, hierarchy) : cache.prime(result, hierarchy));
    cache.applyCached(result, hierarchy);
    return result.screenSize;
  }
  return {
    observe,
    detector,
    reads: () => reads,
    setSize: (next: { width: number; height: number }) => (size = next),
  };
}

test("an observe re-reads wm size so a mid-instance override is reported", async () => {
  const { observe, detector, reads, setSize } = setup();
  expect(await observe(0, true)).toEqual({ width: 2560, height: 2558 });
  setSize({ width: 2000, height: 1900 });
  expect(await observe(0, true)).toEqual({ width: 2000, height: 1900 });
  expect(reads()).toBe(2);
  // The XR verdict stays cached; only the size is re-read.
  expect(detector.queries).toEqual(["xr-override"]);
});

test("a recapture reuses the size the last observe read", async () => {
  const { observe, reads, setSize } = setup();
  await observe(0, true);
  setSize({ width: 2000, height: 1900 });
  expect(await observe(0, false)).toEqual({ width: 2560, height: 2558 });
  expect(reads()).toBe(1);
});

test("a fresh read drops the other rotation parity so it is re-read too", async () => {
  const { observe, reads, setSize } = setup();
  await observe(1, true);
  await observe(0, true);
  setSize({ width: 2000, height: 1900 });
  await observe(0, true);
  expect(await observe(1, false)).toEqual({ width: 1900, height: 2000 });
  expect(reads()).toBe(4);
});
