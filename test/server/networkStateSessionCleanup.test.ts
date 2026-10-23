import { IOSCtrlProxyClient } from "../../src/features/observe/ios";
import { FakeAdbExecutor } from "../fakes/FakeAdbExecutor";
import { AndroidCtrlProxyClient } from "../../src/features/observe/android";
import { drainUntil } from "../helpers/fakeTimerStepping";
import { beforeEach, describe, expect, test, spyOn } from "bun:test";
import { NetworkState } from "../../src/utils/NetworkState";
import { buildNetworkMockRules } from "../../src/utils/networkMockRules";
import {
  createOwnerlessNetworkStateAcquisitionCleanup,
  registerNetworkStateSessionCleanup,
  type NetworkDeviceStatePusher,
  defaultNetworkDeviceStatePusher,
} from "../../src/daemon/networkStateSessionCleanup";
import { FakeSessionCleanupManager } from "../fakes/FakeSessionCleanupManager";
import { FakeTimer } from "../fakes/FakeTimer";

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
  let manager: FakeSessionCleanupManager;
  let pusher: FakePusher;
  let gaps: Array<{ sessionId: string; reason: string }>;

  beforeEach(() => {
    state = new NetworkState({
      timer: new FakeTimer(),
      notifier: { notifyResourceUpdated: () => {} },
    });
    manager = new FakeSessionCleanupManager();
    pusher = new FakePusher(state);
    gaps = [];
    registerNetworkStateSessionCleanup(manager, {
      state: () => state,
      pusher,
      gapMarkerFor: (sessionId) => (reason) => {
        gaps.push({ sessionId, reason });
      },
    });
  });

  test("release cleanup cancels an unanswered SDK push within the ten-second cap", async () => {
    const timer = new FakeTimer();
    const boundedManager = new FakeSessionCleanupManager();
    let signal: AbortSignal | undefined;
    let deadline: number | undefined;
    const boundedPusher: NetworkDeviceStatePusher = {
      push: async (_deviceId, options) => {
        signal = options?.abortSignal;
        deadline = options?.deadlineMs;
        await new Promise<void>((_resolve, reject) => {
          signal?.addEventListener("abort", () => reject(signal?.reason), { once: true });
        });
      },
    };
    registerNetworkStateSessionCleanup(boundedManager, {
      state: () => state,
      pusher: boundedPusher,
      timer,
      gapMarkerFor: (sessionId) => (reason) => {
        gaps.push({ sessionId, reason });
      },
    });
    state.addMock(DEVICE_A, rule("a.com"), "session-1");
    boundedManager.release("session-1", DEVICE_A);
    let settled = false;
    const cleanup = boundedManager.pendingCleanups[0]!.cleanup.then(() => {
      settled = true;
    });
    expect(deadline).toBe(timer.now() + 10_000);
    timer.advanceTime(9999);
    expect(signal?.aborted).toBe(false);
    expect(settled).toBe(false);
    timer.advanceTime(1);
    await drainUntil(() => settled, { description: "network cleanup cap" });
    await cleanup;
    expect(signal?.aborted).toBe(true);
    expect(timer.getPendingTimeoutCount()).toBe(0);
    expect(gaps).toEqual([
      {
        sessionId: "session-1",
        reason: expect.stringContaining("Network cleanup deadline expired"),
      },
    ]);
  });

  test("releasing the owning session empties the device store and pushes the empty set", async () => {
    state.addMock(DEVICE_A, rule("a.com"), "session-1");
    state.startSimulation(DEVICE_A, "timeout", 30, null, "session-1");

    manager.release("session-1", DEVICE_A);

    expect(state.getMocks(DEVICE_A).size).toBe(0);
    expect(state.getSimulation(DEVICE_A)).toBeNull();
    expect(manager.pendingCleanups.map((entry) => entry.deviceId)).toEqual([DEVICE_A]);
    await manager.pendingCleanups[0].cleanup;
    expect(gaps).toEqual([]);
    expect(pusher.pushes).toEqual([{ deviceId: DEVICE_A, ruleIds: [], simulating: false }]);
  });

  test("identity replacement clears host state without a device push or quarantine", () => {
    state.addMock(DEVICE_A, rule("a.com"), "session-1");
    state.startSimulation(DEVICE_A, "timeout", 30, null, "session-1");
    manager.release("session-1", DEVICE_A, false, true);
    expect(state.getMocks(DEVICE_A).size).toBe(0);
    expect(state.getSimulation(DEVICE_A)).toBeNull();
    expect(pusher.pushes).toEqual([]);
    expect(manager.pendingCleanups).toEqual([]);
    expect(gaps).toEqual([]);
  });

  test("a second session's device keeps its rules when the first session is released", async () => {
    state.addMock(DEVICE_A, rule("a.com"), "session-1");
    const keep = state.addMock(DEVICE_B, rule("b.com"), "session-2");
    state.startSimulation(DEVICE_B, "timeout", 30, null, "session-2");

    manager.release("session-1", DEVICE_A);
    await Promise.all(manager.pendingCleanups.map((entry) => entry.cleanup));

    expect(Array.from(state.getMocks(DEVICE_B).keys())).toEqual([keep.mockId]);
    expect(state.getSimulation(DEVICE_B)).not.toBeNull();
    expect(pusher.pushes.map((push) => push.deviceId)).toEqual([DEVICE_A]);
  });

  test("a release for a different session or an unrelated device clears nothing", () => {
    state.addMock(DEVICE_A, rule("a.com"), "session-1");

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

  test("releasing a session clears only its own rules and simulation on a shared device", async () => {
    const own = state.addMock(DEVICE_A, rule("own.com"), "session-1");
    const sessionless = state.addMock(DEVICE_A, rule("sessionless.com"));
    const other = state.addMock(DEVICE_A, rule("other.com"), "session-2");
    state.startSimulation(DEVICE_A, "timeout", 30, null, "session-1");

    manager.release("session-1", DEVICE_A);
    await Promise.all(manager.pendingCleanups.map((entry) => entry.cleanup));

    expect(Array.from(state.getMocks(DEVICE_A).keys())).toEqual([sessionless.mockId, other.mockId]);
    expect(state.getMocks(DEVICE_A).has(own.mockId)).toBe(false);
    expect(state.getSimulation(DEVICE_A)).toBeNull();
    // The device is pushed what remains, not an emptied set.
    expect(pusher.pushes).toEqual([
      { deviceId: DEVICE_A, ruleIds: [sessionless.mockId, other.mockId], simulating: false },
    ]);
  });

  test("a sessionless rule added after a session's rule survives that session's release", async () => {
    state.addMock(DEVICE_A, rule("own.com"), "session-1");
    const sessionless = state.addMock(DEVICE_A, rule("sessionless.com"));
    state.startSimulation(DEVICE_A, "timeout", 30, null);

    manager.release("session-1", DEVICE_A);
    await Promise.all(manager.pendingCleanups.map((entry) => entry.cleanup));

    expect(Array.from(state.getMocks(DEVICE_A).keys())).toEqual([sessionless.mockId]);
    expect(state.getSimulation(DEVICE_A)).not.toBeNull();
  });

  test("a session leaving the device without ending clears the device it left", async () => {
    state.addMock(DEVICE_A, rule("a.com"), "session-1");

    manager.unbind("session-1", DEVICE_A);
    await Promise.all(manager.pendingCleanups.map((entry) => entry.cleanup));

    expect(state.getMocks(DEVICE_A).size).toBe(0);
    expect(pusher.pushes).toEqual([{ deviceId: DEVICE_A, ruleIds: [], simulating: false }]);
  });

  test("the next session on the device starts empty, and a reconnect resyncs nothing", async () => {
    state.addMock(DEVICE_A, rule("a.com"), "session-1");
    manager.release("session-1", DEVICE_A);
    await Promise.all(manager.pendingCleanups.map((entry) => entry.cleanup));

    expect(buildNetworkMockRules(state, DEVICE_A)).toEqual([]);
    // Releasing the already-cleared session again is a no-op.
    manager.release("session-1", DEVICE_A);
    expect(manager.pendingCleanups).toHaveLength(1);
  });

  test("a failing device push is contained and the host store is still cleared", async () => {
    pusher.failWith = new Error("socket closed");
    state.addMock(DEVICE_A, rule("a.com"), "session-1");

    manager.release("session-1", DEVICE_A);

    expect(state.getMocks(DEVICE_A).size).toBe(0);
    await expect(
      manager.pendingCleanups[0].cleanup.then((value) => {
        expect(gaps).toEqual([
          { sessionId: "session-1", reason: expect.stringContaining(`${DEVICE_A}: socket closed`) },
        ]);
        return value;
      }),
    ).resolves.toBeUndefined();
  });
  test("unbound failure marks its session", async () => {
    pusher.failWith = new Error("unbound failed");
    state.addMock(DEVICE_A, rule("a.com"), "session-1");
    manager.unbind("session-1", DEVICE_A);
    await manager.pendingCleanups[0]!.cleanup;
    expect(gaps).toEqual([
      { sessionId: "session-1", reason: expect.stringContaining("unbound failed") },
    ]);
  });
  test("a throwing gap callback cannot reject cleanup", async () => {
    const local = new FakeSessionCleanupManager();
    registerNetworkStateSessionCleanup(local, {
      state: () => state,
      pusher,
      gapMarkerFor: () => () => {
        throw new Error("marker failed");
      },
    });
    pusher.failWith = new Error("push failed");
    state.addMock(DEVICE_A, rule("a.com"), "session-1");
    local.release("session-1", DEVICE_A);
    await expect(local.pendingCleanups[0]!.cleanup).resolves.toBeUndefined();
  });
});

