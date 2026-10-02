import { describe, expect, test } from "bun:test";
import {
  projectActionableHierarchy,
  resolveActionableHierarchyScreenSize,
} from "../../src/features/observe/HierarchyNormalization";
import { ElementResolver } from "../../src/features/utility/ElementResolver";
import type { BootedDevice, ObserveResult, ViewHierarchyResult } from "../../src/models";
import { findWaitForElement, waitForObservation } from "../../src/server/observeTools";
import { FakeObserveScreen } from "../fakes/FakeObserveScreen";
import { FakeTimer } from "../fakes/FakeTimer";
import {
  duoSelectionText,
  issue8379SelectionHierarchy,
  selectionFixtureDevice,
} from "../fixtures/issue8379SelectionHierarchy";

async function waitForTarget(
  device: BootedDevice,
  hierarchy = issue8379SelectionHierarchy(),
  absent = false,
  initialHierarchyMissing = false,
) {
  const timer = new FakeTimer();
  timer.enableAutoAdvance();
  const screen = new FakeObserveScreen();
  const observation: ObserveResult = {
    observationId: "multi-panel-wait",
    display: { key: "0", role: "inner", posture: "opened", generation: 0 },
    updatedAt: 0,
    screenSize: { width: 669, height: 951 },
    systemInsets: { top: 0, right: 0, bottom: 0, left: 0 },
    viewHierarchy: hierarchy,
  };
  // Fresh fixture wrappers exercise both the first read and subsequent polls.
  screen.setObserveResult((index) => ({
    ...observation,
    viewHierarchy:
      initialHierarchyMissing && index === 0 ? undefined : { ...hierarchy, updatedAt: index + 1 },
  }));
  return waitForObservation(
    screen,
    absent
      ? { absent: { text: duoSelectionText }, timeout: 100 }
      : { text: duoSelectionText, timeout: 100 },
    undefined,
    false,
    timer,
    device.platform,
    "none",
    undefined,
    "multi",
    device.displays?.panels ?? [],
  );
}

describe("waitFor multi-panel element visibility", () => {
  test("uses multi-panel context while preserving legacy positional finder calls", () => {
    // owner decision D43 (#6523): one screen-size source. Flag-less raw wait
    // formerly rejected the right target; with device context it now accepts.
    const raw = issue8379SelectionHierarchy();
    const finder = new ElementResolver();
    const waitFor = { text: duoSelectionText };
    const screenSize = resolveActionableHierarchyScreenSize(raw, true) ?? undefined;
    expect(screenSize).toEqual({ width: 951, height: 669 });
    expect(
      findWaitForElement(finder, waitFor, raw, "ios", new Map(), {
        iosMultiPanel: true,
        observationScreenSize: screenSize,
      })?.text,
    ).toBe(duoSelectionText);
    expect(findWaitForElement(finder, waitFor, raw, "ios", new Map(), false)).toBeNull();
    expect(findWaitForElement(finder, waitFor, raw, "ios", new Map(), {})).toBeNull();
    expect(findWaitForElement(finder, waitFor, raw, "ios", new Map(), true)?.text).toBe(
      duoSelectionText,
    );
  });

  test("matches the right-hand target in an unprojected iOS Duo hierarchy", async () => {
    const raw = issue8379SelectionHierarchy();
    expect([raw.screenWidth, raw.screenHeight]).toEqual([669, 951]);
    expect(raw.pixelWidth).toBeUndefined();
    expect(raw.pixelHeight).toBeUndefined();
    const outcome = await waitForTarget(selectionFixtureDevice(), raw);
    expect(outcome.matched).toBe(true);
    expect(outcome.timedOut).toBe(false);
    expect(outcome.awaitedElement?.text).toBe(duoSelectionText);
  });

  test("resolves the screen size again for a subsequent observation", async () => {
    const outcome = await waitForTarget(selectionFixtureDevice(), undefined, false, true);
    expect(outcome.matched).toBe(true);
    expect(outcome.timedOut).toBe(false);
    expect(outcome.polls).toBe(2);
  });

  for (const [platform, panels] of [
    ["ios", 1],
    ["ios", 0],
    ["android", 2],
  ] as const) {
    test(`keeps raw off-screen filtering for ${platform} with ${panels} panels`, async () => {
      const outcome = await waitForTarget(selectionFixtureDevice(platform, panels));
      expect(outcome.matched).toBe(false);
      expect(outcome.timedOut).toBe(true);
    });
  }

  test("still matches a projected multi-panel iOS hierarchy", async () => {
    const projected: ViewHierarchyResult = projectActionableHierarchy(
      "ios",
      issue8379SelectionHierarchy(),
      true,
    );
    const outcome = await waitForTarget(selectionFixtureDevice(), projected);
    expect(outcome.matched).toBe(true);
    expect(outcome.timedOut).toBe(false);
  });

  for (const panels of [2, 1]) {
    test(`does not satisfy absent for the present target with ${panels} iOS panels`, async () => {
      const outcome = await waitForTarget(selectionFixtureDevice("ios", panels), undefined, true);
      expect(outcome.matched).toBe(false);
      expect(outcome.timedOut).toBe(true);
    });
  }
});
