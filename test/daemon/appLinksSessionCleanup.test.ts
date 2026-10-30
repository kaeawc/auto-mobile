import { beforeEach, describe, expect, test } from "bun:test";
import type { BootedDevice } from "../../src/models";
import { registerAppLinksSessionCleanup } from "../../src/daemon/appLinksSessionCleanup";
import { AppLinksRestoreRegistry } from "../../src/features/utility/appLinks/AppLinkRestore";
import { FakeAppLinksDevice } from "../fakes/FakeAppLinksDevice";
import { FakeSessionCleanupManager } from "../fakes/FakeSessionCleanupManager";

const device: BootedDevice = { name: "emulator", platform: "android", deviceId: "emulator-5554" };
const PKG = "com.example.shop";

describe("registerAppLinksSessionCleanup (#14110)", () => {
  let manager: FakeSessionCleanupManager;
  let registry: AppLinksRestoreRegistry;
  let appLinks: FakeAppLinksDevice;

  beforeEach(() => {
    manager = new FakeSessionCleanupManager();
    registry = new AppLinksRestoreRegistry();
    appLinks = new FakeAppLinksDevice().install(PKG, {
      verification: { "shop.example.com": "approved" },
      otherDomains: ["promo.example.net"],
      users: { 0: { enabled: ["promo.example.net"] } },
    });
    registerAppLinksSessionCleanup(manager, { registry, appLinksFor: () => appLinks });
    const before = {
      verification: new Map([["shop.example.com", "verified"]]),
      user: { userId: 0, domains: ["shop.example.com", "promo.example.net"], enabled: [] },
    };
    registry.record(device, PKG, before, { scope: { verification: true, userId: 0 }, owner: "s1" });
  });

  test("release restores the session's recorded state as pending device cleanup", async () => {
    manager.release("s1", device.deviceId);
    expect(manager.pendingCleanups).toHaveLength(1);
    expect(manager.pendingCleanups[0]?.bound).toMatchObject({ name: "restore App Links state" });
    await manager.settle();
    expect(appLinks.state(PKG, "shop.example.com")).toBe("verified");
    expect(appLinks.enabled(PKG, 0)).toEqual([]);
    expect(registry.get(device.deviceId, PKG)).toBeUndefined();
  });

  test("rebinding off the device restores too", async () => {
    manager.unbind("s1", device.deviceId);
    await manager.settle();
    expect(appLinks.state(PKG, "shop.example.com")).toBe("verified");
  });

  test("another session's release, an upgrade-only release, and a replaced serial write nothing", async () => {
    manager.release("s2", device.deviceId);
    manager.release("s1", device.deviceId, true);
    expect(manager.pendingCleanups).toHaveLength(0);
    expect(registry.get(device.deviceId, PKG)).toBeDefined();

    manager.release("s1", device.deviceId, false, true);
    expect(manager.pendingCleanups).toHaveLength(0);
    expect(registry.get(device.deviceId, PKG)).toBeUndefined();
    expect(appLinks.calls).toEqual([]);
  });
});
