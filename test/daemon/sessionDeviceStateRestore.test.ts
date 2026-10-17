import { beforeEach, describe, expect, spyOn, test } from "bun:test";
import {
  SessionDeviceStateRestore,
  type SessionDeviceStateRestoreHost,
  type SessionDeviceStateRestoreOptions,
} from "../../src/daemon/sessionDeviceStateRestore";
import type { IosAppNetworkRuleRestorer } from "../../src/daemon/iosAppNetworkLease";
import { SessionManager, type Session } from "../../src/daemon/sessionManager";
import { DeviceClockRestoreRegistry } from "../../src/features/utility/DeviceClock";
import type { IosAppNetworkRule } from "../../src/features/networkFilter/IosAppNetworkRuleClient";
import type { BackoffPolicy } from "../../src/utils/Backoff";
import { logger } from "../../src/utils/logger";
import { FakeDbWriteBarrier } from "../fakes/FakeDbWriteBarrier";
import { FakeDeviceSessionPersistence } from "../fakes/FakeDeviceSessionPersistence";
import { FakeTimer } from "../fakes/FakeTimer";

const flush = async () => {
  for (let i = 0; i < 30; i++) {
    await Promise.resolve();
  }
};

const makeSession = (sessionId: string): Session => ({
  sessionId,
  assignedDevice: "emulator-5554",
  platform: "android",
  createdAt: 0,
  lastUsedAt: 0,
  activityGeneration: 0,
  expiresAt: 0,
  cacheData: {},
  lastHeartbeat: 0,
  sessionTimeoutMs: 0,
  heartbeatTimeoutMs: 0,
  heartbeatTimeoutSource: "default",
  hasReceivedHeartbeat: false,
  ownership: "owned",
  livenessPolicy: "heartbeat",
});

class FakeHost implements SessionDeviceStateRestoreHost {
  /** Published sessions; `publishAll` treats every session as published. */
  published = new Set<Session>();
  publishAll = false;
  admitted = true;
  expiries: Array<{ session: Session; clearIfOwned: () => void }> = [];
  tracked: string[] = [];
  constructor(readonly timer: FakeTimer) {}
  dispatchDeviceRestore(
    _deviceId: string,
    restore: (
      signal: AbortSignal,
      identitySignal: AbortSignal,
      acknowledge: () => void,
    ) => Promise<void>,
  ): Promise<void> {
    const controller = new AbortController();
    return restore(controller.signal, controller.signal, () => {});
  }
  restoreGeneration(): number {
    return 0;
  }
  hasIdentityReplacementFence(): boolean {
    return false;
  }
  trackSessionSetup(_session: Session, createSetup: () => Promise<void>): Promise<void> {
    return createSetup();
  }
  isPublished(session: Session): boolean {
    return this.publishAll || this.published.has(session);
  }
  healthEvents: string[] = [];
  healthIncarnation(): number {
    return 1;
  }
  restoreIncarnationIsCurrent(): boolean {
    return true;
  }
  clearRestoreHealth(target: { deviceId: string }, reason: string): void {
    this.healthEvents.push(`clear:${target.deviceId}:${reason}`);
  }
  markHealth(deviceId: string, _incarnation: number, reason: string): void {
    this.healthEvents.push(`mark:${deviceId}:${reason}`);
  }
  clearHealthMarker(deviceId: string, _incarnation: number, reason: string): void {
    this.healthEvents.push(`clear:${deviceId}:${reason}`);
  }
  trackPendingDeviceCleanup(deviceId: string): void {
    this.tracked.push(deviceId);
  }
  isAdmittedForAutomation(): boolean {
    return this.admitted;
  }
  sessionNow(): number {
    return this.timer.now();
  }
  restoreNetworkConditionOnExpiry(session: Session, clearIfOwned: () => void): void {
    this.expiries.push({ session, clearIfOwned });
  }
}

const restorer: IosAppNetworkRuleRestorer = {
  reset: async () => {},
  renew: async () => "renewed",
};

const backoff: BackoffPolicy = { delayForAttempt: () => 5 };

