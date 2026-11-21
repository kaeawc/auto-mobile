import { expect, test } from "bun:test";
import { registerAXBridgeSessionLifecycle } from "../../src/daemon/axBridgeSessionLifecycle";
import type { SessionManager, Session } from "../../src/daemon/sessionManager";
import { AXBridgeSessions } from "../../src/utils/ios/AXBridgeSessions";
import { FakeSessionCleanupManager } from "../fakes/FakeSessionCleanupManager";
import { FakeAXBridgePreflight } from "../fakes/FakeAXBridgePreflight";
import { FakeAXBridgeProcessLauncher } from "../fakes/FakeAXBridgeProcessLauncher";
import { FakeTimer } from "../fakes/FakeTimer";
import { FakeIdGenerator } from "../fakes/FakeIdGenerator";

class FakeHooks extends FakeSessionCleanupManager {
  created?: Parameters<SessionManager["onSessionCreated"]>[0];
  changed?: Parameters<SessionManager["onDeviceOwnershipChange"]>[0];
  session: Session | null = null;
  onSessionCreated(callback: NonNullable<FakeHooks["created"]>): void {
    this.created = callback;
  }
  onDeviceOwnershipChange(callback: NonNullable<FakeHooks["changed"]>): () => void {
    this.changed = callback;
    return () => {
      this.changed = undefined;
    };
  }
  peekSession(): Session | null {
    return this.session;
  }
}

// Lifecycle creation only reads these fields; the fake narrows its emission contract.
function createdSession(platform: Session["platform"], assignedDevice: string): Session {
  return {
    sessionId: "session",
    assignedDevice,
    platform,
    createdAt: 0,
    lastUsedAt: 0,
    activityGeneration: 0,
    expiresAt: 1000,
    cacheData: {},
    lastHeartbeat: 0,
    sessionTimeoutMs: 1000,
    heartbeatTimeoutMs: 1000,
    heartbeatTimeoutSource: "default",
    hasReceivedHeartbeat: false,
    ownership: "owned",
    livenessPolicy: "heartbeat",
  };
}

test("wiring starts only iOS simulators, ignores upgrades and cleans up unbind/release", async () => {
  const hooks = new FakeHooks();
  const launcher = new FakeAXBridgeProcessLauncher();
  const sessions = new AXBridgeSessions({
    enabled: () => true,
    launcher,
    preflight: new FakeAXBridgePreflight(),
    timer: new FakeTimer(),
    idGenerator: new FakeIdGenerator(["a"]),
  });
  registerAXBridgeSessionLifecycle(hooks, sessions);
  const device = "11111111-2222-3333-4444-555555555555";
  hooks.created?.(createdSession("android", device));
  hooks.created?.(createdSession("watchos", device));
  hooks.created?.(createdSession("ios", "00008030-001C2D3E1234567A"));
  expect(launcher.launches).toHaveLength(0);
  hooks.created?.(createdSession("ios", device));
  await sessions.start("session", device);
  hooks.release("session", device, true);
  expect(launcher.launches[0].kills).toBe(0);
  hooks.unbound("session", device);
  expect(launcher.launches[0].kills).toBe(1);
  hooks.session = createdSession("ios", device);
  hooks.holders.set(device, "session");
  hooks.changed?.(device, "full");
  await sessions.start("session", device);
  hooks.release("session", device);
  expect(launcher.launches[1].kills).toBe(1);
});
