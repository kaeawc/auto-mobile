import { expect, test } from "bun:test";
import { registerSimHidSessionLifecycle } from "../../src/daemon/simHidSessionLifecycle";
import type { Session, SessionManager } from "../../src/daemon/sessionManager";
import { FakeSessionCleanupManager } from "../fakes/FakeSessionCleanupManager";

class FakeHooks extends FakeSessionCleanupManager {
  created?: Parameters<SessionManager["onSessionCreated"]>[0];
  onSessionCreated(callback: NonNullable<FakeHooks["created"]>): void {
    this.created = callback;
  }
}

class RecordingSessions {
  readonly warmed: string[] = [];
  readonly released: string[] = [];
  ready(deviceId: string): undefined {
    this.warmed.push(deviceId);
    return undefined;
  }
  release(deviceId: string): void {
    this.released.push(deviceId);
  }
}

// Lifecycle creation only reads these fields.
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

test("warms the helper for iOS simulator sessions only and stops it on release or unbind", () => {
  const hooks = new FakeHooks();
  const sessions = new RecordingSessions();
  registerSimHidSessionLifecycle(hooks, sessions);
  const simulator = "11111111-2222-3333-4444-555555555555";
  hooks.created?.(createdSession("android", simulator));
  hooks.created?.(createdSession("ios", "00008030-001C2D3E1234567A"));
  hooks.created?.(createdSession("ios", simulator));
  expect(sessions.warmed).toEqual([simulator]);
  hooks.release("session", simulator, true);
  expect(sessions.released).toEqual([]);
  hooks.release("session", simulator);
  hooks.unbound("session", simulator);
  expect(sessions.released).toEqual([simulator, simulator]);
});
