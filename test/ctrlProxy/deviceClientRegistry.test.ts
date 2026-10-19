import { describe, expect, test } from "bun:test";
import {
  MapDeviceClientRegistry,
  type DeviceClientRegistry,
} from "../../src/ctrlProxy/deviceClientRegistry";
import { AndroidCtrlProxyManager } from "../../src/ctrlProxy/CtrlProxyManager";
import { IOSCtrlProxyManager } from "../../src/ctrlProxy/IOSCtrlProxyManager";
import { FakeDeviceClientRegistry } from "../fakes/FakeDeviceClientRegistry";

type Instance = { id: number };

const implementations: Array<[string, () => DeviceClientRegistry<Instance>]> = [
  ["MapDeviceClientRegistry", () => new MapDeviceClientRegistry<Instance>()],
  ["FakeDeviceClientRegistry", () => new FakeDeviceClientRegistry<Instance>()],
];

describe.each(implementations)("DeviceClientRegistry contract: %s", (_name, build) => {
  test("get creates once; peek never creates", () => {
    const registry = build();
    let created = 0;
    const create = () => ({ id: ++created });
    expect(registry.peek("a")).toBeUndefined();
    const first = registry.get("a", create);
    expect(registry.get("a", create)).toBe(first);
    expect(registry.peek("a")).toBe(first);
    expect(created).toBe(1);
  });

  test("retire -> resume -> get keeps the instance and toggles the retired mark", () => {
    const registry = build();
    const first = registry.get("a", () => ({ id: 1 }));
    registry.retire("a");
    expect(registry.isRetired("a")).toBe(true);
    registry.resume("a");
    expect(registry.isRetired("a")).toBe(false);
    expect(registry.get("a", () => ({ id: 2 }))).toBe(first);
  });

  test("invalidate with a stale instance leaves the replacement registered", () => {
    const registry = build();
    const stale = registry.get("a", () => ({ id: 1 }));
    expect(registry.invalidate("a", stale)).toBe(true);
    const replacement = registry.get("a", () => ({ id: 2 }));
    expect(registry.invalidate("a", stale)).toBe(false);
    expect(registry.peek("a")).toBe(replacement);
    expect(registry.invalidate("a")).toBe(true);
    expect(registry.peek("a")).toBeUndefined();
  });

  test("closeAll drains instances only; clearRetired keeps instances", () => {
    const registry = build();
    const a = registry.get("a", () => ({ id: 1 }));
    const b = registry.get("b", () => ({ id: 2 }));
    registry.retire("a");
    registry.clearRetired();
    expect(registry.isRetired("a")).toBe(false);
    expect(registry.entries().map(([, i]) => i)).toEqual([a, b]);
    registry.retire("b");
    expect(registry.closeAll()).toEqual([a, b]);
    expect(registry.entries()).toEqual([]);
    expect(registry.isRetired("b")).toBe(true);
  });
});

describe("CtrlProxy manager registries", () => {
  test("both platform managers expose the same lifecycle verbs", () => {
    for (const registry of [AndroidCtrlProxyManager.registry, IOSCtrlProxyManager.registry]) {
      registry.retire("registry-contract-device");
      expect(registry.isRetired("registry-contract-device")).toBe(true);
      registry.resume("registry-contract-device");
      expect(registry.isRetired("registry-contract-device")).toBe(false);
      expect(registry.peek("registry-contract-device")).toBeUndefined();
    }
  });

  test("FakeDeviceClientRegistry records the verbs it was driven with", () => {
    const registry = new FakeDeviceClientRegistry<Instance>();
    registry.get("a", () => ({ id: 1 }));
    registry.retire("a");
    registry.resume("a");
    registry.invalidate("a");
    registry.closeAll();
    expect(registry.calls).toEqual(["get:a", "retire:a", "resume:a", "invalidate:a", "closeAll"]);
  });
});