function makeRestore(
  host: FakeHost,
  screenReader: SessionDeviceStateRestoreOptions["screenReader"] = () => ({
    restore: async () => {},
  }),
  rotation: SessionDeviceStateRestoreOptions["rotation"] = () => ({ restore: async () => {} }),
  clock: SessionDeviceStateRestoreOptions["clock"] = () => ({ restore: async () => {} }),
): SessionDeviceStateRestore {
  return new SessionDeviceStateRestore(host, {
    screenReader,
    screenReaderBackoff: backoff,
    rotation,
    rotationBackoff: backoff,
    clock,
    clockRegistry: new DeviceClockRestoreRegistry(),
    iosAppNetworkRuleRestorer: restorer,
    defaultIosAppNetworkRuleRestorer: () => restorer,
    iosLease: { leaseMs: 30_000, renewIntervalMs: 10_000 },
  });
}

async function create(restoreResult: (call: number) => Promise<void>) {
  const timer = new FakeTimer();
  const calls: Array<{ deviceId: string; previousEnabled: boolean }> = [];
  const host = new FakeHost(timer);
  host.publishAll = true;
  const restore = makeRestore(host, (device) => ({
    restore: (state) => {
      calls.push({ deviceId: device.deviceId, previousEnabled: state.previousEnabled });
      return restoreResult(calls.length);
    },
  }));
  // A real Session (from a manager used only as a factory) keeps the fixture typed.
  const factory = new SessionManager(timer, new FakeDeviceSessionPersistence(), {
    barrier: () => new FakeDbWriteBarrier(),
  });
  factory.stopCleanupTimer();
  const session = await factory.createSession("s1", "emulator-5554", "android");
  factory.setScreenReader(session, { platform: "android", previousEnabled: false });
  return { timer, restore, calls, tracked: host.tracked, session };
}

test("a successful screen-reader restore clears the slot and leaves no pending work", async () => {
  const h = await create(async () => {});
  const { pending } = await h.restore.getPendingScreenReaderRestoration(h.session, null);
  expect(pending).toBeNull();
  expect(h.calls).toEqual([{ deviceId: "emulator-5554", previousEnabled: false }]);
  expect(h.session.cacheData.screenReader).toBeUndefined();
  expect(h.restore.screenReaderRestores.targets.size).toBe(0);
});

test("a concurrent ask for the same baseline joins the one restore", async () => {
  const gate = Promise.withResolvers<void>();
  const h = await create(() => gate.promise);
  const first = h.restore.getPendingScreenReaderRestoration(h.session, null);
  const second = h.restore.getPendingScreenReaderRestoration(h.session, null);
  await flush();
  expect(h.calls).toHaveLength(1);
  gate.resolve();
  expect((await first).pending).toBeNull();
  expect((await second).pending).toBeNull();
});

test("a failing screen-reader restore retries twice, then abandons and remembers the state", async () => {
  const warn = spyOn(logger, "warn").mockImplementation(() => {});
  try {
    const h = await create(() => Promise.reject(new Error("toggle failed")));
    const { pending } = await h.restore.getPendingScreenReaderRestoration(h.session, null);
    expect(pending).not.toBeNull();
    for (let i = 0; i < 2; i++) {
      await flush();
      h.timer.advanceTime(5);
    }
    await pending;
    expect(h.calls).toHaveLength(3);
    expect(h.restore.abandonedScreenReaders.get("emulator-5554")).toEqual({
      platform: "android",
      previousEnabled: false,
    });
    expect(h.session.cacheData.screenReader).toBeUndefined();
    expect(h.restore.screenReaderRestores.targets.size).toBe(0);
  } finally {
    warn.mockRestore();
  }
});

test("retiring a device forgets its abandoned screen-reader state and bumps the generation", async () => {
  const h = await create(async () => {});
  h.restore.abandonedScreenReaders.set("emulator-5554", {
    platform: "android",
    previousEnabled: true,
  });
  // SessionManager.retireRestorations retires the queue; its onRetire hook forgets the state (#11794).
  h.restore.screenReaderRestores.retire("emulator-5554");
  expect(h.restore.abandonedScreenReaders.has("emulator-5554")).toBe(false);
  expect(h.restore.screenReaderRestores.generation("emulator-5554")).toBe(1);
});