describe("createOwnerlessNetworkStateAcquisitionCleanup (#11130)", () => {
  let state: NetworkState;
  let pusher: FakePusher;
  let acquisitionCleanups: Array<{ deviceId: string; cleanup: Promise<unknown> }>;
  let acquire: (deviceId: string) => void;

  beforeEach(() => {
    state = new NetworkState({
      timer: new FakeTimer(),
      notifier: { notifyResourceUpdated: () => {} },
    });
    pusher = new FakePusher(state);
    acquisitionCleanups = [];
    acquire = createOwnerlessNetworkStateAcquisitionCleanup(
      {
        registerAcquisitionDeviceCleanup: (deviceId, cleanup) => {
          acquisitionCleanups.push({ deviceId, cleanup });
        },
      },
      { state: () => state, pusher },
    );
  });

  test("acquiring a device clears sessionless mocks and simulation and pushes the rest", async () => {
    state.addMock(DEVICE_A, rule("sessionless.com"));
    const owned = state.addMock(DEVICE_A, rule("owned.com"), "session-1");
    state.startSimulation(DEVICE_A, "timeout", 30, null);
    const otherDevice = state.addMock(DEVICE_B, rule("b.com"));

    acquire(DEVICE_A);

    expect(Array.from(state.getMocks(DEVICE_A).keys())).toEqual([owned.mockId]);
    expect(state.getSimulation(DEVICE_A)).toBeNull();
    expect(Array.from(state.getMocks(DEVICE_B).keys())).toEqual([otherDevice.mockId]);
    expect(acquisitionCleanups.map((entry) => entry.deviceId)).toEqual([DEVICE_A]);
    await acquisitionCleanups[0].cleanup;
    expect(pusher.pushes).toEqual([
      { deviceId: DEVICE_A, ruleIds: [owned.mockId], simulating: false },
    ]);
  });

  test("a session-owned simulation survives acquisition", () => {
    state.startSimulation(DEVICE_A, "timeout", 30, null, "session-1");

    acquire(DEVICE_A);

    expect(state.getSimulation(DEVICE_A)).not.toBeNull();
    expect(acquisitionCleanups).toEqual([]);
    expect(pusher.pushes).toEqual([]);
  });

  test("acquiring a device with no sessionless state registers nothing", () => {
    acquire(DEVICE_A);

    expect(acquisitionCleanups).toEqual([]);
  });
});

