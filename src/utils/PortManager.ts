import { ENV, readEnvRaw } from "../config/env";
import { logger } from "./logger";
import { parseStrictPositiveInteger, readEnvInt } from "./envNumbers";
import { defaultTimer, type Timer } from "./SystemTimer";
import { BunPortAvailabilityChecker } from "./BunPortAvailabilityChecker";

export { BunPortAvailabilityChecker, type BunRuntime } from "./BunPortAvailabilityChecker";

export const IOS_SDK_HIERARCHY_SERVER_PORT = 8766;
export const IOS_CTRL_PROXY_RESERVED_PORTS = new Set<number>([
  // The in-app AutoMobile iOS SDK hierarchy server is fixed on 8766.
  IOS_SDK_HIERARCHY_SERVER_PORT,
]);

export interface PortAvailabilityChecker {
  isPortAvailable(port: number): boolean;
}

export interface PortAllocationOptions {
  reservedPorts?: Iterable<number>;
  availabilityChecker?: PortAvailabilityChecker;
}

/**
 * Pure computation of the port-scan upper bound from raw env values, split
 * out from `PortManager.resolveConfiguredScanEnd` so it can be unit tested
 * without touching the module-load-time singleton config (issue #6119).
 * Returns `undefined` when no range was explicitly configured, leaving the
 * scan unbounded (up to 65535) to preserve existing default behavior.
 */
export function computeConfiguredScanEnd(
  basePort: number,
  rangeEndEnv: string | undefined,
  rangeSizeEnv: string | undefined,
): number | undefined {
  if (rangeEndEnv) {
    const parsedEnd = parseStrictPositiveInteger(rangeEndEnv.trim());
    return parsedEnd !== undefined && parsedEnd >= basePort ? parsedEnd : undefined;
  }

  if (rangeSizeEnv) {
    const parsedSize = parseStrictPositiveInteger(rangeSizeEnv.trim());
    return parsedSize !== undefined ? basePort + parsedSize - 1 : undefined;
  }

  return undefined;
}

/**
 * Manages port allocation for multi-device support.
 * Each device gets a unique local port for WebSocket forwarding to avoid conflicts
 * when running multiple emulators/devices simultaneously.
 */
export class PortManager {
  private static allocatedPorts: Map<string, number> = new Map();
  private static cleanupHeldPorts: Set<number> = new Set();
  private static quarantinedPorts: Map<number, number> = new Map();
  private static clock: Pick<Timer, "now"> = defaultTimer;
  private static readonly QUARANTINE_MS = 60_000;
  private static readonly DEFAULT_BASE_PORT = 8765;
  private static readonly DEFAULT_MAX_DEVICES = 100;
  private static readonly basePort = PortManager.resolveBasePort();
  private static readonly maxDevices = PortManager.resolveMaxDevices();
  /**
   * Explicit upper bound on the port *scan* window, distinct from
   * `maxDevices` (a simultaneous-allocation count). Only set when
   * `AUTOMOBILE_PORT_RANGE_END`/`SIZE` is explicitly configured, so the
   * default scan keeps walking to 65535 as before.
   */
  private static readonly configuredScanEnd = PortManager.resolveConfiguredScanEnd();
  private static portAvailabilityChecker: PortAvailabilityChecker =
    new BunPortAvailabilityChecker();

