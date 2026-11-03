import { describe, expect, test } from "bun:test";
import {
  resolveTargetDisplay,
  validateDisplayPin,
} from "../../../src/features/observe/DisplaySelection";
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

describe("session display pin precedence", () => {
  for (const [request, pin, focus, posture, expected] of [
    ["rear", "inner", "cover-id", "closed", "rear-id"],
    [undefined, "inner", "cover-id", "closed", "inner-id"],
    [undefined, undefined, "rear-id", "closed", "rear-id"],
    [undefined, undefined, undefined, "closed", "cover-id"],
    ["active", "missing", "rear-id", "closed", "rear-id"],
    ["active", "inner", undefined, "closed", "cover-id"],
  ] as const) {
    test(`${request ?? "omitted"}/${pin ?? "no pin"}/${focus ?? "no focus"}`, () => {
      expect(
        resolveTargetDisplay(displays, request, {
          ...{ displayPin: pin },
          focusedPanelKey: focus,
          posture,
        }).key,
      ).toBe(expected);
    });
  }
  test("missing pin refuses instead of falling back", () => {
    expect(() =>
      resolveTargetDisplay(displays, undefined, {
        ...{ displayPin: "unplugged" },
        focusedPanelKey: "inner-id",
        posture: "closed",
      }),
    ).toThrow(/unplugged.*setActiveDevice.*display: null/);
  });
});

test("pin without a live list labels inventory connection status as unknown", () => {
  expect(() => resolveTargetDisplay(displays, undefined, { displayPin: "unplugged" })).toThrow(
    "Known panels (connection status unknown): inner-id (inner), cover-id (cover)",
  );
});

describe("overlay displays (#13138)", () => {
  const withOverlay: DeviceDisplays = {
    panels: [
      { key: "inner-id", role: "inner", sizePx: { width: 200, height: 200 } },
      { key: "cover-id", role: "cover", sizePx: { width: 100, height: 100 } },
      { key: "overlay:1", role: "overlay", sizePx: { width: 108, height: 192 } },
    ],
    postures: ["closed", "opened"],
  };

  test("are addressable by key or role", () => {
    expect(resolveTargetDisplay(withOverlay, "overlay:1", { posture: "opened" }).key).toBe(
      "overlay:1",
    );
    expect(resolveTargetDisplay(withOverlay, "overlay", { posture: "opened" }).key).toBe(
      "overlay:1",
    );
  });

  test("are never the posture default or the inventory-order fallback", () => {
    expect(resolveTargetDisplay(withOverlay, undefined, { posture: "closed" }).key).toBe(
      "cover-id",
    );
    expect(resolveTargetDisplay(withOverlay, undefined, { posture: "unknown" }).key).toBe(
      "inner-id",
    );
    const phone: DeviceDisplays = {
      panels: [
        { key: "phone-id", role: "unknown", sizePx: { width: 100, height: 200 } },
        { key: "overlay:1", role: "overlay", sizePx: { width: 108, height: 192 } },
      ],
      postures: ["unknown"],
    };
    expect(resolveTargetDisplay(phone, "active", {}).key).toBe("phone-id");
  });

  test("a pin may name an overlay", () => {
    expect(validateDisplayPin(withOverlay, "overlay:1")).toBe("overlay:1");
    expect(resolveTargetDisplay(withOverlay, undefined, { displayPin: "overlay" }).key).toBe(
      "overlay:1",
    );
  });
});
