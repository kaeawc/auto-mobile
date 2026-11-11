import { runBlockWithEnvelope } from "../../helpers/observedInteractionStub";
import { recordObservationRead } from "../../../src/features/observe/observationReadScope";
import { DEFAULT_VISION_CONFIG } from "../../../src/vision";
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { TapOnElement } from "../../../src/features/action/TapOnElement";
import { TapTargetUnavailableError } from "../../../src/features/action/tapTargetSupport";
import { SearchableHierarchy } from "../../../src/features/utility/SearchableNode";
import type { ViewHierarchyResult } from "../../../src/models";
import { FakeAdbClient } from "../../fakes/FakeAdbClient";
import { FakeAndroidXrDetector } from "../../fakes/FakeAndroidXrDetector";
import { FakeCtrlProxy } from "../../fakes/FakeCtrlProxy";
import { FakeTimer } from "../../fakes/FakeTimer";
import { buildObserveResult } from "../../helpers/observeFixture";

const capture: Pick<ViewHierarchyResult, "windows"> & {
  content: { type: string; text: string }[];
} = JSON.parse(
  readFileSync(new URL("../../fixtures/xr/systemui-hidden-chrome.json", import.meta.url), "utf8"),
);
function tree(): ViewHierarchyResult {
  return { hierarchy: {}, windows: structuredClone(capture.windows) };
}
function target(hierarchy: ViewHierarchyResult, text: string) {
  return new SearchableHierarchy().project(hierarchy).find((entry) => entry.label === text)!;
}
function setup(xr = true, platform: "android" | "ios" = "android") {
  const timer = new FakeTimer();
  timer.enableAutoAdvance();
  const adb = new FakeAdbClient();
  const detector = new FakeAndroidXrDetector(xr);
  const service = new FakeCtrlProxy(timer);
  const tap = new TapOnElement(
    { name: "fake", platform, deviceId: "fake", formFactor: "phone" },
    adb,
    { timer, xrDetector: detector, visionConfig: { ...DEFAULT_VISION_CONFIG, enabled: false } },
  );
  Object.assign(tap, { accessibilityService: service });
  const search = (hierarchy: ViewHierarchyResult, text = "Environment", refresh = hierarchy) =>
    tap.searchForElement(
      {
        action: "tap",
        text,
        searchUntil: { duration: 100 },
        verification: { refresh: async () => refresh },
      },
      buildObserveResult({
        updatedAt: 0,
        systemInsets: { top: 0, bottom: 0, left: 0, right: 0 },
        viewHierarchy: hierarchy,
        screenSize: { width: 2560, height: 2558 },
      }),
    );
  return { search, timer, detector, service, adb, tap };
}

