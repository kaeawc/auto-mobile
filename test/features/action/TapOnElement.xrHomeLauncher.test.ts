import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { TapOnElement } from "../../../src/features/action/TapOnElement";
import { withoutHiddenXrChrome } from "../../../src/features/action/xrHiddenChrome";
import { recordObservationRead } from "../../../src/features/observe/observationReadScope";
import { SearchableHierarchy } from "../../../src/features/utility/SearchableNode";
import type { ObserveResult } from "../../../src/models";
import { DEFAULT_VISION_CONFIG } from "../../../src/vision";
import { FakeAdbClient } from "../../fakes/FakeAdbClient";
import { FakeAndroidXrDetector } from "../../fakes/FakeAndroidXrDetector";
import { FakeCtrlProxy } from "../../fakes/FakeCtrlProxy";
import { FakeTimer } from "../../fakes/FakeTimer";
import { runBlockWithEnvelope } from "../../helpers/observedInteractionStub";

const capture: ObserveResult = JSON.parse(
  readFileSync(
    new URL(
      "../../fixtures/android-xr/observe-home-launcher-hidden-systemui.json",
      import.meta.url,
    ),
    "utf8",
  ),
);

function setup(observation = structuredClone(capture)) {
  const hierarchy = observation.viewHierarchy!;
  // The parser's window contract wraps the captured root in a hierarchy container.
  hierarchy.windows = hierarchy.windows?.map((window) => ({
    ...window,
    hierarchy: { node: window.hierarchy ? [window.hierarchy] : [] },
  }));
  const timer = new FakeTimer();
  timer.enableAutoAdvance();
  const adb = new FakeAdbClient();
  const service = new FakeCtrlProxy(timer);
  service.setSupportsNodeActionSelectors(true);
  service.setActionResult({ success: true, action: "click", totalTimeMs: 1 });
  const tap = new TapOnElement(
    { name: "XR", platform: "android", deviceId: "fake-xr", formFactor: "xr-headset" },
    adb,
    {
      timer,
      xrDetector: new FakeAndroidXrDetector(true),
      visionConfig: { ...DEFAULT_VISION_CONFIG, enabled: false },
    },
  );
  Object.assign(tap, { accessibilityService: service });
  tap.observedInteraction = runBlockWithEnvelope(() => recordObservationRead(observation), {
    observation,
  });
  tap.refreshViewHierarchy = async () => hierarchy;
  return { tap, service, adb, timer, hierarchy };
}

describe("XR home-space hidden launcher controls", () => {
  for (const selector of [
    { text: "Open Launcher Panel" },
    { elementId: "com.android.systemui:id/launcher_button" },
  ]) {
    test(`clicks ${JSON.stringify(selector)} only through the captured node`, async () => {
      const { tap, service, adb, timer, hierarchy } = setup();
      const id = selector.elementId ?? "com.android.systemui:id/home_screen_launcher_button";
      const entry = new SearchableHierarchy()
        .project(hierarchy)
        .find((node) => node.nativeId === id)!;
      expect(entry.properties["visible-to-user"]).toBe(false);
      expect(entry.properties.actions).toContain("click");
      const before = JSON.stringify(hierarchy);
      const result = await tap.execute({ action: "tap", ...selector });
      expect(result.error).toBeUndefined();
      expect(result.success).toBe(true);
      expect(service.getNodeActionHistory()).toMatchObject([
        {
          action: "click",
          selector: { resourceId: id },
          expectedBounds: entry.bounds,
          allowInvisible: true,
        },
      ]);
      expect(service.getNodeActionHistory()).toHaveLength(1);
      expect(service.getTapHistory()).toEqual([]);
      expect(adb.getAllCommands().some((command) => command.includes("input"))).toBe(false);
      // Post-click observation polling advances only the injected FakeTimer.
      expect(timer.getSleepHistory().every((ms) => ms <= 150)).toBe(true);
      expect(JSON.stringify(hierarchy)).toBe(before);
    });
  }

  for (const selector of [
    { elementId: "com.android.systemui:id/launcher_icon" },
    { elementId: "com.android.systemui:id/launcher_button_hover" },
    { text: "Launcher" },
    { text: "Launcher", exactText: true },
  ]) {
    test(`keeps the hidden-chrome refusal for ${JSON.stringify(selector)}`, async () => {
      const { tap, service, adb } = setup();
      const result = await tap.execute({
        action: "tap",
        ...selector,
        searchUntil: { duration: 100 },
      });
      expect(result.success).toBe(false);
      expect(result.error).toContain("hidden XR system chrome (visible-to-user false, systemui)");
      expect(service.getNodeActionHistory()).toEqual([]);
      expect(service.getTapHistory()).toEqual([]);
      expect(adb.getAllCommands().some((command) => command.includes("input"))).toBe(false);
    });
  }

  test("refuses a hidden clickable resource ID shared by two captured nodes", async () => {
    const observation = structuredClone(capture);
    const hierarchy = observation.viewHierarchy!;
    const root = hierarchy.windows!.find((window) => window.id === 21)!.hierarchy!;
    const entry = new SearchableHierarchy()
      .project(hierarchy)
      .find((node) => node.nativeId === "com.android.systemui:id/launcher_button")!;
    // Duplicate only in this test's copy, including the exact captured bounds.
    if (!Array.isArray(root.node)) {
      throw new Error("Expected captured gnav children");
    }
    root.node.push(structuredClone(entry.source));
    const { tap, service, adb } = setup(observation);
    const result = await tap.execute({
      action: "tap",
      elementId: entry.nativeId,
      searchUntil: { duration: 100 },
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain("hidden XR system chrome");
    expect(service.getNodeActionHistory()).toEqual([]);
    expect(service.getTapHistory()).toEqual([]);
    expect(adb.getAllCommands().some((command) => command.includes("input"))).toBe(false);
  });

  test("tapAny's projection still excludes hidden clickable controls", () => {
    const { hierarchy } = setup();
    const projected = withoutHiddenXrChrome(hierarchy);
    expect(
      new SearchableHierarchy().project(projected.hierarchy).filter((entry) => entry.bounds),
    ).toEqual([]);
    expect(projected.hiddenNodes.size).toBeGreaterThan(0);
  });
});