test("default pusher rejects an Android false delivery result", async () => {
  const client = AndroidCtrlProxyClient.createForTesting(
    { deviceId: "fake-android", platform: "android", name: "fake" },
    new FakeAdbExecutor(),
    {
      timer: new FakeTimer(),
      webSocketFactory: () => {
        throw new Error("no socket in unit test");
      },
    },
  );
  const existing = spyOn(AndroidCtrlProxyClient, "getExistingInstance").mockReturnValue(client);
  const sync = spyOn(client, "syncNetworkStateToDevice").mockReturnValue(false);
  try {
    await expect(defaultNetworkDeviceStatePusher.push("fake-android")).rejects.toThrow(
      "Android network state was not delivered to fake-android",
    );
  } finally {
    existing.mockRestore();
    sync.mockRestore();
  }
});

test("failed ownerless acquisition never marks a session gap", async () => {
  const state = new NetworkState({
    timer: new FakeTimer(),
    notifier: { notifyResourceUpdated: () => {} },
  });
  const pusher = new FakePusher(state);
  pusher.failWith = new Error("ownerless failed");
  const gaps: string[] = [];
  const pending: Promise<unknown>[] = [];
  const acquire = createOwnerlessNetworkStateAcquisitionCleanup(
    {
      registerAcquisitionDeviceCleanup: (_deviceId, cleanup) => {
        pending.push(cleanup);
      },
    },
    {
      state: () => state,
      pusher,
      timer: new FakeTimer(),
      gapMarkerFor: (sessionId) => () => {
        gaps.push(sessionId);
      },
    },
  );
  state.addMock(DEVICE_A, rule("a.com"));
  acquire(DEVICE_A);
  await pending[0];
  expect(gaps).toEqual([]);
});

