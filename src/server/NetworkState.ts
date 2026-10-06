import { isFailedNetworkRequest } from "../utils/networkRequestOutcome";
import { ResourceRegistry } from "./resourceRegistry";
import { logger } from "../utils/logger";
import { defaultTimer, type Timer } from "../utils/SystemTimer";

export type NotifFilter = "all" | "errors" | "slow";

export type SimulatedErrorType =
  | "http500"
  | "timeout"
  | "connectionRefused"
  | "dnsFailure"
  | "tlsFailure";

export interface SimulationConfig {
  errorType: SimulatedErrorType;
  limit: number | null;
  remaining: number | null;
  expiresAt: number;
}

export interface MockRule {
  mockId: string;
  host: string;
  path: string;
  method: string;
  /**
   * Configured use limit. The host never learns how many times a rule fired, so
   * it keeps no live "remaining" count; the device owns consumption.
   */
  limit: number | null;
  statusCode: number;
  responseHeaders: Record<string, string>;
  responseBody: string;
  contentType: string;
}

export interface NetworkNotification {
  id: number;
  timestamp: number;
  method: string;
  url: string;
  host: string | null;
  path: string | null;
  statusCode: number;
  durationMs: number;
  contentType: string | null;
  error: string | null;
}

export interface SimulatingErrorsSnapshot {
  errorType: SimulatedErrorType;
  limit?: number;
  remainingSeconds: number;
}

export interface NetworkStateSnapshot {
  capturing: boolean;
  /** Error simulation for the device the snapshot was requested for. */
  simulatingErrors?: SimulatingErrorsSnapshot;
  /** Per-device error simulation, present on a device-less snapshot. */
  simulatingErrorsByDevice?: Record<string, SimulatingErrorsSnapshot>;
  notifFilter: NotifFilter;
  notifDebounceMs: number;
  slowThresholdMs: number;
}

export interface ResourceNotifier {
  notifyResourceUpdated(uri: string): void;
}

export interface NetworkStateConfig {
  timer?: Timer;
  notifier?: ResourceNotifier;
}

/**
 * Mock rules and error simulation for ONE device (issue #10061). Keyed by device
 * so a rule set for device A is never pushed to device B, and so a session
 * release can remove exactly what that session installed.
 */
interface DeviceNetworkScope {
  mocks: Map<string, MockRule>;
  simulation: SimulationConfig | null;
  simulationTimeout: NodeJS.Timeout | null;
  /** Session that last installed state here; null for sessionless (direct) mode. */
  ownerSessionUuid: string | null;
}

const defaultNotifier: ResourceNotifier = {
  notifyResourceUpdated(uri: string): void {
    void ResourceRegistry.notifyResourceUpdated(uri);
  },
};

export class NetworkState {
  private static instance: NetworkState | null = null;

  private _capturing = false;
  private readonly _devices: Map<string, DeviceNetworkScope> = new Map();
  private _notifFilter: NotifFilter = "all";
  private _notifDebounceMs = 100;
  private _slowThresholdMs = 2000;
  private _nextMockId = 1;

  private _debounceTimeout: NodeJS.Timeout | null = null;
  private _pendingNotifications: NetworkNotification[] = [];

  readonly timer: Timer;
  private readonly notifier: ResourceNotifier;

  constructor(config: NetworkStateConfig = {}) {
    this.timer = config.timer ?? defaultTimer;
    this.notifier = config.notifier ?? defaultNotifier;
  }

  static getInstance(): NetworkState {
    if (!NetworkState.instance) {
      NetworkState.instance = new NetworkState();
    }
    return NetworkState.instance;
  }

  static resetInstance(): void {
    if (NetworkState.instance) {
      NetworkState.instance.dispose();
    }
    NetworkState.instance = null;
  }

  dispose(): void {
    for (const deviceId of Array.from(this._devices.keys())) {
      this.retireDevice(deviceId);
    }
    if (this._debounceTimeout) {
      this.timer.clearTimeout(this._debounceTimeout);
      this._debounceTimeout = null;
    }
    this._pendingNotifications = [];
  }

  // --- Capture ---

  get capturing(): boolean {
    return this._capturing;
  }

  setCapture(enabled: boolean): void {
    this._capturing = enabled;
  }

  // --- Per-device scope ---

  private scopeFor(deviceId: string): DeviceNetworkScope {
    let scope = this._devices.get(deviceId);
    if (!scope) {
      scope = {
        mocks: new Map(),
        simulation: null,
        simulationTimeout: null,
        ownerSessionUuid: null,
      };
      this._devices.set(deviceId, scope);
    }
    return scope;
  }

