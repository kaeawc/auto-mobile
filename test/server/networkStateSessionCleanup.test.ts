import { beforeEach, describe, expect, test } from "bun:test";
import type { SessionManager } from "../../src/daemon/sessionManager";
import { NetworkState } from "../../src/server/NetworkState";
import { buildNetworkMockRules } from "../../src/server/networkMockRules";
import {
  registerNetworkStateSessionCleanup,
  type NetworkDeviceStatePusher,
} from "../../src/server/networkStateSessionCleanup";
import { FakeTimer } from "../fakes/FakeTimer";

type CleanupManager = Parameters<typeof registerNetworkStateSessionCleanup>[0];
type ReleaseCallback = Parameters<SessionManager["onSessionRelease"]>[0];
type UnboundCallback = Parameters<SessionManager["onSessionDeviceUnbound"]>[0];

class FakeSessionManager implements CleanupManager {
  releaseCallbacks: ReleaseCallback[] = [];
  unboundCallbacks: UnboundCallback[] = [];
  pendingCleanups: Array<{ deviceId: string; cleanup: Promise<unknown> }> = [];

  onSessionRelease(callback: ReleaseCallback): void {
    this.releaseCallbacks.push(callback);
  }

  onSessionDeviceUnbound(callback: UnboundCallback): void {
    this.unboundCallbacks.push(callback);
  }

  registerPendingDeviceCleanup(deviceId: string, cleanup: Promise<unknown>): void {
    this.pendingCleanups.push({ deviceId, cleanup });
  }

  release(sessionId: string, deviceId: string): void {
    for (const callback of this.releaseCallbacks) {
      callback(sessionId, deviceId, "explicit-release", {
        sessionId,
        deviceId,
        releaseReason: "explicit-release",
        releasedAtMs: 0,
        terminal: true,
        heartbeat: { lastHeartbeatMs: 0, hasReceivedHeartbeat: false, timeoutMs: 0, ageMs: 0 },
      });
    }
  }

  unbind(sessionId: string, deviceId: string): void {
    for (const callback of this.unboundCallbacks) {
      callback(sessionId, deviceId);
    }
  }
}

/** Records, per device, the rules the device would receive when the push runs. */
class FakePusher implements NetworkDeviceStatePusher {
  pushes: Array<{ deviceId: string; ruleIds: string[]; simulating: boolean }> = [];
  failWith: Error | null = null;

  constructor(private readonly state: NetworkState) {}

  async push(deviceId: string): Promise<void> {
    this.pushes.push({
      deviceId,
      ruleIds: buildNetworkMockRules(this.state, deviceId).map((rule) => rule.mockId),
      simulating: this.state.getSimulation(deviceId) !== null,
    });
    if (this.failWith) {
      throw this.failWith;
    }
  }
}

const DEVICE_A = "emulator-5554";
const DEVICE_B = "emulator-5556";

function rule(host: string) {
  return {
    host,
    path: "/x",
    method: "*",
    limit: null,
    statusCode: 500,
    responseHeaders: {},
    responseBody: "",
    contentType: "application/json",
  };
}

describe("registerNetworkStateSessionCleanup (#10061)", () => {
  let state: NetworkState;
  let manager: FakeSessionManager;
  let pusher: FakePusher;

  beforeEach(() => {
    state = new NetworkState({
      timer: new FakeTimer(),
      notifier: { notifyResourceUpdated: () => {} },
    });
    manager = new FakeSessionManager();
    pusher = new FakePusher(state);
    registerNetworkStateSessionCleanup(manager, { state: () => state, pusher });
  });

  test("releasing the owning session empties the device store and pushes the empty set", async () => {
    state.noteSessionOwner(DEVICE_A, "session-1");
    state.addMock(DEVICE_A, rule("a.com"));
    state.startSimulation(DEVICE_A, "timeout", 30, null);

    manager.release("session-1", DEVICE_A);

    expect(state.getMocks(DEVICE_A).size).toBe(0);
    expect(state.getSimulation(DEVICE_A)).toBeNull();
    expect(manager.pendingCleanups.map((entry) => entry.deviceId)).toEqual([DEVICE_A]);
    await manager.pendingCleanups[0].cleanup;
    expect(pusher.pushes).toEqual([{ deviceId: DEVICE_A, ruleIds: [], simulating: false }]);
  });

  test("a second session's device keeps its rules when the first session is released", async () => {
    state.noteSessionOwner(DEVICE_A, "session-1");
    state.addMock(DEVICE_A, rule("a.com"));
    state.noteSessionOwner(DEVICE_B, "session-2");
    const keep = state.addMock(DEVICE_B, rule("b.com"));
    state.startSimulation(DEVICE_B, "timeout", 30, null);

    manager.release("session-1", DEVICE_A);
    await Promise.all(manager.pendingCleanups.map((entry) => entry.cleanup));

    expect(Array.from(state.getMocks(DEVICE_B).keys())).toEqual([keep.mockId]);
    expect(state.getSimulation(DEVICE_B)).not.toBeNull();
    expect(pusher.pushes.map((push) => push.deviceId)).toEqual([DEVICE_A]);
  });

  test("a release for a different session or an unrelated device clears nothing", () => {
    state.noteSessionOwner(DEVICE_A, "session-1");
    state.addMock(DEVICE_A, rule("a.com"));

    manager.release("session-2", DEVICE_A);
    manager.release("session-1", DEVICE_B);

    expect(state.getMocks(DEVICE_A).size).toBe(1);
    expect(manager.pendingCleanups).toEqual([]);
    expect(pusher.pushes).toEqual([]);
  });

  test("state installed without a session survives a session release", () => {
    state.addMock(DEVICE_A, rule("a.com"));

    manager.release("session-1", DEVICE_A);

    expect(state.getMocks(DEVICE_A).size).toBe(1);
    expect(pusher.pushes).toEqual([]);
  });

  test("a session leaving the device without ending clears the device it left", async () => {
    state.noteSessionOwner(DEVICE_A, "session-1");
    state.addMock(DEVICE_A, rule("a.com"));

    manager.unbind("session-1", DEVICE_A);
    await Promise.all(manager.pendingCleanups.map((entry) => entry.cleanup));

    expect(state.getMocks(DEVICE_A).size).toBe(0);
    expect(pusher.pushes).toEqual([{ deviceId: DEVICE_A, ruleIds: [], simulating: false }]);
  });

  test("the next session on the device starts empty, and a reconnect resyncs nothing", async () => {
    state.noteSessionOwner(DEVICE_A, "session-1");
    state.addMock(DEVICE_A, rule("a.com"));
    manager.release("session-1", DEVICE_A);
    await Promise.all(manager.pendingCleanups.map((entry) => entry.cleanup));

    expect(buildNetworkMockRules(state, DEVICE_A)).toEqual([]);
    // Releasing the already-cleared session again is a no-op.
    manager.release("session-1", DEVICE_A);
    expect(manager.pendingCleanups).toHaveLength(1);
  });

  test("a failing device push is contained and the host store is still cleared", async () => {
    pusher.failWith = new Error("socket closed");
    state.noteSessionOwner(DEVICE_A, "session-1");
    state.addMock(DEVICE_A, rule("a.com"));

    manager.release("session-1", DEVICE_A);

    expect(state.getMocks(DEVICE_A).size).toBe(0);
    await expect(manager.pendingCleanups[0].cleanup).resolves.toBeUndefined();
  });
});
