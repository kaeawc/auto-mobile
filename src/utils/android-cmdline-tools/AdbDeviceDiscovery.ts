import { TTLCache } from "../cache/Cache";
import { SingleFlight } from "../cache/SingleFlight";

import { parseAdbDevicesList } from "./parseAdbDevicesList";

import { copyAndroidTransportId } from "../androidSerial";
import { raceWithDeadline } from "../raceWithDeadline";

import { logger } from "../logger";

import { BootedDevice, ExecResult } from "../../models";

import { type AdbExecuteOptions, type AdbDeviceState } from "./interfaces/AdbExecutor";
import { runWithAbortSignal, getAbortSignal } from "../AbortContext";

import { Timer } from "../SystemTimer";

import type { DiscoveryObservationSequence } from "../DiscoveryObservationSequence";
import { AdbCommandTimeoutError } from "./AdbCommandTimeoutError";
import { AdbUnavailableError } from "./AdbUnavailableError";

export interface AdbDeviceDiscoveryContext {
  shouldSkipMissingAdbProbe(): boolean;
  timer: Timer;
  DEVICE_LIST_TIMEOUT_MS: number;
  executeCommand(command: string, options?: AdbExecuteOptions): Promise<ExecResult>;
  isMissingExecutableError(error: unknown): boolean;
  recordMissingAdbProbe(): void;
  observationSequence: DiscoveryObservationSequence;
  getDeviceStates(options?: {
    timeoutMs?: number;
    signal?: AbortSignal;
    throwOnMissingAdb?: boolean;
  }): Promise<AdbDeviceState[]>;
}
export class AdbDeviceDiscovery {
  constructor(private readonly context: AdbDeviceDiscoveryContext) {}

  /**
   * Get the list of connected devices
   * @returns Promise with an array of device IDs
   */
  async getBootedAndroidDevices(
    options: {
      bypassCache?: boolean;
      throwOnMissingAdb?: boolean;
      timeoutMs?: number;
      signal?: AbortSignal;
    } = {},
  ): Promise<BootedDevice[]> {
    if (this.context.shouldSkipMissingAdbProbe()) {
      if (options.throwOnMissingAdb) {
        throw new AdbUnavailableError("ADB executable is unavailable");
      }
      return [];
    }

    // Check cache first - TTLCache handles expiration automatically
    const cache = getDeviceListCache(this.context.timer);
    const cachedDevices = options.bypassCache ? undefined : cache.get("devices");
    if (cachedDevices) {
      logger.debug("Getting list of connected devices (cached)");
      return cachedDevices;
    }

    const timeoutMs = options.timeoutMs ?? this.context.DEVICE_LIST_TIMEOUT_MS;
    const signal = options.signal ?? getAbortSignal();
    try {
      // A bypass caller needs its own fresh snapshot and must not inherit the
      // result of a non-bypass request that was already in flight.
      if (options.bypassCache) {
        return await this.readDeviceListFromAdb(timeoutMs, options.signal);
      }

      const shared = getDeviceListState(this.context.timer).singleFlight.run(
        "devices",
        () => {
          // The shared subprocess has its own bounded timeout but deliberately
          // does not inherit a waiter's signal. Each caller races its signal in
          // SingleFlight, so one disconnected client cannot cancel discovery
          // for the other clients sharing this cold read.
          return runWithAbortSignal(undefined, () =>
            this.readDeviceListFromAdb(this.context.DEVICE_LIST_TIMEOUT_MS),
          );
        },
        signal,
      );
      return await raceWithDeadline(shared, {
        timer: this.context.timer,
        timeoutMs,
        signal,
        label: "ADB device-list caller wait",
        timeoutError: () =>
          new AdbCommandTimeoutError(`ADB device-list caller wait timed out after ${timeoutMs}ms`),
      });
    } catch (error) {
      if (error instanceof AdbUnavailableError && !options.throwOnMissingAdb) {
        return [];
      }
      throw error;
    }
  }

