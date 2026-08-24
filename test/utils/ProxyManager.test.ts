import { describe, it, expect, beforeEach } from "bun:test";
import { FakeProxyManager } from "../fakes/FakeProxyManager";
import { FakeCtrlProxyManager } from "../fakes/FakeCtrlProxyManager";
import { FakeIOSCtrlProxyManager } from "../fakes/FakeIOSCtrlProxyManager";
import type { ProxyManager } from "../../src/utils/interfaces/ProxyManager";

/**
 * Sanity-check the platform-agnostic ProxyManager contract.
 *
 * These tests deliberately type their subjects as the abstract
 * ProxyManager interface so a regression that drops one of the shared
 * methods from a concrete fake will surface as a compile error here
 * before tests even run.
 */
describe("ProxyManager interface", () => {
  describe("FakeProxyManager", () => {
    let manager: FakeProxyManager;

    beforeEach(() => {
      manager = new FakeProxyManager();
    });

    it("reports installed state via the interface method", async () => {
      manager.setInstalled(true);
      expect(await manager.isInstalled()).toBe(true);
      manager.setInstalled(false);
      expect(await manager.isInstalled()).toBe(false);
    });

    it("reports availability via the interface method", async () => {
      manager.setAvailable(true);
      expect(await manager.isAvailable()).toBe(true);
      manager.setAvailable(false);
      expect(await manager.isAvailable()).toBe(false);
    });

    it("returns a ProxySetupResult from setup()", async () => {
      const result = await manager.setup();
      expect(result.success).toBe(true);
      expect(typeof result.message).toBe("string");
    });

    it("propagates configured setup failure as ProxySetupResult", async () => {
      manager.setSetupShouldFail(true);
      const result = await manager.setup();
      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
    });

    it("records resetSetupState() invocations", () => {
      manager.resetSetupState();
      manager.resetSetupState();
      expect(manager.getCallCount("resetSetupState")).toBe(2);
    });

    it("threads force flag through to setup()", async () => {
      await manager.setup(true);
      expect(manager.wasMethodCalled("setup")).toBe(true);
      expect(manager.getExecutedOperations()).toContain("setup:force=true");
    });
  });

  // Both platform-specific fakes implement richer sub-interfaces but
  // must still satisfy ProxyManager. Assigning them to the abstract
  // type proves it at compile-time; the assertions cover behavior.
  const platformFakes: ReadonlyArray<[string, () => ProxyManager]> = [
    [
      "Android FakeCtrlProxyManager",
      () => {
        const fake = new FakeCtrlProxyManager();
        fake.setInstalled(true);
        fake.setAvailable(true);
        return fake;
      },
    ],
    [
      "iOS FakeIOSCtrlProxyManager",
      () => {
        const fake = new FakeIOSCtrlProxyManager();
        fake.setInstalled(true);
        fake.setAvailable(true);
        return fake;
      },
    ],
  ];

  for (const [name, build] of platformFakes) {
    describe(`${name} satisfies ProxyManager`, () => {
      it("exposes the shared lifecycle methods via the abstract type", async () => {
        const asProxy: ProxyManager = build();

        expect(await asProxy.isInstalled()).toBe(true);
        expect(await asProxy.isAvailable()).toBe(true);

        const result = await asProxy.setup();
        expect(result.success).toBe(true);

        asProxy.resetSetupState();
      });
    });
  }
});
