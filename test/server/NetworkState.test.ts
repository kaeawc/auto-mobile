import { describe, it, expect, beforeEach } from "bun:test";
import {
  NetworkState,
  type NetworkNotification,
  type ResourceNotifier,
} from "../../src/server/NetworkState";
import { FakeTimer } from "../fakes/FakeTimer";

const DEVICE = "emulator-5554";
const OTHER_DEVICE = "emulator-5556";

class FakeNotifier implements ResourceNotifier {
  notifications: string[] = [];

  notifyResourceUpdated(uri: string): void {
    this.notifications.push(uri);
  }
}

function makeNotification(overrides: Partial<NetworkNotification> = {}): NetworkNotification {
  return {
    id: 1,
    timestamp: 1000,
    method: "GET",
    url: "https://api.example.com/data",
    host: "api.example.com",
    path: "/data",
    statusCode: 200,
    durationMs: 100,
    contentType: "application/json",
    error: null,
    ...overrides,
  };
}

describe("NetworkState", () => {
  let state: NetworkState;
  let timer: FakeTimer;
  let notifier: FakeNotifier;

  beforeEach(() => {
    timer = new FakeTimer();
    notifier = new FakeNotifier();
    state = new NetworkState({ timer, notifier });
  });

  describe("capture", () => {
    it("defaults to false", () => {
      expect(state.capturing).toBe(false);
    });

    it("toggles capture", () => {
      state.setCapture(true);
      expect(state.capturing).toBe(true);
      state.setCapture(false);
      expect(state.capturing).toBe(false);
    });
  });

  describe("simulation", () => {
    it("starts simulation with expiration", () => {
      state.startSimulation(DEVICE, "http500", 30, null);
      const sim = state.getSimulation(DEVICE);
      expect(sim).not.toBeNull();
      expect(sim!.errorType).toBe("http500");
      expect(sim!.limit).toBeNull();
      expect(sim!.expiresAt).toBe(30_000);
    });

    it("rounds fractional duration expirations up to integer milliseconds", () => {
      state.startSimulation(DEVICE, "http500", 1.2345, null);

      expect(state.getSimulation(DEVICE)?.expiresAt).toBe(1_235);
    });

    it("starts simulation with an absolute expiration", () => {
      timer.advanceTime(5_000);
      state.startSimulationUntil(DEVICE, "http500", 30_000, null);
      const sim = state.getSimulation(DEVICE);
      expect(sim).not.toBeNull();
      expect(sim!.expiresAt).toBe(30_000);

      timer.advanceTime(24_999);
      expect(state.getSimulation(DEVICE)).not.toBeNull();
      timer.advanceTime(1);
      expect(state.getSimulation(DEVICE)).toBeNull();
    });

    it("does not keep already-expired absolute simulations active", () => {
      timer.advanceTime(30_000);
      state.startSimulationUntil(DEVICE, "http500", 30_000, null);

      expect(state.getSimulation(DEVICE)).toBeNull();
    });

    it("expires simulation after duration", () => {
      state.startSimulation(DEVICE, "timeout", 10, null);
      expect(state.getSimulation(DEVICE)).not.toBeNull();

      timer.advanceTime(10_000);
      expect(state.getSimulation(DEVICE)).toBeNull();
    });

    it("cancels simulation", () => {
      state.startSimulation(DEVICE, "http500", 30, null);
      state.cancelSimulation(DEVICE);
      expect(state.getSimulation(DEVICE)).toBeNull();
    });

    it("tracks limit", () => {
      state.startSimulation(DEVICE, "dnsFailure", 60, 5);
      const sim = state.getSimulation(DEVICE);
      expect(sim!.limit).toBe(5);
      expect(sim!.remaining).toBe(5);
    });

    it("replaces previous simulation", () => {
      state.startSimulation(DEVICE, "http500", 30, null);
      state.startSimulation(DEVICE, "timeout", 60, 3);
      const sim = state.getSimulation(DEVICE);
      expect(sim!.errorType).toBe("timeout");
      expect(sim!.limit).toBe(3);
    });
  });

  describe("notification config", () => {
    it("has sensible defaults", () => {
      expect(state.notifFilter).toBe("all");
      expect(state.notifDebounceMs).toBe(100);
      expect(state.slowThresholdMs).toBe(2000);
    });

    it("updates filter", () => {
      state.setNotifFilter("errors");
      expect(state.notifFilter).toBe("errors");
    });

    it("updates debounce", () => {
      state.setNotifDebounceMs(500);
      expect(state.notifDebounceMs).toBe(500);
    });

    it("updates slow threshold", () => {
      state.setSlowThresholdMs(5000);
      expect(state.slowThresholdMs).toBe(5000);
    });
  });

  describe("mocks", () => {
    it("adds mock with generated id", () => {
      const mock = state.addMock(DEVICE, {
        host: "api.example.com",
        path: "/data",
        method: "GET",
        limit: null,
        statusCode: 200,
        responseHeaders: {},
        responseBody: "{}",
        contentType: "application/json",
      });

      expect(mock.mockId).toMatch(/^mock-\d+$/);
      expect(state.getMocks(DEVICE).size).toBe(1);
    });

    it("removes specific mock", () => {
      const mock = state.addMock(DEVICE, {
        host: "a.com",
        path: "/x",
        method: "*",
        limit: null,
        statusCode: 200,
        responseHeaders: {},
        responseBody: "",
        contentType: "application/json",
      });

      expect(state.removeMock(DEVICE, mock.mockId)).toBe(true);
      expect(state.getMocks(DEVICE).size).toBe(0);
    });

    it("returns false for unknown mock id", () => {
      expect(state.removeMock(DEVICE, "mock-999")).toBe(false);
    });

    it("clears all mocks", () => {
      state.addMock(DEVICE, {
        host: "a.com",
        path: "/1",
        method: "*",
        limit: null,
        statusCode: 200,
        responseHeaders: {},
        responseBody: "",
        contentType: "application/json",
      });
      state.addMock(DEVICE, {
        host: "b.com",
        path: "/2",
        method: "POST",
        limit: 5,
        statusCode: 201,
        responseHeaders: {},
        responseBody: "",
        contentType: "application/json",
      });

      const cleared = state.clearAllMocks(DEVICE);
      expect(cleared).toBe(2);
      expect(state.getMocks(DEVICE).size).toBe(0);
    });

    it("builds mock summary", () => {
      state.addMock(DEVICE, {
        host: "a.com",
        path: "/x",
        method: "GET",
        limit: null,
        statusCode: 200,
        responseHeaders: {},
        responseBody: "",
        contentType: "application/json",
      });
      state.addMock(DEVICE, {
        host: "b.com",
        path: "/y",
        method: "POST",
        limit: 3,
        statusCode: 201,
        responseHeaders: {},
        responseBody: "",
        contentType: "application/json",
      });

      const summary = state.getMockSummary(DEVICE);
      expect(summary["GET a.com/x"]).toBe(-1);
      expect(summary["POST b.com/y"]).toBe(3);
    });
  });

  describe("per-device scope (#10061)", () => {
    const rule = (host: string) => ({
      host,
      path: "/x",
      method: "*",
      limit: null,
      statusCode: 200,
      responseHeaders: {},
      responseBody: "",
      contentType: "application/json",
    });

    it("keeps rules and simulation separate per device", () => {
      const a = state.addMock(DEVICE, rule("a.com"));
      const b = state.addMock(OTHER_DEVICE, rule("b.com"));
      state.startSimulation(DEVICE, "timeout", 30, null);

      expect(Array.from(state.getMocks(DEVICE).keys())).toEqual([a.mockId]);
      expect(Array.from(state.getMocks(OTHER_DEVICE).keys())).toEqual([b.mockId]);
      expect(state.getSimulation(OTHER_DEVICE)).toBeNull();
      expect(state.getAllMocks().map((m) => [m.deviceId, m.mockId])).toEqual([
        [DEVICE, a.mockId],
        [OTHER_DEVICE, b.mockId],
      ]);
    });

    it("clearing one device leaves the other device's rules and simulation", () => {
      state.addMock(DEVICE, rule("a.com"));
      const b = state.addMock(OTHER_DEVICE, rule("b.com"));
      state.startSimulation(OTHER_DEVICE, "timeout", 30, null);

      expect(state.clearAllMocks(DEVICE)).toBe(1);
      state.cancelSimulation(DEVICE);

      expect(Array.from(state.getMocks(OTHER_DEVICE).keys())).toEqual([b.mockId]);
      expect(state.getSimulation(OTHER_DEVICE)).not.toBeNull();
      expect(state.removeMock(DEVICE, b.mockId)).toBe(false);
    });

    it("never reuses a mockId after the rule is removed", () => {
      const first = state.addMock(DEVICE, rule("a.com"));
      state.removeMock(DEVICE, first.mockId);
      expect(state.addMock(DEVICE, rule("a.com")).mockId).not.toBe(first.mockId);
    });

    it("reports per-device simulation on a device-less snapshot", () => {
      state.startSimulation(OTHER_DEVICE, "timeout", 30, 2);

      expect(state.getSnapshot().simulatingErrors).toBeUndefined();
      expect(state.getSnapshot().simulatingErrorsByDevice).toEqual({
        [OTHER_DEVICE]: { errorType: "timeout", remainingSeconds: 30, limit: 2 },
      });
      expect(state.getSnapshot(DEVICE).simulatingErrors).toBeUndefined();
    });

    it("expires one device's simulation without touching the other", () => {
      state.startSimulation(DEVICE, "timeout", 10, null);
      state.startSimulation(OTHER_DEVICE, "timeout", 60, null);

      timer.advanceTime(10_000);

      expect(state.getSimulation(DEVICE)).toBeNull();
      expect(state.getSimulation(OTHER_DEVICE)).not.toBeNull();
    });

    it("clearDeviceOwnedBySession removes only state its session installed", () => {
      state.addMock(DEVICE, rule("a.com"), "session-1");
      state.startSimulation(DEVICE, "timeout", 30, null, "session-1");
      state.addMock(OTHER_DEVICE, rule("b.com"), "session-2");

      expect(state.clearDeviceOwnedBySession(DEVICE, "session-2")).toBe(false);
      expect(state.getMocks(DEVICE).size).toBe(1);

      expect(state.clearDeviceOwnedBySession(DEVICE, "session-1")).toBe(true);
      expect(state.getMocks(DEVICE).size).toBe(0);
      expect(state.getSimulation(DEVICE)).toBeNull();
      expect(state.getMocks(OTHER_DEVICE).size).toBe(1);
    });

    it("leaves sessionless state in place when a session is released", () => {
      state.addMock(DEVICE, rule("a.com"));
      state.startSimulation(DEVICE, "timeout", 30, null);

      expect(state.clearDeviceOwnedBySession(DEVICE, "session-1")).toBe(false);
      expect(state.getMocks(DEVICE).size).toBe(1);
      expect(state.getSimulation(DEVICE)).not.toBeNull();
    });

    it("keeps sessionless and other-session state on a device whose session is released", () => {
      const own = state.addMock(DEVICE, rule("own.com"), "session-1");
      const sessionless = state.addMock(DEVICE, rule("sessionless.com"));
      const other = state.addMock(DEVICE, rule("other.com"), "session-2");
      state.startSimulation(DEVICE, "timeout", 30, null);

      expect(state.clearDeviceOwnedBySession(DEVICE, "session-1")).toBe(true);

      expect(Array.from(state.getMocks(DEVICE).keys())).toEqual([sessionless.mockId, other.mockId]);
      expect(state.getMocks(DEVICE).has(own.mockId)).toBe(false);
      expect(state.getSimulation(DEVICE)).not.toBeNull();
    });

    it("the last writer owns a replaced simulation", () => {
      state.startSimulation(DEVICE, "timeout", 30, null, "session-1");
      state.startSimulation(DEVICE, "http500", 30, null);
      expect(state.clearDeviceOwnedBySession(DEVICE, "session-1")).toBe(false);
      expect(state.getSimulation(DEVICE)?.errorType).toBe("http500");

      state.startSimulation(DEVICE, "timeout", 30, null, "session-2");
      expect(state.clearDeviceOwnedBySession(DEVICE, "session-2")).toBe(true);
      expect(state.getSimulation(DEVICE)).toBeNull();
    });

    it("a rule removed or cleared explicitly is no longer owned", () => {
      const removed = state.addMock(DEVICE, rule("a.com"), "session-1");
      state.removeMock(DEVICE, removed.mockId);
      state.addMock(DEVICE, rule("b.com"), "session-1");
      state.clearAllMocks(DEVICE);

      expect(state.clearDeviceOwnedBySession(DEVICE, "session-1")).toBe(false);
    });

    it("retireDevice drops a device's state regardless of owner and cancels its timer", () => {
      state.addMock(DEVICE, rule("a.com"), "session-1");
      state.startSimulation(DEVICE, "timeout", 30, null, "session-1");

      state.retireDevice(DEVICE);

      expect(state.getMocks(DEVICE).size).toBe(0);
      expect(state.getSimulation(DEVICE)).toBeNull();
      expect(state.getAllMocks()).toEqual([]);
    });

    it("summarizes the configured limit, not a live remaining count (#10060)", () => {
      state.addMock(DEVICE, { ...rule("a.com"), limit: 1 });
      expect(state.getMockSummary(DEVICE)).toEqual({ "* a.com/x": 1 });
      expect(state.getMockSummary(OTHER_DEVICE)).toEqual({});
    });
  });

  describe("snapshot", () => {
    it("returns current state", () => {
      state.setCapture(true);
      state.setNotifFilter("errors");
      state.setNotifDebounceMs(200);
      state.setSlowThresholdMs(3000);

      const snap = state.getSnapshot();
      expect(snap.capturing).toBe(true);
      expect(snap.notifFilter).toBe("errors");
      expect(snap.notifDebounceMs).toBe(200);
      expect(snap.slowThresholdMs).toBe(3000);
      expect(snap.simulatingErrors).toBeUndefined();
    });

    it("includes simulation when active", () => {
      state.startSimulation(DEVICE, "http500", 60, 10);
      const snap = state.getSnapshot(DEVICE);
      expect(snap.simulatingErrors).toBeDefined();
      expect(snap.simulatingErrors!.errorType).toBe("http500");
      expect(snap.simulatingErrors!.limit).toBe(10);
      expect(snap.simulatingErrors!.remainingSeconds).toBe(60);
    });
  });

  describe("notification dispatch", () => {
    it.each([
      { statusCode: 0, error: "The request timed out" },
      { statusCode: 0, error: null },
      { statusCode: 200, error: "cancelled" },
    ])(
      "admits transport failures through the errors filter and notifies the errors resource: %j",
      (failure) => {
        state.setCapture(true);
        state.setNotifFilter("errors");
        state.onNetworkEvent(makeNotification(failure));
        expect(state.pendingNotificationCount).toBe(1);
        timer.advanceTime(200);
        expect(notifier.notifications).toContain("automobile:network/traffic/errors");
        expect(state.pendingNotificationCount).toBe(0);
      },
    );

    it("keeps a mocked 200 out of the errors filter but admits a mocked 503", () => {
      state.setCapture(true);
      state.setNotifFilter("errors");
      state.onNetworkEvent(makeNotification({ statusCode: 200, error: "mocked:mock-1" }));
      expect(state.pendingNotificationCount).toBe(0);
      state.onNetworkEvent(makeNotification({ statusCode: 503, error: "mocked:mock-1" }));
      expect(state.pendingNotificationCount).toBe(1);
    });

    it("filters mocked and simulated events by outcome while per-device rules and simulation are active", () => {
      state.setCapture(true);
      state.setNotifFilter("errors");
      state.addMock(DEVICE, {
        host: "api.example.com",
        path: "/data",
        method: "*",
        limit: null,
        statusCode: 200,
        responseHeaders: {},
        responseBody: "",
        contentType: "application/json",
      });
      state.startSimulation(OTHER_DEVICE, "timeout", 30, null);

      // A response served by DEVICE's mock rule is provenance, not a failure.
      state.onNetworkEvent(makeNotification({ statusCode: 200, error: "mocked:mock-1" }));
      expect(state.pendingNotificationCount).toBe(0);
      // OTHER_DEVICE's simulated transport failure still passes the errors filter.
      state.onNetworkEvent(makeNotification({ statusCode: 0, error: "simulated:timeout" }));
      expect(state.pendingNotificationCount).toBe(1);
    });

    it("does not notify when capture is off", () => {
      state.onNetworkEvent(makeNotification());
      timer.advanceTime(200);
      expect(notifier.notifications).toHaveLength(0);
    });

    it("notifies live and stats on successful request", () => {
      state.setCapture(true);
      state.onNetworkEvent(makeNotification());
      timer.advanceTime(200);

      expect(notifier.notifications).toContain("automobile:network/traffic/live");
      expect(notifier.notifications).toContain("automobile:network/stats");
      expect(notifier.notifications).not.toContain("automobile:network/traffic/errors");
    });

    it("notifies errors resource on 4xx/5xx", () => {
      state.setCapture(true);
      state.onNetworkEvent(makeNotification({ statusCode: 500 }));
      timer.advanceTime(200);

      expect(notifier.notifications).toContain("automobile:network/traffic/errors");
    });

    it("filters to errors only", () => {
      state.setCapture(true);
      state.setNotifFilter("errors");

      // Successful request should be ignored
      state.onNetworkEvent(makeNotification({ statusCode: 200 }));
      timer.advanceTime(200);
      expect(notifier.notifications).toHaveLength(0);

      // Error request should notify
      state.onNetworkEvent(makeNotification({ statusCode: 500 }));
      timer.advanceTime(200);
      expect(notifier.notifications.length).toBeGreaterThan(0);
    });

    it("filters to slow only", () => {
      state.setCapture(true);
      state.setNotifFilter("slow");
      state.setSlowThresholdMs(1000);

      // Fast request should be ignored
      state.onNetworkEvent(makeNotification({ durationMs: 100 }));
      timer.advanceTime(200);
      expect(notifier.notifications).toHaveLength(0);

      // Slow request should notify
      state.onNetworkEvent(makeNotification({ durationMs: 1500 }));
      timer.advanceTime(200);
      expect(notifier.notifications.length).toBeGreaterThan(0);
    });

    it("notifies slow resource on slow request", () => {
      state.setCapture(true);
      state.setSlowThresholdMs(1000);

      state.onNetworkEvent(makeNotification({ durationMs: 1500 }));
      timer.advanceTime(200);

      expect(notifier.notifications).toContain("automobile:network/traffic/slow");
    });

    it("does not notify slow resource on fast request", () => {
      state.setCapture(true);
      state.setSlowThresholdMs(1000);

      state.onNetworkEvent(makeNotification({ durationMs: 100 }));
      timer.advanceTime(200);

      expect(notifier.notifications).not.toContain("automobile:network/traffic/slow");
    });

    it("debounces rapid notifications", () => {
      state.setCapture(true);
      state.setNotifDebounceMs(100);

      state.onNetworkEvent(makeNotification({ id: 1 }));
      state.onNetworkEvent(makeNotification({ id: 2 }));
      state.onNetworkEvent(makeNotification({ id: 3 }));

      // Before debounce fires
      expect(notifier.notifications).toHaveLength(0);

      timer.advanceTime(100);

      // Should only fire one batch of notifications
      expect(notifier.notifications).toContain("automobile:network/traffic/live");
      expect(notifier.notifications).toContain("automobile:network/stats");
    });
  });

  describe("dispose", () => {
    it("cleans up timers and state", () => {
      state.setCapture(true);
      state.startSimulation(DEVICE, "http500", 60, null);
      state.onNetworkEvent(makeNotification());

      state.dispose();

      expect(state.getSimulation(DEVICE)).toBeNull();
      expect(state.pendingNotificationCount).toBe(0);
    });
  });
});
