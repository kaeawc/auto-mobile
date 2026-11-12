import { describe, expect, test } from "bun:test";
import {
  enableHeadlessPrototypeMode,
  headlessPrototypeRefusal,
  isHeadlessPrototypeMode,
  isVirtualPrototypeDevice,
  VIRTUAL_PROTOTYPE_CAPABILITIES,
  VIRTUAL_PROTOTYPE_DEVICE,
  VIRTUAL_PROTOTYPE_UNSUPPORTED_CAPABILITIES,
  virtualPrototypeDeviceReport,
} from "../../../../src/features/prototype/headless/headlessPrototypeMode";

describe("headless prototype mode (#17974)", () => {
  test("is selected only by an explicit AUTOMOBILE_HEADLESS", () => {
    expect(isHeadlessPrototypeMode({})).toBe(false);
    expect(isHeadlessPrototypeMode({ AUTOMOBILE_HEADLESS: "0" })).toBe(false);
    expect(isHeadlessPrototypeMode({ AUTOMOBILE_HEADLESS: "1" })).toBe(true);
    expect(isHeadlessPrototypeMode({ AUTOMOBILE_HEADLESS: "true" })).toBe(true);
  });

  test("--headless sets the variable a spawned daemon inherits", () => {
    const env: NodeJS.ProcessEnv = {};
    enableHeadlessPrototypeMode(env);
    expect(isHeadlessPrototypeMode(env)).toBe(true);
  });

  test("the virtual device is recognised by id", () => {
    expect(isVirtualPrototypeDevice(VIRTUAL_PROTOTYPE_DEVICE)).toBe(true);
    expect(isVirtualPrototypeDevice({ deviceId: "emulator-5554" })).toBe(false);
  });

  test("device-only actions and display are refused with a reason", () => {
    for (const action of ["save", "listSaved", "deleteSaved", "open", "clearStorage", "simulate"]) {
      expect(headlessPrototypeRefusal({ action })).toContain("needs a real device");
    }
    expect(headlessPrototypeRefusal({ action: "show", display: "external" })).toContain("display");
    for (const action of ["show", "patch", "dismiss", "status", "inspect", "awaitEvent"]) {
      expect(headlessPrototypeRefusal({ action })).toBeUndefined();
    }
  });

  test("advertised and unsupported capabilities never overlap, and results name the gaps", () => {
    const advertised = new Set(VIRTUAL_PROTOTYPE_CAPABILITIES);
    expect(VIRTUAL_PROTOTYPE_UNSUPPORTED_CAPABILITIES.filter((c) => advertised.has(c))).toEqual([]);
    expect(virtualPrototypeDeviceReport()).toEqual({
      deviceId: VIRTUAL_PROTOTYPE_DEVICE.deviceId,
      renderer: "web",
      unsupportedCapabilities: [...VIRTUAL_PROTOTYPE_UNSUPPORTED_CAPABILITIES],
    });
  });
});