  /**
   * Allocate a unique local port for a device.
   * Returns existing allocation if device already has a port.
   * @param deviceId - The device identifier
   * @returns The allocated local port number
   * @throws Error if no ports are available
   */
  public static allocate(deviceId: string, options: PortAllocationOptions = {}): number {
    this.purgeExpiredQuarantines();
    // Return existing allocation
    if (this.allocatedPorts.has(deviceId)) {
      return this.allocatedPorts.get(deviceId)!;
    }

    if (this.allocatedPorts.size >= this.maxDevices) {
      throw new Error(
        `No available ports for device ${deviceId}. ` +
          `The maximum of ${this.maxDevices} simultaneous device ports is already allocated.`,
      );
    }

    // Find next available port
    const usedPorts = new Set([
      ...this.allocatedPorts.values(),
      ...this.cleanupHeldPorts,
      ...this.quarantinedPorts.keys(),
    ]);
    const reservedPorts = new Set(options.reservedPorts ?? []);
    const availabilityChecker = options.availabilityChecker ?? this.portAvailabilityChecker;
    const scanEnd = Math.min(65535, this.configuredScanEnd ?? 65535);
    for (let port = this.basePort; port <= scanEnd; port++) {
      if (usedPorts.has(port) || reservedPorts.has(port)) {
        continue;
      }
      if (!availabilityChecker.isPortAvailable(port)) {
        continue;
      }
      this.allocatedPorts.set(deviceId, port);
      logger.info(`[PortManager] Allocated port ${port} for device ${deviceId}`);
      return port;
    }

    throw new Error(
      `No available ports for device ${deviceId}. ` +
        `No free host ports were found at or above ${this.basePort}.`,
    );
  }

  /**
   * Check whether a host port is currently free to bind.
   */
  public static isPortAvailable(
    port: number,
    checker: PortAvailabilityChecker = this.portAvailabilityChecker,
  ): boolean {
    this.purgeExpiredQuarantines();
    return !this.quarantinedPorts.has(port) && checker.isPortAvailable(port);
  }

  /**
   * Release a port allocation for a device.
   * @param deviceId - The device identifier
   */
  public static release(deviceId: string): void {
    const port = this.allocatedPorts.get(deviceId);
    if (port !== undefined) {
      this.allocatedPorts.delete(deviceId);
      logger.info(`[PortManager] Released port ${port} for device ${deviceId}`);
    }
  }

  /**
   * Keep a just-invalidated observer's port unavailable until its asynchronous
   * cleanup has finished. A replacement observer must use a different port so
   * late cleanup cannot tear down its ADB forward.
   */
  public static holdForCleanup(port: number): void {
    this.cleanupHeldPorts.add(port);
  }

  /** Release a port held by a completed invalidated-observer cleanup. */
  public static releaseCleanupHold(port: number): void {
    this.cleanupHeldPorts.delete(port);
  }

  /** Keep an unconfirmed ADB forward out of allocations for a bounded period. */
  public static quarantine(port: number): void {
    this.quarantinedPorts.set(port, this.clock.now() + this.QUARANTINE_MS);
  }

  public static clearQuarantine(port: number): void {
    if (this.quarantinedPorts.delete(port)) {
      logger.debug(`[PortManager] Cleared quarantine for port ${port}`);
    }
  }

  private static purgeExpiredQuarantines(): void {
    const now = this.clock.now();
    for (const [port, expiresAt] of this.quarantinedPorts) {
      if (now >= expiresAt) {
        this.quarantinedPorts.delete(port);
        logger.debug(`[PortManager] Quarantine expired for port ${port}`);
      }
    }
  }

  /** Release only when this caller still owns the device's allocated port. */
  public static releaseIfAllocated(deviceId: string, port: number): void {
    if (this.allocatedPorts.get(deviceId) === port) {
      this.release(deviceId);
    }
  }

  /** Reserve a known port for a device discovered after this process starts. */
  public static reserve(deviceId: string, port: number): void {
    for (const [allocatedDeviceId, allocatedPort] of this.allocatedPorts) {
      if (allocatedDeviceId !== deviceId && allocatedPort === port) {
        throw new Error(`Port ${port} is already allocated to device ${allocatedDeviceId}`);
      }
    }

    const existingPort = this.allocatedPorts.get(deviceId);
    if (existingPort === port) {
      return;
    }

    this.allocatedPorts.set(deviceId, port);
    logger.info(`[PortManager] Reserved port ${port} for device ${deviceId}`);
  }

  /**
   * Get the port allocated to a device, if any.
   * @param deviceId - The device identifier
   * @returns The allocated port or undefined
   */
  public static getPort(deviceId: string): number | undefined {
    return this.allocatedPorts.get(deviceId);
  }

