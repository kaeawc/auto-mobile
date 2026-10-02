import { describe, expect, test } from "bun:test";
import { resolveTargetDisplay } from "../../../src/features/observe/DisplaySelection";
import type { DeviceDisplays } from "../../../src/models/DisplayPanel";

const displays: DeviceDisplays = {
  panels: [
    { key: "inner-id", role: "inner", sizePx: { width: 200, height: 200 } },
    { key: "cover-id", role: "cover", sizePx: { width: 100, height: 100 } },
    { key: "rear-id", role: "rear", sizePx: { width: 80, height: 80 } },
    { key: "external-id", role: "external", sizePx: { width: 300, height: 300 } },
  ],
  postures: ["closed", "opened", "rear_display"],
};

describe("resolveTargetDisplay", () => {
  test("explicit key or role takes precedence over focus and posture", () => {
    expect(
      resolveTargetDisplay(displays, "external-id", {
        focusedPanelKey: "cover-id",
        posture: "closed",
      }).key,
    ).toBe("external-id");
    expect(
      resolveTargetDisplay(displays, "rear", { focusedPanelKey: "cover-id", posture: "closed" })
        .key,
    ).toBe("rear-id");
  });

  test("active and omitted requests use input focus before posture", () => {
    expect(
      resolveTargetDisplay(displays, "active", {
        focusedPanelKey: "external-id",
        posture: "closed",
      }).key,
    ).toBe("external-id");
    expect(
      resolveTargetDisplay(displays, undefined, { focusedPanelKey: "rear-id", posture: "opened" })
        .key,
    ).toBe("rear-id");
  });

  test("posture defaults select cover or inner", () => {
    expect(resolveTargetDisplay(displays, undefined, { posture: "closed" }).key).toBe("cover-id");
    expect(resolveTargetDisplay(displays, undefined, { posture: "opened" }).key).toBe("inner-id");
    expect(resolveTargetDisplay(displays, undefined, { posture: "rear_display" }).key).toBe(
      "inner-id",
    );
  });

  test("single-display fallback preserves logical display zero", () => {
    expect(resolveTargetDisplay(undefined, undefined, {})).toMatchObject({
      key: "0",
      role: "unknown",
    });
  });

  test("unknown, unavailable role, and all give actionable choices", () => {
    expect(() => resolveTargetDisplay(displays, "missing", {})).toThrow(
      /Available panels:.*inner-id.*cover-id/,
    );
    expect(() =>
      resolveTargetDisplay({ ...displays, panels: displays.panels.slice(0, 2) }, "rear", {}),
    ).toThrow(/Available panels:.*inner-id.*cover-id/);
    expect(() => resolveTargetDisplay(displays, "all", {})).toThrow(
      /all.*not supported for single-panel targeting.*Choose one panel/,
    );
  });
});