  private pruneIfEmpty(deviceId: string): void {
    const scope = this._devices.get(deviceId);
    if (scope && scope.mocks.size === 0 && scope.simulation === null) {
      this._devices.delete(deviceId);
    }
  }

  /**
   * Record which session installed state on a device. A sessionless write leaves
   * the existing owner alone, so direct mode keeps today's lifetime.
   */
  noteSessionOwner(deviceId: string, sessionUuid: string | undefined): void {
    if (sessionUuid !== undefined) {
      this.scopeFor(deviceId).ownerSessionUuid = sessionUuid;
    }
  }

  /**
   * Remove a device's rules and simulation when the session that installed them
   * is released (or leaves the device). Returns true when state was removed so
   * the caller knows to push the now-empty set to the device. State installed
   * sessionless, or by a different session, is left in place.
   */
  clearDeviceOwnedBySession(deviceId: string, sessionUuid: string): boolean {
    const scope = this._devices.get(deviceId);
    if (!scope || scope.ownerSessionUuid !== sessionUuid) {
      return false;
    }
    this.retireDevice(deviceId);
    return true;
  }

  /** Drop everything held for a device, regardless of owner (device removed). */
  retireDevice(deviceId: string): void {
    const scope = this._devices.get(deviceId);
    if (!scope) {
      return;
    }
    this.stopSimulationTimer(scope);
    this._devices.delete(deviceId);
  }

  // --- Error Simulation ---

  getSimulation(deviceId: string): SimulationConfig | null {
    const scope = this._devices.get(deviceId);
    if (!scope) {
      return null;
    }
    if (scope.simulation && this.timer.now() >= scope.simulation.expiresAt) {
      scope.simulation = null;
      this.pruneIfEmpty(deviceId);
    }
    return scope.simulation;
  }

  startSimulation(
    deviceId: string,
    errorType: SimulatedErrorType,
    durationSeconds: number,
    limit: number | null,
  ): void {
    this.startSimulationUntil(
      deviceId,
      errorType,
      Math.ceil(this.timer.now() + durationSeconds * 1000),
      limit,
    );
  }

  startSimulationUntil(
    deviceId: string,
    errorType: SimulatedErrorType,
    expiresAt: number,
    limit: number | null,
  ): void {
    // Clear the previous simulation in place: cancelSimulation() prunes an empty
    // scope, which would drop the owner recorded just before this call.
    const scope = this.scopeFor(deviceId);
    this.stopSimulationTimer(scope);
    scope.simulation = null;
    const timeoutMs = Math.max(0, expiresAt - this.timer.now());
    if (timeoutMs === 0) {
      this.pruneIfEmpty(deviceId);
      return;
    }
    scope.simulation = {
      errorType,
      limit,
      remaining: limit,
      expiresAt,
    };
    scope.simulationTimeout = this.timer.setTimeout(() => {
      scope.simulation = null;
      scope.simulationTimeout = null;
      if (this._devices.get(deviceId) === scope) {
        this.pruneIfEmpty(deviceId);
      }
    }, timeoutMs);
  }

  cancelSimulation(deviceId: string): void {
    const scope = this._devices.get(deviceId);
    if (!scope) {
      return;
    }
    this.stopSimulationTimer(scope);
    scope.simulation = null;
    this.pruneIfEmpty(deviceId);
  }

  private stopSimulationTimer(scope: DeviceNetworkScope): void {
    if (scope.simulationTimeout) {
      this.timer.clearTimeout(scope.simulationTimeout);
      scope.simulationTimeout = null;
    }
  }

  // --- Notification Config ---

  get notifFilter(): NotifFilter {
    return this._notifFilter;
  }

  setNotifFilter(filter: NotifFilter): void {
    this._notifFilter = filter;
  }

  get notifDebounceMs(): number {
    return this._notifDebounceMs;
  }

  setNotifDebounceMs(ms: number): void {
    this._notifDebounceMs = ms;
  }

  get slowThresholdMs(): number {
    return this._slowThresholdMs;
  }

  setSlowThresholdMs(ms: number): void {
    this._slowThresholdMs = ms;
  }

  // --- Mocks ---

  addMock(deviceId: string, rule: Omit<MockRule, "mockId">): MockRule {
    const mockId = `mock-${this._nextMockId++}`;
    const mock: MockRule = { ...rule, mockId };
    this.scopeFor(deviceId).mocks.set(mockId, mock);
    return mock;
  }

  removeMock(deviceId: string, mockId: string): boolean {
    const removed = this._devices.get(deviceId)?.mocks.delete(mockId) ?? false;
    this.pruneIfEmpty(deviceId);
    return removed;
  }

