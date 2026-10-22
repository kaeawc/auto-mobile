import { beforeEach, describe, expect, test } from "bun:test";
import { registerSystemAlertSessionCleanup } from "../../src/daemon/systemAlertSessionCleanup";
import { SystemAlertPolicyRegistry } from "../../src/features/action/systemAlerts/SystemAlertPolicy";
import { FakeSessionCleanupManager } from "../fakes/FakeSessionCleanupManager";

const deviceId = "emulator-5554";

describe("registerSystemAlertSessionCleanup (#14106)", () => {
  let registry: SystemAlertPolicyRegistry;
  let manager: FakeSessionCleanupManager;

  beforeEach(() => {
    registry = new SystemAlertPolicyRegistry();
    manager = new FakeSessionCleanupManager();
    registerSystemAlertSessionCleanup(manager, { registry });
  });

  test("a session's release clears the policy it set", () => {
    registry.set(deviceId, { policy: "allow", match: [], owner: "session-1" });
    manager.release("session-1", deviceId);
    expect(registry.get(deviceId)).toBeUndefined();
  });

  test("moving off the device clears it like a release", () => {
    registry.set(deviceId, { policy: "deny", match: [], owner: "session-1" });
    manager.unbound("session-1", deviceId);
    expect(registry.get(deviceId)).toBeUndefined();
  });

  test("another session's release, a terminal upgrade and a sessionless policy are left alone", () => {
    registry.set(deviceId, { policy: "allow", match: [], owner: "session-2" });
    manager.release("session-1", deviceId);
    manager.release("session-2", deviceId, true);
    expect(registry.get(deviceId)?.owner).toBe("session-2");

    registry.set(deviceId, { policy: "allow", match: [] });
    manager.release("session-2", deviceId);
    expect(registry.get(deviceId)?.policy).toBe("allow");
  });
});