describe("SessionDeviceStateRestore network-condition TTL (#11795)", () => {
  let timer: FakeTimer;
  let host: FakeHost;
  let restore: SessionDeviceStateRestore;
  let session: Session;

  beforeEach(() => {
    timer = new FakeTimer();
    host = new FakeHost(timer);
    restore = makeRestore(host);
    session = makeSession("s1");
    host.published.add(session);
  });

  test("expiry fires the host restore once and forgets the timer", () => {
    restore.scheduleNetworkConditionExpiry(session, 5);
    expect(restore.peekNetworkConditionExpiry("s1")).toBeDefined();
    timer.advanceTime(4999);
    expect(host.expiries).toHaveLength(0);
    timer.advanceTime(1);
    expect(host.expiries).toHaveLength(1);
    expect(restore.peekNetworkConditionExpiry("s1")).toBeUndefined();
  });

  test("non-positive TTL arms nothing and cancels a prior timer", () => {
    restore.scheduleNetworkConditionExpiry(session, 5);
    restore.scheduleNetworkConditionExpiry(session, 0);
    expect(restore.peekNetworkConditionExpiry("s1")).toBeUndefined();
    timer.advanceTime(10_000);
    expect(host.expiries).toHaveLength(0);
  });

  test("cancel prevents the fire", () => {
    restore.scheduleNetworkConditionExpiry(session, 5);
    restore.cancelNetworkConditionExpiry("s1");
    timer.advanceTime(10_000);
    expect(host.expiries).toHaveLength(0);
  });

  test("a replaced session is never armed or restored", () => {
    restore.scheduleNetworkConditionExpiry(makeSession("s1"), 5);
    expect(restore.peekNetworkConditionExpiry("s1")).toBeUndefined();
    restore.scheduleNetworkConditionExpiry(session, 5);
    host.published.delete(session);
    timer.advanceTime(5000);
    expect(host.expiries).toHaveLength(0);
  });

  test("peek then rearm keeps the original deadline", () => {
    restore.scheduleNetworkConditionExpiry(
      session,
      5,
      restore.bumpNetworkConditionGeneration("s1"),
    );
    const snapshot = restore.peekNetworkConditionExpiry("s1")!;
    restore.cancelNetworkConditionExpiry("s1");
    timer.advanceTime(2000);
    restore.rearmNetworkConditionExpiry(session, snapshot);
    timer.advanceTime(2999);
    expect(host.expiries).toHaveLength(0);
    timer.advanceTime(1);
    expect(host.expiries).toHaveLength(1);
  });

  test("rearm is skipped when superseded or the session is not admitted", () => {
    restore.scheduleNetworkConditionExpiry(
      session,
      5,
      restore.bumpNetworkConditionGeneration("s1"),
    );
    const snapshot = restore.peekNetworkConditionExpiry("s1")!;
    restore.cancelNetworkConditionExpiry("s1");
    restore.bumpNetworkConditionGeneration("s1");
    restore.rearmNetworkConditionExpiry(session, snapshot);
    expect(restore.peekNetworkConditionExpiry("s1")).toBeUndefined();

    const fresh = restore.bumpNetworkConditionGeneration("s1");
    host.admitted = false;
    restore.rearmNetworkConditionExpiry(session, { deadlineMs: 1000, generation: fresh });
    expect(restore.peekNetworkConditionExpiry("s1")).toBeUndefined();
  });

  test("clearIfOwned drops the slot only for the matching generation", () => {
    session.cacheData.networkCondition = { initialProfile: "none" };
    restore.scheduleNetworkConditionExpiry(
      session,
      1,
      restore.bumpNetworkConditionGeneration("s1"),
    );
    timer.advanceTime(1000);
    restore.bumpNetworkConditionGeneration("s1");
    host.expiries[0]!.clearIfOwned();
    expect(session.cacheData.networkCondition).toBeDefined();

    restore.scheduleNetworkConditionExpiry(
      session,
      1,
      restore.bumpNetworkConditionGeneration("s1"),
    );
    timer.advanceTime(1000);
    host.expiries[1]!.clearIfOwned();
    expect(session.cacheData.networkCondition).toBeUndefined();
  });

  test("mutation sections serialize per session and forgetSession resets generation", async () => {
    const order: string[] = [];
    const a = restore.runNetworkConditionMutationExclusive("s1", async () => {
      await Promise.resolve();
      order.push("a");
    });
    const b = restore.runNetworkConditionMutationExclusive("s1", async () => {
      order.push("b");
    });
    await Promise.all([a, b]);
    expect(order).toEqual(["a", "b"]);
    expect(restore.bumpNetworkConditionGeneration("s1")).toBe(1);
    restore.forgetSession("s1");
    expect(restore.bumpNetworkConditionGeneration("s1")).toBe(1);
  });

  test("stopAll cancels armed TTLs", () => {
    restore.scheduleNetworkConditionExpiry(session, 5);
    restore.stopAll();
    timer.advanceTime(10_000);
    expect(host.expiries).toHaveLength(0);
  });
});

