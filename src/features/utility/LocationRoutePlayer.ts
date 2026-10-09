import type { Timer } from "../../utils/SystemTimer";
import { defaultTimer } from "../../utils/SystemTimer";
import { errorMessage } from "../../utils/describeUnknownError";
import { logger } from "../../utils/logger";
import type { SessionManager } from "../../daemon/sessionManager";
import { runWithAbortSignal } from "../../utils/AbortContext";
import { raceWithDeadline } from "../../utils/raceWithDeadline";
import { defaultMockLocationClearRegistry, type MockLocationClears } from "./MockLocationClear";

export interface LocationWaypoint {
  latitude: number;
  longitude: number;
  altitude?: number;
}

const EARTH_RADIUS_METERS = 6_371_000;
const radians = (degrees: number): number => (degrees * Math.PI) / 180;
const degrees = (radiansValue: number): number => (radiansValue * 180) / Math.PI;

export function legDistanceMeters(a: LocationWaypoint, b: LocationWaypoint): number {
  const deltaLatitude = radians(b.latitude - a.latitude);
  const deltaLongitude = radians(b.longitude - a.longitude);
  const h =
    Math.sin(deltaLatitude / 2) ** 2 +
    Math.cos(radians(a.latitude)) *
      Math.cos(radians(b.latitude)) *
      Math.sin(deltaLongitude / 2) ** 2;
  return 2 * EARTH_RADIUS_METERS * Math.asin(Math.min(1, Math.sqrt(h)));
}

export function routeDistanceMeters(waypoints: readonly LocationWaypoint[]): number {
  let distance = 0;
  for (let index = 1; index < waypoints.length; index++) {
    distance += legDistanceMeters(waypoints[index - 1], waypoints[index]);
  }
  return distance;
}

export function interpolateRoute(
  waypoints: readonly LocationWaypoint[],
  elapsedFraction: number,
): LocationWaypoint {
  const total = routeDistanceMeters(waypoints);
  const target = Math.max(0, Math.min(1, elapsedFraction)) * total;
  let passed = 0;
  for (let index = 1; index < waypoints.length; index++) {
    const a = waypoints[index - 1];
    const b = waypoints[index];
    const length = legDistanceMeters(a, b);
    if (target > passed + length && index < waypoints.length - 1) {
      passed += length;
      continue;
    }
    const fraction = length === 0 ? 1 : Math.max(0, Math.min(1, (target - passed) / length));
    if (fraction === 0) {
      return a;
    }
    if (fraction === 1) {
      return b;
    }
    const latitudeA = radians(a.latitude);
    const longitudeA = radians(a.longitude);
    const latitudeB = radians(b.latitude);
    const longitudeB = radians(b.longitude);
    const angle = length / EARTH_RADIUS_METERS;
    const weightA = Math.sin((1 - fraction) * angle) / Math.sin(angle);
    const weightB = Math.sin(fraction * angle) / Math.sin(angle);
    const x =
      weightA * Math.cos(latitudeA) * Math.cos(longitudeA) +
      weightB * Math.cos(latitudeB) * Math.cos(longitudeB);
    const y =
      weightA * Math.cos(latitudeA) * Math.sin(longitudeA) +
      weightB * Math.cos(latitudeB) * Math.sin(longitudeB);
    const z = weightA * Math.sin(latitudeA) + weightB * Math.sin(latitudeB);
    return {
      latitude: degrees(Math.atan2(z, Math.hypot(x, y))),
      longitude: degrees(Math.atan2(y, x)),
      ...(a.altitude !== undefined && b.altitude !== undefined
        ? { altitude: a.altitude + (b.altitude - a.altitude) * fraction }
        : {}),
    };
  }
  return waypoints[waypoints.length - 1];
}

interface ActiveRoute {
  cancel(): void;
  inFlight?: Promise<void>;
  inFlightDeadline?: number;
  lastError?: string;
}

export interface EndedLocationRoute {
  endedReason: "completed" | "failed" | "replaced" | "stopped";
  lastError?: string;
}

