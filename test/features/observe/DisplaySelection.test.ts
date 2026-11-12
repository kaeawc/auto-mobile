import { describe, expect, test } from "bun:test";
import {
  DisplaySelectionError,
  resolveDeviceTargetDisplay,
  resolveTargetDisplay,
  validateDisplayPin,
} from "../../../src/features/observe/DisplaySelection";
import { isPhysicalPanel, type DeviceDisplays } from "../../../src/models/DisplayPanel";
import { displayInventoryOutcome, type BootedDevice } from "../../../src/models/DeviceInfo";
import { DisplayInventoryUnavailableError } from "../../../src/models/DisplayInventoryUnavailableError";

const displays: DeviceDisplays = {
  panels: [
    { key: "inner-id", role: "inner", sizePx: { width: 200, height: 200 } },
    { key: "cover-id", role: "cover", sizePx: { width: 100, height: 100 } },
    { key: "rear-id", role: "rear", sizePx: { width: 80, height: 80 } },
    { key: "external-id", role: "external", sizePx: { width: 300, height: 300 } },
  ],
  postures: ["closed", "opened", "rear_display"],
};

describe("resolveDeviceTargetDisplay", () => {
  const unreadable: Pick<BootedDevice, "displays" | typeof displayInventoryOutcome> = {
    [displayInventoryOutcome]: { kind: "unreadable", reason: "dumpsys display timed out" },
  };

  test.each(["4619827551948147201", "inner", "0"])(
    "unreadable inventory rejects explicit selector %s with a retryable error",
    (request) => {
      let failure: unknown;
      try {
        resolveDeviceTargetDisplay(unreadable, request, {});
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(DisplayInventoryUnavailableError);
      expect(failure).toMatchObject({ details: { retryable: true } });
    },
  );

  test("unreadable outcome takes precedence over an attached inventory", () => {
    expect(() => resolveDeviceTargetDisplay({ ...unreadable, displays }, "inner", {})).toThrow(
      DisplayInventoryUnavailableError,
    );
  });

  test.each([undefined, "active"])("unreadable inventory preserves %s fallback", (request) => {
    expect(resolveDeviceTargetDisplay(unreadable, request, {})).toEqual(
      resolveTargetDisplay(undefined, request, {}),
    );
    expect(
      resolveDeviceTargetDisplay({ ...unreadable, displays }, request, {
        focusedPanelKey: "cover-id",
      }).key,
    ).toBe("cover-id");
  });

  test("readable inventory still rejects a wrong key with the real panels", () => {
    const readable = { displays, [displayInventoryOutcome]: { kind: "multi" as const } };
    const resolve = () => resolveDeviceTargetDisplay(readable, "missing", {});
    expect(resolve).toThrow(DisplaySelectionError);
    expect(resolve).toThrow(
      'Unknown or unavailable display "missing". Available panels: inner-id (inner), cover-id (cover), rear-id (rear), external-id (external)',
    );
  });

  test("absent outcome and successful single-display reads preserve explicit zero", () => {
    for (const device of [{}, { [displayInventoryOutcome]: { kind: "single" as const } }]) {
      expect(resolveDeviceTargetDisplay(device, "0", {}).key).toBe("0");
    }
    expect(resolveDeviceTargetDisplay({ displays }, "inner", {}).key).toBe("inner-id");
  });
});

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

describe("virtual displays (#16462)", () => {
  const virtualKey = "virtual:com.example.app:Presentation";
  const withVirtual: DeviceDisplays = {
    panels: [
      { key: "phone-id", role: "unknown", sizePx: { width: 100, height: 200 } },
      { key: virtualKey, role: "virtual", sizePx: { width: 128, height: 72 } },
    ],
    postures: ["unknown"],
  };

  test("are addressable by key, role and pin", () => {
    expect(resolveTargetDisplay(withVirtual, virtualKey, {}).key).toBe(virtualKey);
    expect(resolveTargetDisplay(withVirtual, "virtual", {}).key).toBe(virtualKey);
    expect(validateDisplayPin(withVirtual, "virtual")).toBe("virtual");
  });

  test("are never the inventory-order fallback or a physical panel", () => {
    expect(resolveTargetDisplay(withVirtual, "active", {}).key).toBe("phone-id");
    expect(withVirtual.panels.filter(isPhysicalPanel).map((panel) => panel.key)).toEqual([
      "phone-id",
    ]);
  });
});