  async readDeviceListFromAdb(timeoutMs: number, signal?: AbortSignal): Promise<BootedDevice[]> {
    const generation = ++deviceListGeneration;
    logger.debug("Getting list of connected devices");
    let result: ExecResult;
    try {
      result = await this.context.executeCommand("devices -l", {
        timeoutMs,
        noRetry: true,
        signal,
      });
    } catch (error) {
      if (this.context.isMissingExecutableError(error)) {
        this.context.recordMissingAdbProbe();
        throw new AdbUnavailableError(`ADB executable is unavailable: ${(error as Error).message}`);
      }
      throw error;
    }
    const observedAt = this.context.observationSequence.next();
    const devices = parseAdbDevicesList(result.stdout)
      .filter((state) => state.state === "device")
      .map((state) =>
        copyAndroidTransportId(state, {
          name: state.deviceId,
          platform: "android" as const,
          deviceId: state.deviceId,
          observedAt,
        }),
      );

    this.publishDeviceList(generation, devices);
    return devices;
  }

  publishDeviceList(generation: number, devices: BootedDevice[]): void {
    if (generation >= deviceListPublishedGeneration) {
      deviceListPublishedGeneration = generation;
      getDeviceListCache(this.context.timer).set("devices", devices);
    }
  }

  /**
   * List raw ADB states without applying the online-only filter used by
   * getBootedAndroidDevices(). Readiness diagnostics use this to distinguish a
   * device that is absent from one that is present but stuck offline.
   */
  async getDeviceStates(
    options: { timeoutMs?: number; signal?: AbortSignal; throwOnMissingAdb?: boolean } = {},
  ): Promise<AdbDeviceState[]> {
    if (this.context.shouldSkipMissingAdbProbe()) {
      if (options.throwOnMissingAdb) {
        throw new AdbUnavailableError("ADB executable is unavailable");
      }
      return [];
    }

    let result: ExecResult;
    try {
      result = await this.context.executeCommand("devices -l", {
        timeoutMs: options.timeoutMs ?? this.context.DEVICE_LIST_TIMEOUT_MS,
        noRetry: true,
        signal: options.signal,
      });
    } catch (error) {
      if (this.context.isMissingExecutableError(error)) {
        if (options.throwOnMissingAdb) {
          throw new AdbUnavailableError(
            `ADB executable is unavailable: ${(error as Error).message}`,
          );
        }
        // Preserve the diagnostic path while treating an unavailable ADB as no connected devices.
        logger.debug(
          `[ADB] Unable to query device states because adb is unavailable: ${(error as Error).message}`,
        );
        this.context.recordMissingAdbProbe();
        return [];
      }
      throw error;
    }

    return parseAdbDevicesList(result.stdout);
  }

  async getReadinessDeviceSnapshot(options: {
    timeoutMs: number;
    signal?: AbortSignal;
  }): Promise<{ states: AdbDeviceState[]; devices: BootedDevice[] }> {
    const generation = ++deviceListGeneration;
    const states = await this.context.getDeviceStates({ ...options, throwOnMissingAdb: true });
    const observedAt = this.context.observationSequence.next();
    const devices = states
      .filter((state) => state.state === "device")
      .map((state) =>
        copyAndroidTransportId(state, {
          name: state.deviceId,
          platform: "android" as const,
          deviceId: state.deviceId,
          observedAt,
        }),
      );
    this.publishDeviceList(generation, devices);
    return { states, devices };
  }
}

// The device-list cache and its single-flight are scoped to the Timer that reads them. Production
// clients all share defaultTimer, so they still share one cache; a client injected with its own
// (Fake)Timer gets private state, so a TTL entry frozen on another timer's clock, or an in-flight
// read parked on it, can never answer a later client (#11614).
interface DeviceListState {
  cache: TTLCache<string, BootedDevice[]>;
  singleFlight: SingleFlight<string, BootedDevice[]>;
}

let deviceListStates = new WeakMap<Timer, DeviceListState>();

let deviceListGeneration = 0;

let deviceListPublishedGeneration = 0;

const DEVICE_LIST_CACHE_TTL_MS = 5000;

function getDeviceListState(timer: Timer): DeviceListState {
  let state = deviceListStates.get(timer);
  if (!state) {
    state = {
      cache: new TTLCache(timer, { ttlMs: DEVICE_LIST_CACHE_TTL_MS }),
      singleFlight: new SingleFlight<string, BootedDevice[]>(),
    };
    deviceListStates.set(timer, state);
  }
  return state;
}

function getDeviceListCache(timer: Timer): TTLCache<string, BootedDevice[]> {
  return getDeviceListState(timer).cache;
}
export function resetAdbDeviceDiscoveryCache(): void {
  deviceListStates = new WeakMap();
  deviceListPublishedGeneration = ++deviceListGeneration;
}
