import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { TapOnElement } from "../../../src/features/action/TapOnElement";
import {
  isApprovedHiddenSystemUiClick,
  withoutHiddenXrChrome,
} from "../../../src/features/action/xrHiddenChrome";
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

/** An app window beside the captured System UI: one clickable Button with a unique resource ID. */
function withAppButton(visibleToUser: boolean): ObserveResult {
  const observation = structuredClone(capture);
  const hierarchy = observation.viewHierarchy!;
  const id = visibleToUser ? "com.example.app:id/buy" : "com.example.app:id/covered_buy";
  hierarchy.windows = [
    ...(hierarchy.windows ?? []),
    {
      id: 77,
      type: 1,
      packageName: "com.example.app",
      bounds: [0, 0, 2900, 1900],
      hierarchy: {
        windowId: 77,
        actions: ["click"],
        "resource-id": id,
        "view-id": id,
        "visible-to-user": visibleToUser,
        clickable: "true",
        class: "android.widget.Button",
        className: "android.widget.Button",
        text: "Buy",
        bounds: [100, 100, 200, 150],
      },
    } as never,
  ];
  return observation;
}

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

  test("a hidden app node with a unique ID never asks CtrlProxy to skip its visibility check", async () => {
    const { tap, service, adb, hierarchy } = setup(withAppButton(false));
    const entry = new SearchableHierarchy()
      .project(hierarchy)
      .find((node) => node.nativeId === "com.example.app:id/covered_buy")!;
    expect(entry.properties["visible-to-user"]).toBe(false);
    expect(isApprovedHiddenSystemUiClick(hierarchy, entry.source)).toBe(false);
    // CtrlProxy refuses a node that is not visible to the user without allowInvisible.
    service.setActionResult({
      success: false,
      action: "click",
      totalTimeMs: 1,
      error: "Node is not visible to the user",
    });
    const result = await tap.execute({
      action: "tap",
      elementId: "com.example.app:id/covered_buy",
      searchUntil: { duration: 100 },
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain("not tappable screen coordinates");
    expect(service.getNodeActionHistory()).toHaveLength(1);
    expect(service.getNodeActionHistory()[0]).toMatchObject({
      action: "click",
      selector: { resourceId: "com.example.app:id/covered_buy" },
    });
    expect(service.getNodeActionHistory()[0]).not.toHaveProperty("allowInvisible");
    expect(service.getTapHistory()).toEqual([]);
    expect(adb.getAllCommands().some((command) => command.includes("input"))).toBe(false);
  });

  test("a visible node click does not set allowInvisible", async () => {
    const { tap, service, hierarchy } = setup(withAppButton(true));
    const entry = new SearchableHierarchy()
      .project(hierarchy)
      .find((node) => node.nativeId === "com.example.app:id/buy")!;
    expect(isApprovedHiddenSystemUiClick(hierarchy, entry.source)).toBe(false);
    const result = await tap.execute({ action: "tap", elementId: "com.example.app:id/buy" });
    expect(result.success).toBe(true);
    expect(service.getNodeActionHistory()).toHaveLength(1);
    expect(service.getNodeActionHistory()[0]).toMatchObject({
      selector: { resourceId: "com.example.app:id/buy" },
    });
    expect(service.getNodeActionHistory()[0]).not.toHaveProperty("allowInvisible");
  });

  test("the gate approves only the verified hidden System UI click target", () => {
    const { hierarchy } = setup();
    const entries = new SearchableHierarchy().project(hierarchy);
    const approved = entries
      .filter((entry) => isApprovedHiddenSystemUiClick(hierarchy, entry.source))
      .map((entry) => entry.nativeId);
    expect(approved).toContain("com.android.systemui:id/launcher_button");
    expect(approved).not.toContain("com.android.systemui:id/launcher_icon");
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