export interface StoppedLocationRoute {
  stopped: boolean;
  previousRoute?: EndedLocationRoute;
}

/** One active route per device. A registry can be injected into tests. */
export class LocationRouteRegistry {
  private readonly active = new Map<string, ActiveRoute>();
  private readonly lastEnded = new Map<string, EndedLocationRoute>();

  constructor(private readonly timer: Timer = defaultTimer) {}

  stop(deviceId: string): boolean {
    const route = this.active.get(deviceId);
    if (!route) {
      return false;
    }
    return this.stopRoute(deviceId, route, "stopped");
  }

  async stopAndSettle(
    deviceId: string,
    reason: "stopped" | "replaced" = "stopped",
  ): Promise<StoppedLocationRoute> {
    const route = this.active.get(deviceId);
    if (route) {
      this.stopRoute(deviceId, route, reason);
      await this.settleCancelledEmit(deviceId, route);
    }
    const previousRoute = this.consumeLastEnded(deviceId);
    return { stopped: !!route, ...(previousRoute ? { previousRoute } : {}) };
  }

  private async settleCancelledEmit(deviceId: string, route: ActiveRoute): Promise<void> {
    if (!route.inFlight) {
      return;
    }
    const remaining = Math.max(0, (route.inFlightDeadline ?? this.timer.now()) - this.timer.now());
    if (remaining === 0) {
      return;
    }
    try {
      await raceWithDeadline(route.inFlight, {
        timer: this.timer,
        timeoutMs: remaining,
        unref: true,
        label: "Cancelled location fix settlement",
      });
    } catch (error) {
      logger.warn(
        `Cancelled location fix did not settle for ${deviceId}: ${errorMessage(error)}`,
        error,
      );
    }
  }

  private stopRoute(
    deviceId: string,
    route: ActiveRoute,
    endedReason: EndedLocationRoute["endedReason"],
  ): boolean {
    if (this.active.get(deviceId) !== route) {
      return false;
    }
    this.active.delete(deviceId);
    route.cancel();
    this.lastEnded.set(deviceId, {
      endedReason,
      ...(route.lastError ? { lastError: route.lastError } : {}),
    });
    return true;
  }

  isActive(deviceId: string): boolean {
    return this.active.has(deviceId);
  }

  consumeLastEnded(deviceId: string): EndedLocationRoute | undefined {
    const ended = this.lastEnded.get(deviceId);
    this.lastEnded.delete(deviceId);
    return ended;
  }

  forget(deviceId: string): void {
    this.stop(deviceId);
    this.lastEnded.delete(deviceId);
  }

  stopAll(): void {
    for (const deviceId of this.active.keys()) {
      this.stop(deviceId);
    }
    this.lastEnded.clear();
  }