describe("SessionDeviceStateRestore iOS app rule lease (#10264)", () => {
  const target = { udid: "UDID-1", bundleId: "com.example.app" };
  let timer: FakeTimer;
  let host: FakeHost;
  let restore: SessionDeviceStateRestore;
  let session: Session;

  beforeEach(() => {
    timer = new FakeTimer();
    host = new FakeHost(timer);
    restore = makeRestore(host);
    session = makeSession("s1");
    host.published.add(session);
  });

  const begin = (): IosAppNetworkRule => restore.beginIosAppNetworkRule(session, target).rule;

  test("begin publishes the slot, revisions increase, a different app is refused", () => {
    const first = begin();
    expect(first.revision).toBe(1);
    expect(first.owner).toBe("s1");
    expect(begin().revision).toBe(2);
    expect(() =>
      restore.beginIosAppNetworkRule(session, { udid: "UDID-1", bundleId: "other" }),
    ).toThrow(/already holds an offline rule/);
  });

  test("owner generations never repeat", () => {
    const first = begin().ownerGeneration;
    const transient = restore.prepareIosAppNetworkReset(makeSession("s2"), target).rule;
    expect(transient.ownerGeneration).toBeGreaterThan(first);
    expect(transient.revision).toBe(1);
  });

  test("confirm starts the lease, reset stops it and drops the slot", () => {
    const rule = begin();
    restore.confirmIosAppNetworkRule(session, rule);
    expect(restore.activeIosAppNetworkLease("s1")).toEqual(rule);
    const reset = restore.prepareIosAppNetworkReset(session, target).rule;
    restore.finishIosAppNetworkReset(session, reset);
    expect(restore.activeIosAppNetworkLease("s1")).toBeUndefined();
    expect(session.cacheData.networkCondition).toBeUndefined();
  });

  test("confirm and finish are no-ops for an unpublished session or stale generation", () => {
    const rule = begin();
    restore.confirmIosAppNetworkRule(session, {
      ...rule,
      ownerGeneration: rule.ownerGeneration + 1,
    });
    expect(restore.activeIosAppNetworkLease("s1")).toBeUndefined();
    host.published.delete(session);
    restore.confirmIosAppNetworkRule(session, rule);
    expect(restore.activeIosAppNetworkLease("s1")).toBeUndefined();
    restore.finishIosAppNetworkReset(session, rule);
    expect(session.cacheData.networkCondition).toBeDefined();
  });

  test("stopAll ends every lease; clearing the TTL slot stops the lease", () => {
    restore.confirmIosAppNetworkRule(session, begin());
    restore.stopAll();
    expect(restore.activeIosAppNetworkLease("s1")).toBeUndefined();

    restore.confirmIosAppNetworkRule(session, begin());
    restore.scheduleNetworkConditionExpiry(
      session,
      1,
      restore.bumpNetworkConditionGeneration("s1"),
    );
    timer.advanceTime(1000);
    host.expiries[0]!.clearIfOwned();
    expect(restore.activeIosAppNetworkLease("s1")).toBeUndefined();
  });
});

