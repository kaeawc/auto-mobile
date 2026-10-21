import { describe, expect, test } from "bun:test";
import {
  deleteDeviceInstanceIfCurrent,
  getOrCreateDeviceInstance,
} from "../../src/ctrlProxy/deviceInstanceRegistry";

describe("deviceInstanceRegistry", () => {
  test("getOrCreateDeviceInstance creates and registers once per device", () => {
    const registry = new Map<string, { id: number }>();
    let created = 0;
    const create = () => ({ id: ++created });

    const first = getOrCreateDeviceInstance(registry, "device-a", create);
    const again = getOrCreateDeviceInstance(registry, "device-a", create);
    const other = getOrCreateDeviceInstance(registry, "device-b", create);

    expect(again).toBe(first);
    expect(other).not.toBe(first);
    expect(created).toBe(2);
    expect(registry.get("device-a")).toBe(first);
  });

  test("getOrCreateDeviceInstance does not register when create throws", () => {
    const registry = new Map<string, object>();
    expect(() =>
      getOrCreateDeviceInstance(registry, "device-a", () => {
        throw new Error("boom");
      }),
    ).toThrow("boom");
    expect(registry.has("device-a")).toBe(false);
  });

  test("deleteDeviceInstanceIfCurrent removes only the registered instance", () => {
    const registry = new Map<string, object>();
    const stale = {};
    const current = {};
    registry.set("device-a", current);

    expect(deleteDeviceInstanceIfCurrent(registry, "device-a", stale)).toBe(false);
    expect(registry.get("device-a")).toBe(current);
    expect(deleteDeviceInstanceIfCurrent(registry, "device-a", current)).toBe(true);
    expect(registry.has("device-a")).toBe(false);
    expect(deleteDeviceInstanceIfCurrent(registry, "device-a", current)).toBe(false);
  });
});
