import { beforeEach, describe, expect, test } from "bun:test";
import {
  SessionDeviceStateRestore,
  type SessionDeviceStateRestoreHost,
} from "../../src/daemon/sessionDeviceStateRestore";
import type { IosAppNetworkRuleRestorer } from "../../src/daemon/iosAppNetworkLease";
import type { Session } from "../../src/daemon/sessionManager";
import type { IosAppNetworkRule } from "../../src/features/networkFilter/IosAppNetworkRuleClient";
import { FakeTimer } from "../fakes/FakeTimer";

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
  published = new Set<Session>();
  admitted = true;
  expiries: Array<{ session: Session; clearIfOwned: () => void }> = [];
  constructor(private readonly timer: FakeTimer) {}
  isPublished(session: Session): boolean {
    return this.published.has(session);
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

describe("SessionDeviceStateRestore network-condition TTL (#11795)", () => {
  let timer: FakeTimer;
  let host: FakeHost;
  let restore: SessionDeviceStateRestore;
  let session: Session;

  beforeEach(() => {
    timer = new FakeTimer();
    host = new FakeHost(timer);
    restore = new SessionDeviceStateRestore({
      timer,
      host,
      iosAppNetworkRuleRestorer: restorer,
      defaultIosAppNetworkRuleRestorer: () => restorer,
      iosLease: { leaseMs: 30_000, renewIntervalMs: 10_000 },
    });
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
    restore = new SessionDeviceStateRestore({
      timer,
      host,
      iosAppNetworkRuleRestorer: restorer,
      defaultIosAppNetworkRuleRestorer: () => restorer,
      iosLease: { leaseMs: 30_000, renewIntervalMs: 10_000 },
    });
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