test("default pusher rejects when neither platform has a live client", async () => {
  const android = spyOn(AndroidCtrlProxyClient, "getExistingInstance").mockReturnValue(null);
  const ios = spyOn(IOSCtrlProxyClient, "getExistingInstance").mockReturnValue(null);
  try {
    await expect(defaultNetworkDeviceStatePusher.push("missing-client")).rejects.toThrow(
      "No live CtrlProxy client to clear network state on missing-client",
    );
  } finally {
    android.mockRestore();
    ios.mockRestore();
  }
});

test.each(["release", "unbind"] as const)(
  "%s captures gap ids before a non-cooperative push settles",
  async (event) => {
    const timer = new FakeTimer();
    const state = new NetworkState({ timer, notifier: { notifyResourceUpdated: () => {} } });
    const manager = new FakeSessionCleanupManager();
    let candidates = ["derived", "owner", "base"];
    const gaps: string[] = [];
    let captured = false;
    registerNetworkStateSessionCleanup(manager, {
      state: () => state,
      timer,
      gapMarkerFor: (sessionId) => {
        expect(sessionId).toBe("derived");
        expect(manager.pendingCleanups).toHaveLength(0);
        captured = true;
        const ids = [...candidates];
        return () => {
          gaps.push(...ids);
        };
      },
      pusher: {
        push: () => {
          expect(captured).toBe(true);
          return new Promise<void>(() => {});
        },
      },
    });
    state.addMock(DEVICE_A, rule("a.com"), "derived");
    manager[event]("derived", DEVICE_A);
    expect(captured).toBe(true);
    candidates = [];
    let settled = false;
    const cleanup = manager.pendingCleanups[0]!.cleanup.then(() => {
      settled = true;
    });
    timer.advanceTime(10_000);
    await drainUntil(() => settled, { description: "non-cooperative cleanup cap" });
    await cleanup;
    expect(gaps).toEqual(["derived", "owner", "base"]);
    expect(timer.getPendingTimeoutCount()).toBe(0);
  },
);
