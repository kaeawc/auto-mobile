import { describe, expect, test } from "bun:test";
import { SafeAreaAuditor } from "../../../../src/features/observe/audits/SafeAreaAuditor";
import type { ObserveResult } from "../../../../../src/models";

function observation(): ObserveResult {
  return {
    updatedAt: 1,
    screenSize: { width: 100, height: 200 },
    systemInsets: { top: 20, right: 0, bottom: 20, left: 0 },
    insets: {
      available: true,
      source: "android-window-metrics",
      units: "physical-pixels",
      systemBars: {
        visible: { top: 20, right: 0, bottom: 20, left: 0 },
        stable: { top: 20, right: 0, bottom: 20, left: 0 },
      },
      systemGestures: { top: 0, right: 0, bottom: 0, left: 0 },
    },
    viewHierarchy: {
      hierarchy: {
        node: [
          { "text": "Title", "view-id": "title", "bounds": { left: 10, top: 8, right: 60, bottom: 28 } },
          { "text": "Continue", "clickable": "true", "view-id": "continue", "bounds": { left: 10, top: 170, right: 90, bottom: 196 } },
          { "text": "System time", "resource-id": "com.android.systemui:id/clock", "bounds": { left: 0, top: 0, right: 20, bottom: 20 } },
        ] as any,
      },
    },
  };
}

describe("SafeAreaAuditor", () => {
  test("reports text and interactive content under visible bars, excluding system UI", () => {
    const warnings = new SafeAreaAuditor().inspect(observation());

    expect(warnings).toHaveLength(2);
    expect(warnings.map(warning => warning.element.viewId)).toEqual(["title", "continue"]);
    expect(warnings[1]).toMatchObject({ categories: ["text", "interaction"], sides: ["bottom"], insetTypes: ["systemBars"] });
  });

  test("returns no warnings when measurements are unavailable", () => {
    const result = observation();
    result.insets = { available: false, source: "unavailable", units: "unknown" };

    expect(new SafeAreaAuditor().inspect(result)).toEqual([]);
  });

  test("tolerates nullable Android runner inset categories", () => {
    const result = observation();
    result.insets!.displayCutout = null as never;
    result.insets!.systemGestures = null as never;

    expect(new SafeAreaAuditor().inspect(result)).toHaveLength(2);
  });

  test("does not attribute a zero-valued display cutout to bar overlap", () => {
    const result = observation();
    result.insets!.displayCutout = { top: 0, right: 0, bottom: 0, left: 0 };

    expect(new SafeAreaAuditor().inspect(result)[0]?.insetTypes).toEqual(["systemBars"]);
  });

  test("uses the iOS safe area rather than Android bar fields", () => {
    const result = observation();
    result.insets = {
      available: true,
      source: "ios-sdk-safe-area",
      units: "points",
      safeArea: { top: 30, right: 0, bottom: 30, left: 0 },
    };

    expect(new SafeAreaAuditor().inspect(result)[0]?.insetTypes).toEqual(["safeArea"]);
  });

  test("reads iOS CtrlProxy attributes from the hierarchy attribute bag", () => {
    const result = observation();
    result.insets = {
      available: true,
      source: "ios-sdk-safe-area",
      units: "points",
      safeArea: { top: 30, right: 0, bottom: 30, left: 0 },
    };
    result.viewHierarchy!.hierarchy.node = [{
      $: {
        "text": "Title",
        "view-id": "ios-title",
        "bounds": { left: 10, top: 8, right: 60, bottom: 28 },
      },
    }] as any;

    expect(new SafeAreaAuditor().inspect(result)).toMatchObject([
      { element: { viewId: "ios-title" }, insetTypes: ["safeArea"], sides: ["top"] },
    ]);
  });
});