  start(
    deviceId: string,
    waypoints: readonly LocationWaypoint[],
    durationMs: number,
    updateIntervalMs: number,
    loop: boolean,
    emit: (
      point: LocationWaypoint,
      options: { signal: AbortSignal; timeoutMs: number },
    ) => Promise<void>,
  ): void {
    this.stop(deviceId);
    this.lastEnded.delete(deviceId);
    let handle: NodeJS.Timeout | undefined;
    let consecutiveFailures = 0;
    let startedAt = this.timer.now();
    const routeController = new AbortController();
    // Two intervals permit ordinary slow fixes; the console client's 5s default is
    // the tighter platform default (simctl uses 60s), so cap both routes at 5s.
    const emitTimeoutMs = Math.min(updateIntervalMs * 2, 5000);
    const route: ActiveRoute = {
      cancel: () => {
        routeController.abort();
        if (handle !== undefined) {
          this.timer.clearTimeout(handle);
          handle = undefined;
        }
      },
    };
    this.active.set(deviceId, route);
    const schedule = (delay: number): void => {
      if (this.active.get(deviceId) !== route) {
        return;
      }
      handle = this.timer.setTimeout(() => {
        handle = undefined;
        void tick();
      }, delay);
      handle.unref?.();
    };
    const tick = async (): Promise<void> => {
      if (this.active.get(deviceId) !== route) {
        return;
      }
      const elapsed = Math.min(durationMs, this.timer.now() - startedAt);
      try {
        const emitController = new AbortController();
        const cancelEmit = () => emitController.abort();
        const signal = AbortSignal.any([routeController.signal, emitController.signal]);
        const operation = emit(interpolateRoute(waypoints, elapsed / durationMs), {
          signal,
          timeoutMs: emitTimeoutMs,
        });
        route.inFlight = operation;
        route.inFlightDeadline = this.timer.now() + emitTimeoutMs;
        try {
          await raceWithDeadline(operation, {
            timer: this.timer,
            timeoutMs: emitTimeoutMs,
            unref: true,
            label: "Location route fix",
            onTimeout: cancelEmit,
          });
        } finally {
          route.inFlight = undefined;
          route.inFlightDeadline = undefined;
        }
        if (this.active.get(deviceId) !== route) {
          return;
        }
        consecutiveFailures = 0;
        route.lastError = undefined;
      } catch (error) {
        if (this.active.get(deviceId) !== route) {
          return;
        }
        consecutiveFailures++;
        const message = errorMessage(error);
        route.lastError = message;
        logger.warn(`Location route fix failed for ${deviceId}: ${message}`, error);
        if (consecutiveFailures >= 3) {
          // Preserve the final failure until a new start, explicit stop, or teardown.
          this.stopRoute(deviceId, route, "failed");
          return;
        }
      }
      if (this.active.get(deviceId) !== route) {
        return;
      }
      if (elapsed >= durationMs) {
        if (!loop) {
          this.stopRoute(deviceId, route, "completed");
          return;
        }
        startedAt = this.timer.now() + updateIntervalMs;
        schedule(updateIntervalMs);
      } else {
        schedule(Math.min(updateIntervalMs, durationMs - elapsed));
      }
    };
    // A resident route owns its context, like SimCtlClient's detached shared flight.
    void runWithAbortSignal(undefined, async () => schedule(0));
  }
}

export const defaultLocationRouteRegistry = new LocationRouteRegistry();

/** The daemon's device-removal callback uses the same cleanup as explicit stop. */
export function stopLocationRouteForRemovedDevice(
  deviceId: string,
  registry: LocationRouteRegistry = defaultLocationRouteRegistry,
): void {
  registry.forget(deviceId);
}

/** Attach route cleanup to the daemon's existing session lifecycle seam. */
export function registerLocationRouteSessionCleanup(
  manager: Pick<
    SessionManager,
    "onSessionRelease" | "onSessionDeviceUnbound" | "registerPendingDeviceCleanup"
  >,
  options?: { registry?: LocationRouteRegistry; mockLocationClears?: MockLocationClears },
): void {
  const registry = options?.registry ?? defaultLocationRouteRegistry;
  const mockLocationClears = options?.mockLocationClears ?? defaultMockLocationClearRegistry;
  const cleanup = (sessionId: string, deviceId: string): void => {
    const active = registry.isActive(deviceId);
    const settled = active ? registry.stopAndSettle(deviceId) : Promise.resolve();
    if (active) {
      // stopAndSettle cancels synchronously; publish quarantine before the hook returns.
      manager.registerPendingDeviceCleanup(deviceId, settled);
    }
    const clear = mockLocationClears.clearAfter(sessionId, deviceId, settled);
    if (clear) {
      manager.registerPendingDeviceCleanup(deviceId, clear);
    }
    registry.forget(deviceId);
  };
  // A terminal upgrade of a finished release would stop the device's next owner's route (#10825).
  manager.onSessionRelease((sessionId, deviceId, _reason, _snapshot, releaseOptions) => {
    if (!releaseOptions?.upgradeOnly) {
      cleanup(sessionId, deviceId);
    }
  });
  manager.onSessionDeviceUnbound(cleanup);
}
