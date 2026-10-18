import { describe, expect, test } from "bun:test";
import {
  forwardLeaseActivity,
  heldForwardLeaseDeviceIds,
  releaseForwardLeasesForShutdown,
  releaseIdleForwardLease,
  type ForwardLeaseClient,
  type ForwardLeaseClientRegistry,
} from "../../../../src/features/observe/android/CtrlProxyForwardLeaseRegistry";
import { FakeTimer } from "../../../fakes/FakeTimer";

class FakeLeaseClient implements ForwardLeaseClient {
  held = true;
  acquiredAt: number | undefined;
  released = 0;
  forceReleased = false;
  closed = 0;
  readinessHolds = 0;
  inFlight = 0;
  lastActivityAt: number | undefined;
  closeImpl: () => Promise<void> = async () => {};
  constructor(readonly deviceId: string) {}
  readonly forwardLease = {
    isHeld: () => this.held,
    getAcquiredAt: () => this.acquiredAt,
    release: () => {
      this.released++;
    },
  };
  getRequestActivity() {
    return { inFlightRequests: this.inFlight, lastActivityAt: this.lastActivityAt };
  }
  close() {
    this.closed++;
    return this.closeImpl();
  }
  markForwardLeaseForceReleased() {
    this.forceReleased = true;
  }
}

class FakeRegistry implements ForwardLeaseClientRegistry {
  singletons = new Map<string, FakeLeaseClient>();
  observerList: FakeLeaseClient[] = [];
  singletonEntries(): Array<[string, ForwardLeaseClient]> {
    return [...this.singletons.entries()];
  }
  singleton(deviceId: string) {
    return this.singletons.get(deviceId);
  }
  observers() {
    return this.observerList;
  }
  evictSingleton(deviceId: string) {
    const client = this.singletons.get(deviceId) ?? null;
    this.singletons.delete(deviceId);
    return client;
  }
  clearSingletons() {
    this.singletons.clear();
  }
}

describe("CtrlProxyForwardLeaseRegistry", () => {
  test("lists only singletons that hold the lease", () => {
    const registry = new FakeRegistry();
    const held = new FakeLeaseClient("a");
    const idle = new FakeLeaseClient("b");
    idle.held = false;
    registry.singletons.set("a", held);
    registry.singletons.set("b", idle);
    expect(heldForwardLeaseDeviceIds(registry)).toEqual(["a"]);
  });

  test("activity is null-idle when the device is unknown", () => {
    const timer = new FakeTimer();
    expect(forwardLeaseActivity(new FakeRegistry(), "x", timer)).toEqual({
      inFlightRequests: 0,
      idleForMs: null,
    });
  });

  test("activity sums requests, observers and holds, idle from the later of activity and acquire", () => {
    const timer = new FakeTimer();
    const registry = new FakeRegistry();
    const singleton = new FakeLeaseClient("a");
    singleton.inFlight = 2;
    singleton.readinessHolds = 1;
    singleton.acquiredAt = timer.now();
    registry.singletons.set("a", singleton);
    const observer = new FakeLeaseClient("a");
    observer.inFlight = 1;
    registry.observerList = [observer, new FakeLeaseClient("other")];
    timer.advanceTime(500);
    observer.lastActivityAt = timer.now();
    timer.advanceTime(250);
    expect(forwardLeaseActivity(registry, "a", timer)).toEqual({
      inFlightRequests: 2 + 1 + 1 + 1,
      idleForMs: 250,
    });
  });

  test("releaseIdle evicts before closing and ignores unknown devices", async () => {
    const registry = new FakeRegistry();
    const client = new FakeLeaseClient("a");
    registry.singletons.set("a", client);
    client.closeImpl = async () => {
      expect(registry.singletons.has("a")).toBe(false);
    };
    await releaseIdleForwardLease(registry, "a");
    expect(client.closed).toBe(1);
    await releaseIdleForwardLease(registry, "a");
    expect(client.closed).toBe(1);
  });

  test("shutdown closes singletons and observers, clears the registry, no force release", async () => {
    const timer = new FakeTimer();
    const registry = new FakeRegistry();
    const a = new FakeLeaseClient("a");
    const observer = new FakeLeaseClient("a");
    registry.singletons.set("a", a);
    registry.observerList = [observer];
    await releaseForwardLeasesForShutdown(registry, timer, 1000);
    expect([a.closed, observer.closed]).toEqual([1, 1]);
    expect(registry.singletons.size).toBe(0);
    expect([a.released, a.forceReleased]).toEqual([0, false]);
  });

  test("shutdown with no clients is a no-op", async () => {
    await releaseForwardLeasesForShutdown(new FakeRegistry(), new FakeTimer(), 1000);
  });

  test("shutdown force-releases leases when a close outlives the deadline", async () => {
    const timer = new FakeTimer();
    const registry = new FakeRegistry();
    const stuck = new FakeLeaseClient("a");
    stuck.closeImpl = () => new Promise<void>(() => {});
    registry.singletons.set("a", stuck);
    const done = releaseForwardLeasesForShutdown(registry, timer, 1000);
    await Promise.resolve();
    timer.advanceTime(1000);
    await done;
    expect([stuck.released, stuck.forceReleased]).toEqual([1, true]);
  });

  test("a failing close is swallowed and does not force release", async () => {
    const registry = new FakeRegistry();
    const bad = new FakeLeaseClient("a");
    bad.closeImpl = async () => {
      throw new Error("adb gone");
    };
    registry.singletons.set("a", bad);
    await releaseForwardLeasesForShutdown(registry, new FakeTimer(), 1000);
    expect(bad.released).toBe(0);
  });
});