  clearAllMocks(deviceId: string): number {
    const scope = this._devices.get(deviceId);
    const count = scope?.mocks.size ?? 0;
    scope?.mocks.clear();
    this.pruneIfEmpty(deviceId);
    return count;
  }

  getMocks(deviceId: string): Map<string, MockRule> {
    return new Map(this._devices.get(deviceId)?.mocks);
  }

  /** Every device's rules, for the device-less `automobile:network/mocks` resource. */
  getAllMocks(): Array<MockRule & { deviceId: string }> {
    return Array.from(this._devices.entries()).flatMap(([deviceId, scope]) =>
      Array.from(scope.mocks.values()).map((mock) => ({ ...mock, deviceId })),
    );
  }

  /**
   * Summary of a device's rules keyed `method host+path`. The value is the
   * configured use limit (-1 when unlimited), NOT a live remaining count: the
   * host never learns how many times a rule fired (issue #10060).
   */
  getMockSummary(deviceId: string): Record<string, number> {
    const summary: Record<string, number> = {};
    for (const mock of this._devices.get(deviceId)?.mocks.values() ?? []) {
      const key = `${mock.method} ${mock.host}${mock.path}`;
      summary[key] = mock.limit ?? -1;
    }
    return summary;
  }

  // --- Snapshot ---

  private simulatingErrorsSnapshot(deviceId: string): SimulatingErrorsSnapshot | undefined {
    const sim = this.getSimulation(deviceId);
    if (!sim) {
      return undefined;
    }
    const snapshot: SimulatingErrorsSnapshot = {
      errorType: sim.errorType,
      remainingSeconds: Math.max(0, Math.ceil((sim.expiresAt - this.timer.now()) / 1000)),
    };
    if (sim.limit !== null) {
      snapshot.limit = sim.limit;
    }
    return snapshot;
  }

  /**
   * Snapshot of capture/notification config plus error simulation. With a
   * `deviceId`, `simulatingErrors` describes that device; without one the
   * per-device map is reported instead.
   */
  getSnapshot(deviceId?: string): NetworkStateSnapshot {
    const snapshot: NetworkStateSnapshot = {
      capturing: this._capturing,
      notifFilter: this._notifFilter,
      notifDebounceMs: this._notifDebounceMs,
      slowThresholdMs: this._slowThresholdMs,
    };

    if (deviceId !== undefined) {
      const simulating = this.simulatingErrorsSnapshot(deviceId);
      if (simulating) {
        snapshot.simulatingErrors = simulating;
      }
      return snapshot;
    }

    const byDevice: Record<string, SimulatingErrorsSnapshot> = {};
    for (const id of Array.from(this._devices.keys())) {
      const simulating = this.simulatingErrorsSnapshot(id);
      if (simulating) {
        byDevice[id] = simulating;
      }
    }
    if (Object.keys(byDevice).length > 0) {
      snapshot.simulatingErrorsByDevice = byDevice;
    }
    return snapshot;
  }

  // --- Notification Dispatch ---

  onNetworkEvent(notification: NetworkNotification): void {
    if (!this._capturing) {
      return;
    }

    const isError = isFailedNetworkRequest(notification);
    const isSlow = notification.durationMs >= this._slowThresholdMs;

    // Gate by filter
    if (this._notifFilter === "errors" && !isError) {
      return;
    }
    if (this._notifFilter === "slow" && !isSlow) {
      return;
    }

    this._pendingNotifications.push(notification);

    if (this._debounceTimeout) {
      return;
    }

    this._debounceTimeout = this.timer.setTimeout(() => {
      this.flushNotifications();
      this._debounceTimeout = null;
    }, this._notifDebounceMs);
  }

  get pendingNotificationCount(): number {
    return this._pendingNotifications.length;
  }

  private flushNotifications(): void {
    const pending = this._pendingNotifications;
    this._pendingNotifications = [];

    if (pending.length === 0) {
      return;
    }

    const hasErrors = pending.some(isFailedNetworkRequest);
    const hasSlow = pending.some((n) => n.durationMs >= this._slowThresholdMs);

    try {
      // Always notify the live traffic resource
      this.notifier.notifyResourceUpdated("automobile:network/traffic/live");

      // Notify errors resource if any errors in batch
      if (hasErrors) {
        this.notifier.notifyResourceUpdated("automobile:network/traffic/errors");
      }

      // Notify slow resource if any slow requests in batch
      if (hasSlow) {
        this.notifier.notifyResourceUpdated("automobile:network/traffic/slow");
      }

      // Stats resource always gets notified (it computes aggregates on read)
      this.notifier.notifyResourceUpdated("automobile:network/stats");
    } catch (e) {
      logger.error(`[NetworkState] Failed to send notifications: ${e}`);
    }
  }
}
