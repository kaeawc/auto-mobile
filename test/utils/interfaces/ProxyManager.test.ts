import { describe, it, expect, beforeEach } from "bun:test";
import { FakeProxyManager } from "../../fakes/FakeProxyManager";
import { FakeCtrlProxyManager } from "../../fakes/FakeCtrlProxyManager";
import { FakeIOSCtrlProxyManager } from "../../fakes/FakeIOSCtrlProxyManager";
import type { ProxyManager } from "../../../src/utils/interfaces/ProxyManager";

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
    let manager: ProxyManager & FakeProxyManager;

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

  describe("Android FakeCtrlProxyManager satisfies ProxyManager", () => {
    it("can be assigned to ProxyManager and exposes shared methods", async () => {
      const fake = new FakeCtrlProxyManager();
      fake.setInstalled(true);
      fake.setAvailable(true);

      // Compile-time check: assigning a richer fake to the abstract type
      // proves that FakeCtrlProxyManager (and therefore the Android
      // manager interface it implements) satisfies ProxyManager.
      const asProxy: ProxyManager = fake;

      expect(await asProxy.isInstalled()).toBe(true);
      expect(await asProxy.isAvailable()).toBe(true);

      const result = await asProxy.setup();
      expect(result.success).toBe(true);

      asProxy.resetSetupState();
    });
  });

  describe("iOS FakeIOSCtrlProxyManager satisfies ProxyManager", () => {
    it("can be assigned to ProxyManager and exposes shared methods", async () => {
      const fake = new FakeIOSCtrlProxyManager();
      fake.setInstalled(true);
      fake.setAvailable(true);

      // Compile-time check: assigning a richer fake to the abstract type
      // proves that FakeIOSCtrlProxyManager (and therefore the iOS
      // manager interface it implements) satisfies ProxyManager.
      const asProxy: ProxyManager = fake;

      expect(await asProxy.isInstalled()).toBe(true);
      expect(await asProxy.isAvailable()).toBe(true);

      const result = await asProxy.setup();
      expect(result.success).toBe(true);

      asProxy.resetSetupState();
    });
  });
});