  /**
   * Get WebSocket URL for a device.
   * @param deviceId - The device identifier
   * @returns The WebSocket URL with device-specific port
   */
  public static getWebSocketUrl(deviceId: string): string {
    const port = this.allocate(deviceId);
    return `ws://127.0.0.1:${port}/ws`;
  }

  /**
   * Get the number of currently allocated ports.
   * Useful for monitoring and testing.
   */
  public static getAllocatedCount(): number {
    return this.allocatedPorts.size;
  }

  /**
   * Get all current allocations.
   * Useful for debugging.
   */
  public static getAllocations(): Map<string, number> {
    return new Map(this.allocatedPorts);
  }

  /**
   * Reset all port allocations.
   * Should only be used in testing.
   */
  public static reset(): void {
    const count = this.allocatedPorts.size;
    this.allocatedPorts.clear();
    this.cleanupHeldPorts.clear();
    this.quarantinedPorts.clear();
    this.clock = defaultTimer;
    logger.info(`[PortManager] Reset all port allocations (cleared ${count} allocations)`);
  }

  /**
   * Override the host-port availability checker.
   * Should only be used in testing.
   */
  public static setPortAvailabilityCheckerForTesting(
    checker: PortAvailabilityChecker | null,
  ): void {
    this.portAvailabilityChecker = checker ?? new BunPortAvailabilityChecker();
  }

  public static setClockForTesting(clock: Pick<Timer, "now"> | null): void {
    this.clock = clock ?? defaultTimer;
  }

  /**
   * The base port number (for reference/testing)
   */
  public static getBasePort(): number {
    return this.basePort;
  }

  /**
   * The configured port range size (for testing and bounded retry loops).
   */
  public static getMaxDevices(): number {
    return this.maxDevices;
  }

  /**
   * The device port (port on the Android device side - always the same)
   */
  public static readonly DEVICE_PORT = 8765;

  static resolveBasePort(env: NodeJS.ProcessEnv = process.env): number {
    return readEnvInt(ENV.PORT_RANGE_START, env, { fallback: this.DEFAULT_BASE_PORT });
  }

  static resolveMaxDevices(
    env: NodeJS.ProcessEnv = process.env,
    basePort: number = this.basePort,
  ): number {
    const endValue = readEnvRaw(ENV.PORT_RANGE_END, env);
    if (endValue) {
      const parsedEnd = parseStrictPositiveInteger(endValue.trim());
      if (parsedEnd !== undefined && parsedEnd >= basePort) {
        return parsedEnd - basePort + 1;
      }
      logger.warn(
        `[PortManager] Invalid port range end '${endValue}', using default ${this.DEFAULT_MAX_DEVICES}`,
      );
      return this.DEFAULT_MAX_DEVICES;
    }

    const sizeValue = readEnvRaw(ENV.PORT_RANGE_SIZE, env);
    if (!sizeValue) {
      return this.DEFAULT_MAX_DEVICES;
    }
    const parsedSize = parseStrictPositiveInteger(sizeValue.trim());
    if (parsedSize === undefined) {
      logger.warn(
        `[PortManager] Invalid port range size '${sizeValue}', using default ${this.DEFAULT_MAX_DEVICES}`,
      );
      return this.DEFAULT_MAX_DEVICES;
    }
    return parsedSize;
  }

  /**
   * The last port the allocation scan should consider, when the caller has
   * explicitly bounded the range via `AUTOMOBILE_PORT_RANGE_END`/`SIZE`.
   * `maxDevices` alone only limits how many *simultaneous* allocations are
   * permitted (`allocatedPorts.size`, checked above) — it does not stop the
   * scan loop from wandering past a configured range while hunting for a
   * free port, so an explicit range leaks past its upper bound. Returns
   * `undefined` when no range was configured, leaving the scan unbounded
   * (up to 65535) as before.
   */
  private static resolveConfiguredScanEnd(): number | undefined {
    return computeConfiguredScanEnd(
      this.basePort,
      readEnvRaw(ENV.PORT_RANGE_END),
      readEnvRaw(ENV.PORT_RANGE_SIZE),
    );
  }
}