describe("rotation family", () => {
  async function createRotation(rotationResult: (call: number) => Promise<void>) {
    const timer = new FakeTimer();
    const host = new FakeHost(timer);
    host.publishAll = true;
    let calls = 0;
    const restore = makeRestore(host, undefined, () => ({
      restore: () => {
        calls++;
        return rotationResult(calls);
      },
    }));
    const factory = new SessionManager(timer, new FakeDeviceSessionPersistence(), {
      barrier: () => new FakeDbWriteBarrier(),
    });
    factory.stopCleanupTimer();
    const session = await factory.createSession("s2", "emulator-5556", "android");
    factory.setRotation(session, { accelerometerRotation: 1, userRotation: 0 });
    return { restore, session, calls: () => calls };
  }

  test("a successful rotation restore clears the slot", async () => {
    const h = await createRotation(async () => {});
    const { pending } = await h.restore.getPendingRotationRestoration(h.session, null);
    expect(pending).toBeNull();
    expect(h.calls()).toBe(1);
    expect(h.session.cacheData.rotation).toBeUndefined();
  });

  test("a window-manager-managed failure abandons without retrying and keeps the baseline until the queue retires", async () => {
    const warn = spyOn(logger, "warn").mockImplementation(() => {});
    try {
      const managed = Object.assign(new Error("managed"), { details: { retryable: false } });
      const h = await createRotation(() => Promise.reject(managed));
      const baseline = h.session.cacheData.rotation;
      const { pending } = await h.restore.getPendingRotationRestoration(h.session, null);
      await pending;
      expect(h.calls()).toBe(1);
      expect(h.restore.abandonedRotations.get("emulator-5556")).toBe(baseline);
      h.restore.rotationRestores.retire("emulator-5556");
      expect(h.restore.abandonedRotations.has("emulator-5556")).toBe(false);
    } finally {
      warn.mockRestore();
    }
  });
});

describe("clock family", () => {
  async function createClock(clockResult: (call: number) => Promise<void>) {
    const timer = new FakeTimer();
    const host = new FakeHost(timer);
    host.publishAll = true;
    let calls = 0;
    const restore = makeRestore(host, undefined, undefined, () => ({
      restore: () => {
        calls++;
        return clockResult(calls);
      },
    }));
    const factory = new SessionManager(timer, new FakeDeviceSessionPersistence(), {
      barrier: () => new FakeDbWriteBarrier(),
    });
    factory.stopCleanupTimer();
    const session = await factory.createSession("s3", "emulator-5558", "android");
    factory.setClock(session, {
      initialAutomaticTime: 1,
      clockChangedByUs: true,
      rootedByUs: false,
    });
    return { timer, host, restore, session, calls: () => calls };
  }

  test("a successful clock restore runs through the injected registry and clears the slot", async () => {
    const h = await createClock(async () => {});
    const { pending } = await h.restore.getPendingClockRestoration(h.session, null);
    expect(pending).toBeNull();
    expect(h.calls()).toBe(1);
    expect(h.session.cacheData.clock).toBeUndefined();
    expect(h.host.healthEvents).toContain("clear:emulator-5558:clock");
  });

  // The clock retries without a cap (unlike rotation and screen reader) and marks the device
  // unhealthy until it restores or the queue retires (#11794, #11795).
  test("a failing clock restore marks health and keeps retrying until the queue retires", async () => {
    const warn = spyOn(logger, "warn").mockImplementation(() => {});
    try {
      const h = await createClock(() => Promise.reject(new Error("adb offline")));
      const { pending } = await h.restore.getPendingClockRestoration(h.session, null);
      expect(pending).not.toBeNull();
      expect(h.host.healthEvents).toContain("mark:emulator-5558:clock");
      for (let i = 0; i < 6; i++) {
        await flush();
        h.timer.advanceTime(250);
      }
      expect(h.calls()).toBeGreaterThan(4);
      h.restore.clockRestores.retire("emulator-5558");
      await pending;
      const settled = h.calls();
      await flush();
      h.timer.advanceTime(10_000);
      await flush();
      expect(h.calls()).toBe(settled);
      expect(h.host.healthEvents).toContain("clear:emulator-5558:clock");
    } finally {
      warn.mockRestore();
    }
  });
});