describe("XR hidden system chrome target resolution", () => {
  for (const text of ["Environment", "Recents"]) {
    test(`refuses captured hidden ${text} with actionable guidance before dispatch`, async () => {
      const hierarchy = tree();
      expect(target(hierarchy, text).properties["visible-to-user"]).toBe(false);
      const { search, detector, service, adb, timer } = setup();
      const result = await search(hierarchy, text);
      expect(result.selection.element).toBeNull();
      expect(result.visibilityError).toBeInstanceOf(TapTargetUnavailableError);
      expect(result.visibilityError?.message).toContain(text);
      expect(result.visibilityError?.message).toMatch(
        /hidden XR system chrome.*visible-to-user false.*systemui/,
      );
      expect(result.visibilityError?.message).toMatch(
        /observe.*visible control.*tapAt.*screen coordinates.*screenshot/,
      );
      expect(detector.queries).toEqual(["fake"]);
      expect(service.getNodeActionHistory()).toEqual([]);
      expect(service.getTapHistory()).toEqual([]);
      expect(adb.getAllCommands()).toEqual([]);
      expect(timer.getSleepHistory().every((ms) => ms <= 50)).toBe(true);
      expect(
        capture.content.some((result) => result.text.includes("XR panel coordinate space")),
      ).toBe(true);
    });
  }

  test("execute returns the hidden-chrome refusal without dispatching a click", async () => {
    const hierarchy = tree();
    const { tap, service, adb } = setup();
    const observation = buildObserveResult({
      updatedAt: 0,
      systemInsets: { top: 0, bottom: 0, left: 0, right: 0 },
      viewHierarchy: hierarchy,
      screenSize: { width: 2560, height: 2558 },
    });
    tap.observedInteraction = runBlockWithEnvelope(() => recordObservationRead(observation), {
      observation,
    });
    tap.refreshViewHierarchy = async () => hierarchy;
    const result = await tap.execute({
      action: "tap",
      text: "Environment",
      searchUntil: { duration: 100 },
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain("hidden XR system chrome");
    expect(result.error).toContain("Environment");
    expect(service.getNodeActionHistory()).toEqual([]);
    expect(service.getTapHistory()).toEqual([]);
    expect(adb.getAllCommands()).toEqual([
      "shell settings get secure enabled_accessibility_services",
    ]);
  });

  test("strict unique selection still reports a hidden-only target with guidance", async () => {
    const hierarchy = tree();
    const { tap } = setup();
    const result = await tap.searchForElement(
      {
        action: "tap",
        text: "Environment",
        selectionStrategy: "unique",
        searchUntil: { duration: 100 },
        verification: { refresh: async () => hierarchy },
      },
      buildObserveResult({
        updatedAt: 0,
        systemInsets: { top: 0, bottom: 0, left: 0, right: 0 },
        viewHierarchy: hierarchy,
        screenSize: { width: 2560, height: 2558 },
      }),
    );
    expect(result.selection.element).toBeNull();
    expect(result.visibilityError?.message).toContain("hidden XR system chrome");
  });

  test("ordinary Android lookups do not query XR", async () => {
    const { search, detector, adb } = setup(false);
    await search({ hierarchy: {} });
    expect(detector.queries).toEqual([]);
    expect(adb.getAllCommands()).toEqual([]);
  });

  test("a hidden match first seen during polling also queries XR only once", async () => {
    const { search, detector } = setup();
    const result = await search({ hierarchy: {} }, "Recents", tree());
    expect(result.selection.element).toBeNull();
    expect(result.visibilityError?.message).toContain("Recents");
    expect(detector.queries).toEqual(["fake"]);
  });

  test("prefers a visible match over the captured hidden match", async () => {
    const hierarchy = tree();
    // Synthetic visible sibling using the captured node shape; the fixture stays unmodified.
    const visible = {
      ...target(hierarchy, "Environment").source,
      "visible-to-user": true,
      "view-id": "visible-environment",
      bounds: { left: 100, top: 100, right: 200, bottom: 200 },
    };
    hierarchy.windows!.push({ id: 999, packageName: "com.android.systemui", hierarchy: visible });
    const { search, timer } = setup();
    const result = await search(hierarchy);
    expect(result.selection.element?.["view-id"]).toBe("visible-environment");
    expect(result.visibilityError).toBeUndefined();
    expect(result.viewHierarchy).toBe(hierarchy);
    expect(target(hierarchy, "Environment").properties["visible-to-user"]).toBe(false);
    expect(timer.getSleepHistory()).toEqual([]);
    expect(target(tree(), "Environment").properties["visible-to-user"]).toBe(false);
  });

  test("keeps a hidden non-systemui node selectable on XR", async () => {
    const hierarchy = tree();
    const node = target(hierarchy, "Environment").source;
    Object.assign(node, { "resource-id": "example.app:id/environment" });
    const appTree: ViewHierarchyResult = {
      hierarchy: {},
      windows: [{ id: 16, packageName: "example.app", hierarchy: node }],
    };
    const result = await setup().search(appTree);
    expect(result.selection.element?.["resource-id"]).toBe("example.app:id/environment");
    expect(result.visibilityError).toBeUndefined();
  });

  test("window ownership also applies to the canonical hierarchy's windowId subtree", async () => {
    const recents = tree().windows!.find((window) => window.id === 10)!;
    const hierarchy: ViewHierarchyResult = {
      hierarchy: { node: recents.hierarchy },
      windows: [{ id: recents.id, packageName: recents.packageName }],
    };
    const result = await setup().search(hierarchy, "Recents");
    expect(result.selection.element).toBeNull();
    expect(result.visibilityError?.message).toContain("hidden XR system chrome");
  });

  test("resource-id ownership works without window metadata", async () => {
    const node = target(tree(), "Environment").source;
    const result = await setup().search({ hierarchy: { node } });
    expect(result.selection.element).toBeNull();
    expect(result.visibilityError?.message).toContain("hidden XR system chrome");
  });

  test("only the extractor's boolean false flag is excluded", async () => {
    // Synthetic flag variants on the captured node shape; no visibility inference.
    for (const flag of [undefined, true, "false"]) {
      const node = { ...target(tree(), "Environment").source, "visible-to-user": flag };
      const result = await setup().search({ hierarchy: { node } });
      expect(result.selection.element?.["content-desc"]).toBe("Environment");
      expect(result.visibilityError).toBeUndefined();
    }
  });

  test("phone keeps the same hidden systemui target unchanged", async () => {
    const result = await setup(false).search(tree());
    expect(result.selection.element?.["resource-id"]).toBe(
      "com.android.systemui:id/home_screen_env_button",
    );
    expect(result.visibilityError).toBeUndefined();
  });

  test("iOS skips the XR detector entirely", async () => {
    const { search, detector } = setup(true, "ios");
    await search({ hierarchy: {} });
    expect(detector.queries).toEqual([]);
  });

  test("polling can replace a hidden match with a visible control", async () => {
    const refreshed = tree();
    Object.assign(target(refreshed, "Environment").source, { "visible-to-user": true });
    const { search, detector } = setup();
    const result = await search(tree(), "Environment", refreshed);
    expect(result.selection.element?.["content-desc"]).toBe("Environment");
    expect(result.visibilityError).toBeUndefined();
    expect(result.stats.requestCount).toBe(1);
    expect(detector.queries).toEqual(["fake"]);
  });
});
