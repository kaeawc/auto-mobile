import { describe, expect, test } from "bun:test";
import {
  LocationRouteRegistry,
  registerLocationRouteSessionCleanup,
  interpolateRoute,
  routeDistanceMeters,
  type LocationWaypoint,
} from "../../../src/features/utility/LocationRoutePlayer";
import { FakeTimer } from "../../fakes/FakeTimer";
import { SessionManager } from "../../../src/daemon/sessionManager";
import { FakeDeviceSessionPersistence } from "../../fakes/FakeDeviceSessionPersistence";
import { runWithAbortSignal } from "../../../src/utils/AbortContext";

const points: LocationWaypoint[] = [
  { latitude: 0, longitude: 0 },
  { latitude: 0, longitude: 0.001 },
  { latitude: 0, longitude: 0.003 },
];
const flush = async (): Promise<void> => {
  for (let index = 0; index < 12; index++) {
    await Promise.resolve();
  }
};
const deferred = (): {
  promise: Promise<void>;
  resolve: () => void;
  reject: (error: Error) => void;
} => {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
};

describe("location route player", () => {
  test("crosses the antimeridian by the short arc and stays finite near the pole", () => {
    const crossing = [
      { latitude: 0, longitude: 179.9 },
      { latitude: 0, longitude: -179.9 },
    ];
    const longitudes = [0, 0.25, 0.5, 0.75, 1].map(
      (fraction) => interpolateRoute(crossing, fraction).longitude,
    );
    expect(longitudes.map((longitude) => (longitude < 0 ? longitude + 360 : longitude))).toEqual(
      [...longitudes.map((longitude) => (longitude < 0 ? longitude + 360 : longitude))].sort(
        (a, b) => a - b,
      ),
    );
    expect(longitudes.every((longitude) => Math.abs(longitude) >= 179.9)).toBe(true);
    const polar = interpolateRoute(
      [
        { latitude: 89.9, longitude: 0 },
        { latitude: 89.9, longitude: 120 },
      ],
      0.5,
    );
    expect(Number.isFinite(polar.latitude) && Number.isFinite(polar.longitude)).toBe(true);
    expect(polar.latitude).toBeGreaterThanOrEqual(89.9);
    expect(polar.latitude).toBeLessThanOrEqual(90);
    expect(polar.longitude).toBeGreaterThanOrEqual(-180);
    expect(polar.longitude).toBeLessThanOrEqual(180);
  });

  test("a duration shorter than an interval emits the first and final fixes once", async () => {
    const timer = new FakeTimer();
    const registry = new LocationRouteRegistry(timer);
    const fixes: LocationWaypoint[] = [];
    registry.start("short", points, 100, 500, false, async (point) => {
      fixes.push(point);
    });
    timer.advanceTime(0);
    await flush();
    timer.advanceTime(100);
    await flush();
    timer.advanceTime(1000);
    await flush();
    expect(fixes).toEqual([points[0], points[2]]);
    expect(registry.isActive("short")).toBe(false);
  });

  test("detaches playback from its launching request", async () => {
    const timer = new FakeTimer();
    const registry = new LocationRouteRegistry(timer);
    const request = new AbortController();
    const fixes: number[] = [];
    await runWithAbortSignal(request.signal, async () => {
      registry.start("detached", points, 1000, 500, false, async (point, options) => {
        options.signal.throwIfAborted();
        fixes.push(point.longitude);
      });
    });
    request.abort();
    timer.advanceTime(0);
    await flush();
    timer.advanceTime(500);
    await flush();
    expect(fixes).toHaveLength(2);
    registry.stop("detached");
  });

  test("a never settling emit times out and cannot leave an active route", async () => {
    const timer = new FakeTimer();
    const registry = new LocationRouteRegistry(timer);
    let attempts = 0;
    registry.start("hung", points, 10000, 500, false, () => {
      attempts++;
      return new Promise<void>(() => {});
    });
    for (const delta of [0, 1000, 500, 1000, 500, 1000]) {
      timer.advanceTime(delta);
      await flush();
    }
    expect(attempts).toBe(3);
    expect(registry.isActive("hung")).toBe(false);
    expect(registry.consumeLastEnded("hung")).toMatchObject({ endedReason: "failed" });
    expect(timer.getPendingTimeoutCount()).toBe(0);
  });

  test("slow fixes never overlap and the next point follows elapsed time", async () => {
    const timer = new FakeTimer();
    const registry = new LocationRouteRegistry(timer);
    const pending = deferred();
    const fixes: number[] = [];
    registry.start("slow", points, 3000, 500, false, (point) => {
      fixes.push(point.longitude);
      return fixes.length === 1 ? pending.promise : Promise.resolve();
    });
    timer.advanceTime(0);
    timer.advanceTime(800);
    expect(fixes).toHaveLength(1);
    pending.resolve();
    await flush();
    timer.advanceTime(500);
    await flush();
    expect(fixes).toHaveLength(2);
    expect(fixes[1]).toBeGreaterThan(0.001);
    registry.stop("slow");
  });

  test("stopAndSettle waits for a cancelled in-flight emit", async () => {
    const timer = new FakeTimer();
    const registry = new LocationRouteRegistry(timer);
    const pending = deferred();
    registry.start("settle", points, 2000, 500, false, () => pending.promise);
    timer.advanceTime(0);
    const stopping = registry.stopAndSettle("settle");
    let settled = false;
    void stopping.then(() => {
      settled = true;
    });
    await flush();
    expect(settled).toBe(false);
    pending.resolve();
    expect(await stopping).toMatchObject({
      stopped: true,
      previousRoute: { endedReason: "stopped" },
    });
    expect(timer.getPendingTimeoutCount()).toBe(0);
  });

  test("stopAndSettle has a fake-timer bound when an emit ignores cancellation", async () => {
    const timer = new FakeTimer();
    const registry = new LocationRouteRegistry(timer);
    registry.start("uncooperative", points, 2000, 500, false, () => new Promise<void>(() => {}));
    timer.advanceTime(0);
    const stopping = registry.stopAndSettle("uncooperative");
    timer.advanceTime(1000);
    expect(await stopping).toMatchObject({
      stopped: true,
      previousRoute: { endedReason: "stopped" },
    });
    expect(timer.getPendingTimeoutCount()).toBe(0);
  });

  test("stopAll clears every route and its timers", () => {
    const timer = new FakeTimer();
    const registry = new LocationRouteRegistry(timer);
    for (const id of ["a", "b"]) {
      registry.start(id, points, 1000, 500, false, async () => {});
    }
    registry.stopAll();
    expect(registry.isActive("a")).toBe(false);
    expect(registry.isActive("b")).toBe(false);
    expect(timer.getPendingTimeoutCount()).toBe(0);
  });
  test("constant speed emits monotonic two-leg fixes and ends exactly at the final point", async () => {
    const timer = new FakeTimer();
    const registry = new LocationRouteRegistry(timer);
    const fixes: LocationWaypoint[] = [];
    const duration = 3000;
    const speed = routeDistanceMeters(points) / 3;
    registry.start(
      "d",
      points,
      (routeDistanceMeters(points) / speed) * 1000,
      1000,
      false,
      async (point) => {
        fixes.push(point);
      },
    );
    for (let tick = 0; tick <= duration; tick += 1000) {
      timer.advanceTime(tick === 0 ? 0 : 1000);
      await flush();
    }
    expect(fixes).toHaveLength(4);
    expect(registry.isActive("d")).toBe(false);
    expect(timer.getPendingTimeoutCount()).toBe(0);
    expect(fixes.map((point) => point.longitude)).toEqual([0, 0.001, 0.002, 0.003]);
    timer.advanceTime(3000);
    await flush();
    expect(fixes).toHaveLength(4);
  });

  test("total duration is distributed proportionally across legs", async () => {
    const halfway = interpolateRoute(points, 0.5);
    expect(halfway.longitude).toBeCloseTo(0.0015, 8);
    expect(interpolateRoute(points, 1)).toEqual(points[2]);
    const timer = new FakeTimer();
    const registry = new LocationRouteRegistry(timer);
    const fixes: number[] = [];
    registry.start("duration", points, 3000, 1000, false, async (point) => {
      fixes.push(point.longitude);
    });
    for (const delta of [0, 1000, 1000, 1000]) {
      timer.advanceTime(delta);
      await flush();
    }
    expect(fixes[1]).toBeCloseTo(0.001, 8);
    expect(fixes[2]).toBeCloseTo(0.002, 8);
    expect(fixes[3]).toBeCloseTo(0.003, 8);
  });

  test("loop restarts at the first point after the last point", async () => {
    const timer = new FakeTimer();
    const registry = new LocationRouteRegistry(timer);
    const fixes: number[] = [];
    registry.start("d", points, 1000, 500, true, async (point) => {
      fixes.push(point.longitude);
    });
    for (const delta of [0, 500, 500, 500]) {
      timer.advanceTime(delta);
      await flush();
    }
    expect(fixes).toHaveLength(4);
    expect(fixes[0]).toBe(0);
    expect(fixes[1]).toBeCloseTo(0.0015, 8);
    expect(fixes[2]).toBe(0.003);
    expect(fixes[3]).toBe(0);
    expect(registry.stop("d")).toBe(true);
    expect(registry.isActive("d")).toBe(false);
    expect(timer.getPendingTimeoutCount()).toBe(0);
  });

  test("stop and replacement cancel pending fixes", async () => {
    const timer = new FakeTimer();
    const registry = new LocationRouteRegistry(timer);
    const first: number[] = [];
    const second: number[] = [];
    registry.start("d", points, 2000, 500, false, async (point) => {
      first.push(point.longitude);
    });
    timer.advanceTime(0);
    await flush();
    registry.start("d", points.slice().reverse(), 2000, 500, false, async (point) => {
      second.push(point.longitude);
    });
    expect(timer.getPendingTimeoutCount()).toBe(1);
    timer.advanceTime(0);
    await flush();
    expect(registry.stop("d")).toBe(true);
    expect(registry.stop("d")).toBe(false);
    expect(registry.isActive("d")).toBe(false);
    expect(timer.getPendingTimeoutCount()).toBe(0);
    timer.advanceTime(5000);
    await flush();
    expect(first).toEqual([0]);
    expect(second).toEqual([0.003]);
  });

  test("three consecutive failing fixes stop playback", async () => {
    const timer = new FakeTimer();
    const registry = new LocationRouteRegistry(timer);
    let attempts = 0;
    registry.start("d", points, 4000, 500, false, async () => {
      attempts++;
      throw new Error("offline");
    });
    for (const delta of [0, 500, 500, 500]) {
      timer.advanceTime(delta);
      await flush();
    }
    expect(attempts).toBe(3);
    expect(registry.consumeLastEnded("d")).toEqual({ endedReason: "failed", lastError: "offline" });
    expect(registry.isActive("d")).toBe(false);
    expect(timer.getPendingTimeoutCount()).toBe(0);
    expect(registry.stop("d")).toBe(false);
    expect(registry.consumeLastEnded("d")).toBeUndefined();
  });

  test("an old third failure cannot stop a replacement or set its last error", async () => {
    const timer = new FakeTimer();
    const registry = new LocationRouteRegistry(timer);
    const pending: ReturnType<typeof deferred>[] = [];
    registry.start("d", points, 5000, 500, false, () => {
      const request = deferred();
      pending.push(request);
      return request.promise;
    });
    for (let attempt = 0; attempt < 3; attempt++) {
      timer.advanceTime(attempt === 0 ? 0 : 500);
      expect(pending).toHaveLength(attempt + 1);
      if (attempt < 2) {
        pending[attempt].reject(new Error("old route failed"));
        await flush();
      }
    }
    const replacementFixes: number[] = [];
    registry.start("d", points, 2000, 500, false, async (point) => {
      replacementFixes.push(point.longitude);
    });
    expect(registry.consumeLastEnded("d")).toBeUndefined();
    pending[2].reject(new Error("stale third failure"));
    await flush();
    expect(registry.consumeLastEnded("d")).toBeUndefined();
    expect(registry.isActive("d")).toBe(true);
    expect(timer.getPendingTimeoutCount()).toBe(1);
    timer.advanceTime(0);
    await flush();
    timer.advanceTime(500);
    await flush();
    expect(replacementFixes).toHaveLength(2);
    expect(registry.consumeLastEnded("d")).toBeUndefined();
    registry.stop("d");
    expect(timer.getPendingTimeoutCount()).toBe(0);
  });

  test("an in-flight fix resolving after stop cannot schedule another fix", async () => {
    const timer = new FakeTimer();
    const registry = new LocationRouteRegistry(timer);
    const pending = deferred();
    const fixes: number[] = [];
    registry.start("d", points, 1000, 500, false, (point) => {
      fixes.push(point.longitude);
      return pending.promise;
    });
    timer.advanceTime(0);
    expect(fixes).toEqual([0]);
    expect(registry.stop("d")).toBe(true);
    pending.resolve();
    await flush();
    timer.advanceTime(2000);
    await flush();
    expect(fixes).toEqual([0]);
    expect(registry.isActive("d")).toBe(false);
    expect(timer.getPendingTimeoutCount()).toBe(0);
  });

  test("session unbind during an in-flight fix prevents later fixes", async () => {
    const timer = new FakeTimer();
    const registry = new LocationRouteRegistry(timer);
    let unbound: Parameters<SessionManager["onSessionDeviceUnbound"]>[0] | undefined;
    registerLocationRouteSessionCleanup(
      {
        onSessionRelease: () => {},
        registerPendingDeviceCleanup: () => {},
        onSessionDeviceUnbound: (callback) => {
          unbound = callback;
        },
      },
      { registry },
    );
    const pending = deferred();
    const fixes: number[] = [];
    registry.start("d", points, 1000, 500, false, (point) => {
      fixes.push(point.longitude);
      return pending.promise;
    });
    timer.advanceTime(0);
    unbound!("session", "d");
    pending.resolve();
    await flush();
    timer.advanceTime(2000);
    await flush();
    expect(fixes).toEqual([0]);
    expect(registry.isActive("d")).toBe(false);
    expect(timer.getPendingTimeoutCount()).toBe(0);
  });

  test("the real session release callback cancels device playback", async () => {
    const timer = new FakeTimer();
    const registry = new LocationRouteRegistry(timer);
    const manager = new SessionManager(timer, new FakeDeviceSessionPersistence());
    registerLocationRouteSessionCleanup(manager, { registry });
    await manager.createSession("route-owner", "emulator-5554", "android");
    const fixes: number[] = [];
    registry.start("emulator-5554", points, 2000, 500, false, async (point) => {
      fixes.push(point.longitude);
    });
    timer.advanceTime(0);
    await flush();
    await manager.releaseSession("route-owner", "explicit-release");
    expect(registry.isActive("emulator-5554")).toBe(false);
    timer.advanceTime(3000);
    await flush();
    expect(fixes).toEqual([0]);
  });
});
