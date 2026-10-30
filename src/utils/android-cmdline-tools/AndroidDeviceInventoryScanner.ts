import { raceWithDeadline } from "../raceWithDeadline";
import { combineAbortSignals } from "../AbortContext";
import { logger } from "../logger";
import { BootedDevice, DeviceInfo, ActionableError } from "../../models";
import {
  readAndroidDeviceDisplays,
  readAndroidDeviceDisplaysChecked,
} from "./AndroidDisplayInventory";
import { getAbortSignal, runWithAbortSignal } from "../AbortContext";
import { parseAndroidSystemImageRuntime } from "./AndroidSystemImageRuntime";
import { TTLCache } from "../cache/Cache";
import { SingleFlight } from "../cache/SingleFlight";
import { transportIdFor } from "../androidSerial";
import { createGlobalPerformanceTracker } from "../PerformanceTracker";
import type { Timer } from "../SystemTimer";
import type { AdbClientFactory } from "./AdbClientFactory";
import type { AvdConfig, AvdConfigReader } from "./AvdConfigReader";
import type { DiscoveryObservationSequence } from "../DiscoveryObservationSequence";

export type ReadinessDiagnosticPhase =
  | "avd-name-resolution"
  | "boot-animation"
  | "device-discovery"
  | "device-state"
  | "package-manager"
  | "system-boot-complete";

export const ANDROID_INVENTORY_AVD_LIST_CAP_MS = 30_000;
export const ANDROID_INVENTORY_ENRICHMENT_TTL_MS = 2_500;
export const ANDROID_INVENTORY_DEVICE_LIST_BUDGET_MS = 2_000;
export const READINESS_NAME_TIMEOUT_MS = 2_000;

export interface ReadinessDiagnostic {
  phase: ReadinessDiagnosticPhase;
  summary: string;
  deviceId?: string;
}

export interface BootedDeviceScan {
  devices: BootedDevice[];
  diagnostics: ReadinessDiagnostic[];
}

export interface BootedDeviceScanOptions {
  foreignSerials?: ReadonlySet<string>;
  /** Resolve ownership after the single serial-only listing, before enrichment. */
  resolveForeignSerials?: (
    serials: readonly string[],
    signal?: AbortSignal,
  ) => Promise<ReadonlySet<string>>;
  coalesceInventoryEnrichment?: boolean;
  /** Read listings only: briefly reuse names proven on the same ADB connection. */
  memoizeReadAvdNames?: boolean;
  bypassDeviceListCache?: boolean;
  devices?: BootedDevice[];
  timeoutMs?: number;
  deviceListTimeoutMs?: number;
  targetDeviceId?: string;
  deadlineMs?: number;
  readinessOnly?: boolean;
  /** Keep identity probes, but skip metadata and display I/O unused by liveness. */
  skipProfileEnrichment?: boolean;
  /**
   * List what is attached and stop there: no `emu avd name`, no
   * `getprop ro.boot.qemu.avd_name`, no `getprop ro.product.model`. Every
   * emulator comes back under the `Unknown (<serial>)` placeholder and every
   * handset under its serial (or a name already cached), which is exactly what
   * those names mean today when the runtime declines to answer.
   *
   * Enrichment is sequential and budgets 2s per attached device, so with
   * several wedged consoles it alone outlasts a destructive action's whole
   * deadline. A caller that has ALREADY decided not to establish an identity --
   * `force` (#6864) -- must not pay for names it has committed to ignore, or
   * the escape hatch times out inside discovery and never dispatches the kill
   * it exists to dispatch
   * ([#6874](https://github.com/kaeawc/auto-mobile/pull/6874) review). Nothing
   * that still compares names may set this.
   */
  skipNameEnrichment?: boolean;
}

export type InventoryNameResult = {
  name: string;
  diagnostic?: ReadinessDiagnostic;
  consoleBusyDuringProbe?: boolean;
  nameProbeTimedOut?: boolean;
};
export type InventoryDisplayResult = Awaited<ReturnType<typeof readAndroidDeviceDisplaysChecked>>;
export interface ReadNameConnection {
  key: string;
}
export interface InventoryEnrichmentState {
  generation: number;
  names: TTLCache<string, InventoryNameResult>;
  nameFlight: SingleFlight<string, InventoryNameResult>;
  readNames: TTLCache<string, InventoryNameResult>;
  readNameConnections: TTLCache<string, ReadNameConnection>;
  readNameFlight: SingleFlight<ReadNameConnection, InventoryNameResult>;
  displays: TTLCache<string, InventoryDisplayResult>;
  displayFlight: SingleFlight<string, InventoryDisplayResult>;
  avds: TTLCache<string, DeviceInfo[]>;
  avdFlight: SingleFlight<string, DeviceInfo[]>;
}
const inventoryEnrichmentStates = new WeakMap<Timer, InventoryEnrichmentState>();
const inventoryEnrichmentReferences = new Set<WeakRef<InventoryEnrichmentState>>();
export function inventoryEnrichmentState(timer: Timer): InventoryEnrichmentState {
  let state = inventoryEnrichmentStates.get(timer);
  if (!state) {
    const options = { ttlMs: ANDROID_INVENTORY_ENRICHMENT_TTL_MS, maxEntries: 256 };
    state = {
      generation: 0,
      names: new TTLCache(timer, options),
      nameFlight: new SingleFlight(),
      readNames: new TTLCache(timer, options),
      readNameConnections: new TTLCache(timer, options),
      readNameFlight: new SingleFlight(),
      displays: new TTLCache(timer, options),
      displayFlight: new SingleFlight(),
      avds: new TTLCache(timer, options),
      avdFlight: new SingleFlight(),
    };
    inventoryEnrichmentStates.set(timer, state);
    inventoryEnrichmentReferences.add(new WeakRef(state));
  }
  return state;
}
export function resetAndroidInventoryEnrichmentCache(): void {
  for (const ref of inventoryEnrichmentReferences) {
    const state = ref.deref();
    if (!state) {
      inventoryEnrichmentReferences.delete(ref);
      continue;
    }
    state.generation++;
    state.names.clear();
    state.readNames.clear();
    state.readNameConnections.clear();
    state.displays.clear();
    state.avds.clear();
    // Retain active flights: lifecycle invalidation must never multiply subprocesses.
  }
}

export function configuredAvdArchitecture(
  config: AvdConfig,
  fallback: string | undefined,
): string | undefined {
  if (!config.systemImagePackage) {
    return config.architecture ?? fallback;
  }
  // The image ABI is the configured guest architecture. Prefer it over
  // config.ini's emulator-normalized architecture (for example, arm64-v8a vs arm64).
  return (
    parseAndroidSystemImageRuntime(config.systemImagePackage)?.abi ??
    config.architecture ??
    fallback
  );
}

export interface AndroidDeviceInventoryDeps {
  timer: () => Timer;
  adbFactory: () => AdbClientFactory;
  observationSequence: () => DiscoveryObservationSequence;
  avdConfigReader: () => AvdConfigReader;
  /** Ask the runtime on a serial which AVD it is (shared with readiness and kill identity). */
  getRunningAvdName: (
    device: BootedDevice,
    infoTimeoutMs: number,
    signal?: AbortSignal,
  ) => Promise<InventoryNameResult>;
  isUnknownEmulatorName: (name: string, deviceId: string) => boolean;
  unknownEmulatorName: (deviceId: string) => string;
  throwIfAborted: (signal: AbortSignal | undefined) => void;
}

/**
 * Booted-device inventory: lists attached emulators and physical devices and enriches them with
 * AVD name, model, architecture and display, behind shared TTL caches.
 */
export interface AndroidDeviceInventoryScanner {
  getBootedDevicesWithDiagnostics(
    onlyEmulators?: boolean,
    options?: BootedDeviceScanOptions,
    signal?: AbortSignal,
  ): Promise<BootedDeviceScan>;
  resolveFoundDeviceModel(
    foundDeviceModel: string | undefined,
    foundDeviceId: string,
    avdName: string,
    options: { timeoutMs: number; signal?: AbortSignal },
  ): Promise<string | undefined>;
  foundBootedDevice(
    avdName: string,
    foundDeviceId: string,
    model: string | undefined,
  ): BootedDevice;
  resolvedReadyAvdName(
    requestedName: string,
    deviceId: string,
    scannedName: string,
    options: { timeoutMs: number; signal?: AbortSignal },
  ): Promise<string>;
}

export class DefaultAndroidDeviceInventoryScanner implements AndroidDeviceInventoryScanner {
  private modelNameCache = new Map<string, string>();
  private architectureCache = new Map<string, string>();

  constructor(private readonly deps: AndroidDeviceInventoryDeps) {}

  async getBootedDevicesWithDiagnostics(
    onlyEmulators: boolean = false,
    options: BootedDeviceScanOptions = {},
    signal?: AbortSignal,
  ): Promise<BootedDeviceScan> {
    const perf = createGlobalPerformanceTracker();
    {
      const adb = this.deps.adbFactory().create(null);
      perf.startOperation("adbDeviceScan");
      const devices =
        options.devices ??
        (await adb.getBootedAndroidDevices({
          bypassCache: options.bypassDeviceListCache,
          throwOnMissingAdb: true,
          timeoutMs: this.deviceListScanTimeout(options),
          signal,
        }));
      const scanDeadlineMs = Math.min(
        options.deadlineMs ?? Infinity,
        this.deps.timer().now() +
          Math.min(options.timeoutMs ?? READINESS_NAME_TIMEOUT_MS, READINESS_NAME_TIMEOUT_MS),
      );
      const ownershipController = new AbortController();
      const ownershipSignal = combineAbortSignals(signal, ownershipController.signal);
      const foreignSerials = await raceWithDeadline(
        () => this.foreignScanSerials(devices, options, ownershipSignal),
        {
          timer: this.deps.timer(),
          signal,
          timeoutMs: Math.max(0, scanDeadlineMs - this.deps.timer().now()),
          label: "Android inventory ownership lookup",
          onTimeout: () =>
            ownershipController.abort(new Error("Android inventory scan deadline expired")),
        },
      );
      perf.endOperation("adbDeviceScan");
      this.invalidateReadNameConnections(devices, options);
      this.invalidateInventorySerials(devices, options);
      if (!options.devices) {
        this.evictDepartedDeviceInfo(devices);
      }
      const runningDevices: BootedDevice[] = [];

      // Add local emulator devices
      const relevantDevices = options.targetDeviceId
        ? devices.filter((device) => device.deviceId === options.targetDeviceId)
        : devices;
      const emulatorDevices = relevantDevices.filter((device) =>
        device.deviceId.startsWith("emulator-"),
      );
      const physicalDevices = relevantDevices.filter(
        (device) => !device.deviceId.startsWith("emulator-"),
      );

      const remainingScanMs = () =>
        Math.max(0, Math.min(READINESS_NAME_TIMEOUT_MS, scanDeadlineMs - this.deps.timer().now()));
      const infoTimeoutMs = Math.min(
        remainingScanMs(),
        options.timeoutMs ?? READINESS_NAME_TIMEOUT_MS,
      );
      const diagnostics: ReadinessDiagnostic[] = [];
      perf.startOperation("avdNameResolution");
      const emulatorResults = await Promise.all(
        emulatorDevices.map(async (device) => {
          if (foreignSerials?.has(device.deviceId)) {
            return { device: this.foreignDevice(device, options), diagnostic: undefined };
          }
          const deadlineMs = this.deps.timer().now() + remainingScanMs();
          const nameTimeoutMs = Math.min(infoTimeoutMs, remainingScanMs());
          const avdName =
            options.skipNameEnrichment || nameTimeoutMs <= 0
              ? { name: "", diagnostic: undefined }
              : await this.inventoryRunningAvdName(device, {
                  options,
                  timeoutMs: nameTimeoutMs,
                  signal,
                });
          const modelRemainingMs = Math.min(
            deadlineMs - this.deps.timer().now(),
            remainingScanMs(),
          );
          const model =
            modelRemainingMs > 0 &&
            !options.skipProfileEnrichment &&
            !(options.readinessOnly && options.coalesceInventoryEnrichment)
              ? await this.modelForBootedEmulator(device, avdName, modelRemainingMs, {
                  skipNameEnrichment: options.skipNameEnrichment === true,
                  signal,
                })
              : undefined;
          const architectureRemainingMs = Math.min(
            deadlineMs - this.deps.timer().now(),
            remainingScanMs(),
          );
          const architecture =
            architectureRemainingMs > 0 && this.includesFullMetadata(options)
              ? await this.resolveEmulatorArchitecture(device, avdName, architectureRemainingMs, {
                  skipNameEnrichment: options.skipNameEnrichment === true,
                  signal,
                })
              : undefined;

          return {
            device: this.discoveredEmulatorDevice(device, avdName, model, architecture),
            diagnostic: avdName.diagnostic,
          };
        }),
      );
      for (const result of emulatorResults) {
        runningDevices.push(result.device);
        if (result.diagnostic) {
          diagnostics.push(result.diagnostic);
        }
      }

      runningDevices.push(
        ...(await this.scanPhysicalDevices(physicalDevices, options, foreignSerials, {
          remainingScanMs,
          signal,
        })),
      );
      if (this.includesFullMetadata(options)) {
        await Promise.all(
          runningDevices.map(async (device) => {
            if (device.foreignOwned || remainingScanMs() <= 0) {
              return;
            }
            const snapshotDevice = devices.find(
              (snapshot) => snapshot.deviceId === device.deviceId,
            );
            const displays = await this.inventoryDisplays(
              { ...device, observedAt: snapshotDevice?.observedAt },
              options,
              signal,
            );
            if (displays) {
              device.displays = displays;
            }
          }),
        );
      }
      perf.endOperation("avdNameResolution");

      return { devices: runningDevices, diagnostics };
    }
  }

  private foreignScanSerials(
    devices: BootedDevice[],
    options: BootedDeviceScanOptions,
    signal?: AbortSignal,
  ): Promise<ReadonlySet<string> | undefined> {
    return options.foreignSerials
      ? Promise.resolve(options.foreignSerials)
      : (options.resolveForeignSerials?.(
          devices.map((device) => device.deviceId),
          signal,
        ) ?? Promise.resolve(undefined));
  }

  private async scanPhysicalDevices(
    physicalDevices: BootedDevice[],
    options: BootedDeviceScanOptions,
    foreignSerials: ReadonlySet<string> | undefined,
    { remainingScanMs, signal }: { remainingScanMs: () => number; signal?: AbortSignal },
  ): Promise<BootedDevice[]> {
    const runningDevices: BootedDevice[] = [];
    for (const device of physicalDevices) {
      if (foreignSerials?.has(device.deviceId)) {
        runningDevices.push(this.foreignDevice(device, options));
        continue;
      }
      const physicalTimeoutMs = this.physicalScanTimeout(options, remainingScanMs());
      if (physicalTimeoutMs <= 0) {
        runningDevices.push(this.discoveredPhysicalDevice(device, undefined, undefined));
        continue;
      }
      const [model, architecture] = await Promise.all([
        this.resolveDeviceModel(device, physicalTimeoutMs, options.skipNameEnrichment === true, {
          signal,
        }),
        this.resolvePhysicalDeviceArchitecture(
          device,
          physicalTimeoutMs,
          options.skipNameEnrichment === true,
          { signal },
        ),
      ]);
      runningDevices.push(this.discoveredPhysicalDevice(device, model, architecture));
    }
    return runningDevices;
  }

  private foreignDevice(device: BootedDevice, options: BootedDeviceScanOptions): BootedDevice {
    const state = inventoryEnrichmentState(this.deps.timer());
    const inventoryKey = this.inventoryCacheKey(device, options);
    const transportId = transportIdFor(device);
    const cachedName =
      (inventoryKey ? state.names.get(inventoryKey)?.name : undefined) ??
      (transportId ? state.readNames.get(`${device.deviceId}\0${transportId}`)?.name : undefined);
    const emulator = device.deviceId.startsWith("emulator-");
    const cacheKey = this.deviceInfoCacheKey(
      device.deviceId,
      emulator ? (cachedName ?? "") : undefined,
    );
    const model = cacheKey ? this.modelNameCache.get(cacheKey) : undefined;
    const architecture = cacheKey ? this.architectureCache.get(cacheKey) : undefined;
    const result = emulator
      ? this.discoveredEmulatorDevice(device, { name: cachedName ?? "" }, model, architecture)
      : this.discoveredPhysicalDevice(device, model, architecture);
    // Deliberately skipped identity is not a failed or timed-out console probe.
    delete result.consoleBusyDuringProbe;
    delete result.nameProbeTimedOut;
    return { ...result, foreignOwned: true };
  }

  private includesFullMetadata(options: BootedDeviceScanOptions): boolean {
    return !options.readinessOnly && !options.skipProfileEnrichment;
  }

  private physicalScanTimeout(options: BootedDeviceScanOptions, timeoutMs: number): number {
    if (options.skipProfileEnrichment) {
      return 0;
    }
    // Inventory overlays consume only emulator names; handset metadata cannot contribute.
    return options.readinessOnly && options.coalesceInventoryEnrichment ? 0 : timeoutMs;
  }

  private deviceListScanTimeout(options: BootedDeviceScanOptions): number | undefined {
    const explicit = options.deviceListTimeoutMs ?? options.timeoutMs;
    if (
      explicit !== undefined ||
      options.bypassDeviceListCache ||
      options.targetDeviceId ||
      options.skipNameEnrichment
    ) {
      return explicit;
    }
    return options.coalesceInventoryEnrichment
      ? ANDROID_INVENTORY_DEVICE_LIST_BUDGET_MS
      : undefined;
  }

  private inventoryCacheKey(
    device: BootedDevice,
    options: BootedDeviceScanOptions,
  ): string | undefined {
    if (
      !options.coalesceInventoryEnrichment ||
      options.bypassDeviceListCache ||
      options.targetDeviceId ||
      options.skipNameEnrichment ||
      device.observedAt === undefined
    ) {
      return undefined;
    }
    return `${device.deviceId}\0${device.observedAt}`;
  }

  private invalidateInventorySerials(
    devices: BootedDevice[],
    options: BootedDeviceScanOptions,
  ): void {
    if (!options.bypassDeviceListCache) {
      return;
    }
    const state = inventoryEnrichmentState(this.deps.timer());
    state.generation++;
    const prefixes = devices.map((device) => `${device.deviceId}\0`);
    for (const key of state.names.keys()) {
      if (prefixes.some((prefix) => key.startsWith(prefix))) {
        state.names.delete(key);
      }
    }
    for (const key of state.displays.keys()) {
      if (prefixes.some((prefix) => key.startsWith(prefix))) {
        state.displays.delete(key);
      }
    }
  }

  private async inventoryRunningAvdName(
    device: BootedDevice,
    {
      options,
      timeoutMs,
      signal,
    }: { options: BootedDeviceScanOptions; timeoutMs: number; signal?: AbortSignal },
  ): Promise<InventoryNameResult> {
    if (options.memoizeReadAvdNames && !options.readinessOnly) {
      return this.readRunningAvdName(device, timeoutMs, signal ?? getAbortSignal());
    }
    const key = this.inventoryCacheKey(device, options);
    if (!key) {
      return this.deps.getRunningAvdName(device, timeoutMs, signal);
    }
    const state = inventoryEnrichmentState(this.deps.timer());
    const cached = state.names.get(key);
    if (cached) {
      return cached;
    }
    const generation = state.generation;
    return state.nameFlight.run(
      key,
      () =>
        runWithAbortSignal(undefined, async () => {
          const result = await this.deps.getRunningAvdName(device, READINESS_NAME_TIMEOUT_MS);
          if (result.name && generation === state.generation) {
            state.names.set(key, result);
          }
          return result;
        }),
      signal ?? getAbortSignal(),
    );
  }

  private invalidateReadNameConnections(
    devices: BootedDevice[],
    options: BootedDeviceScanOptions,
  ): void {
    const state = inventoryEnrichmentState(this.deps.timer());
    const rows = new Map(devices.map((device) => [device.deviceId, device]));
    const completeListing = !options.devices && !options.targetDeviceId;
    // Sweep names independently: the bounded connection cache may have evicted
    // an unresolved connection while a successful name entry is still live.
    for (const key of state.readNames.keys()) {
      const [serial, transportId] = key.split("\0");
      const row = rows.get(serial);
      if (row ? transportId !== transportIdFor(row) : completeListing) {
        state.readNames.delete(key);
      }
    }
    for (const serial of state.readNameConnections.keys()) {
      const connection = state.readNameConnections.get(serial);
      const row = rows.get(serial);
      if (
        connection &&
        ((row && connection.key !== `${serial}\0${transportIdFor(row) ?? ""}`) ||
          (!row && completeListing))
      ) {
        state.readNames.delete(connection.key);
        state.readNameConnections.delete(serial);
      }
    }
  }

  private async readRunningAvdName(
    device: BootedDevice,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<InventoryNameResult> {
    signal?.throwIfAborted();
    const transportId = transportIdFor(device);
    if (!transportId) {
      return this.deps.getRunningAvdName(device, timeoutMs, signal);
    }
    const state = inventoryEnrichmentState(this.deps.timer());
    const key = `${device.deviceId}\0${transportId}`;
    let connection = state.readNameConnections.get(device.deviceId);
    if (!connection || connection.key !== key) {
      // An orphaned memo must not outlive its connection token after TTL/capacity eviction.
      state.readNames.delete(key);
      connection = { key };
      state.readNameConnections.set(device.deviceId, connection);
    }
    const cached = state.readNames.get(key);
    if (cached) {
      return cached;
    }
    const currentConnection = connection;
    // Connection objects also separate active flights after disappearance or reset:
    // a late answer from the departed connection cannot refill or join the new memo.
    return state.readNameFlight.run(
      currentConnection,
      (flightSignal) =>
        runWithAbortSignal(flightSignal, async () => {
          const result = await this.deps.getRunningAvdName(device, timeoutMs, flightSignal);
          if (
            result.name.trim() &&
            !result.diagnostic &&
            !result.consoleBusyDuringProbe &&
            !result.nameProbeTimedOut &&
            !flightSignal?.aborted &&
            state.readNameConnections.get(device.deviceId) === currentConnection
          ) {
            state.readNames.set(key, result);
            state.readNameConnections.set(device.deviceId, currentConnection);
          }
          return result;
        }),
      signal,
      { cancelWhenAllWaitersAbort: true },
    );
  }

  private async inventoryDisplays(
    device: BootedDevice,
    options: BootedDeviceScanOptions,
    signal?: AbortSignal,
  ) {
    const key = this.inventoryCacheKey(device, options);
    if (!key) {
      return readAndroidDeviceDisplays(this.deps.adbFactory().create(device), signal);
    }
    const state = inventoryEnrichmentState(this.deps.timer());
    const cached = state.displays.get(key);
    if (cached) {
      return cached.displays;
    }
    const generation = state.generation;
    const result = await state.displayFlight.run(
      key,
      () =>
        runWithAbortSignal(undefined, async () => {
          const result = await readAndroidDeviceDisplaysChecked(
            this.deps.adbFactory().create(device),
          );
          if (
            generation === state.generation &&
            !result.degraded &&
            result.outcome.kind !== "unreadable"
          ) {
            state.displays.set(key, result);
          }
          return result;
        }),
      signal ?? getAbortSignal(),
    );
    return result.displays;
  }

  /**
   * Model/ABI cache key. Physical devices key by serial; emulators also require
   * the resolved AVD name because a new AVD may reuse the same emulator serial
   * (an empty name is unresolved and never cached).
   */
  private deviceInfoCacheKey(deviceId: string, avdName?: string): string | undefined {
    if (avdName === undefined) {
      return deviceId;
    }
    return avdName ? `${deviceId}\0${avdName}` : undefined;
  }

  /**
   * Drop model/ABI entries for serials absent from a full ADB listing, so a
   * device that later reuses the serial (emulator port, TCP address) is probed
   * afresh instead of inheriting its predecessor's metadata (#11063).
   */
  private evictDepartedDeviceInfo(devices: BootedDevice[]): void {
    const present = new Set(devices.map((device) => device.deviceId));
    for (const cache of [this.modelNameCache, this.architectureCache]) {
      for (const key of [...cache.keys()]) {
        if (!present.has(key.split("\0", 1)[0]!)) {
          cache.delete(key);
        }
      }
    }
  }

  /**
   * Physical models are cached per serial; emulator models also require the
   * resolved AVD name because a new AVD may reuse the same emulator serial.
   */
  private async resolveDeviceModel(
    device: BootedDevice,
    infoTimeoutMs: number,
    skipNameEnrichment: boolean,
    { signal, avdName }: { signal?: AbortSignal; avdName?: string } = {},
  ): Promise<string | undefined> {
    const cacheKey = this.deviceInfoCacheKey(device.deviceId, avdName);
    const cachedModel = cacheKey ? this.modelNameCache.get(cacheKey) : undefined;
    if (cachedModel) {
      logger.debug(`Got model name for ${device.deviceId}: "${cachedModel}" (cached)`);
      return cachedModel;
    }
    if (skipNameEnrichment) {
      logger.debug(`Serial-only scan: not asking ${device.deviceId} for its model name`);
      return undefined;
    }
    try {
      const adbWithDevice = this.deps.adbFactory().create(device);
      const result = await adbWithDevice.executeCommand("shell getprop ro.product.model", {
        timeoutMs: infoTimeoutMs,
        noRetry: true,
        signal,
      });
      const modelName = result.stdout.trim();
      if (!modelName || modelName === "unknown") {
        logger.debug(`No model name found for ${device.deviceId}`);
        return undefined;
      }
      if (cacheKey) {
        this.modelNameCache.set(cacheKey, modelName);
      }
      logger.debug(`Got model name for ${device.deviceId}: "${modelName}"`);
      return modelName;
    } catch (error) {
      this.deps.throwIfAborted(signal);
      // A missing model is cosmetic: the serial/AVD name still identifies the
      // discovered device, so discovery continues without this metadata.
      logger.debug(`Failed to get model name for ${device.deviceId}: ${error}`);
      return undefined;
    }
  }

  async resolveFoundDeviceModel(
    foundDeviceModel: string | undefined,
    foundDeviceId: string,
    avdName: string,
    { timeoutMs, signal }: { timeoutMs: number; signal?: AbortSignal },
  ): Promise<string | undefined> {
    if (foundDeviceModel || timeoutMs <= 0) {
      return foundDeviceModel;
    }
    return (
      foundDeviceModel ??
      (await this.resolveDeviceModel(
        { name: avdName, platform: "android", deviceId: foundDeviceId },
        timeoutMs,
        false,
        { signal, avdName },
      ))
    );
  }

  foundBootedDevice(
    avdName: string,
    foundDeviceId: string,
    model: string | undefined,
  ): BootedDevice {
    return {
      name: avdName,
      platform: "android",
      deviceId: foundDeviceId,
      ...(model ? { model } : {}),
    } as BootedDevice;
  }

  async resolvedReadyAvdName(
    requestedName: string,
    deviceId: string,
    scannedName: string,
    { timeoutMs, signal }: { timeoutMs: number; signal?: AbortSignal },
  ): Promise<string> {
    if (!deviceId.startsWith("emulator-")) {
      return scannedName;
    }

    // The scan may have seen Unknown while the emulator was booting. Confirm
    // that placeholder once after readiness. A resolved scan already reports
    // the runtime AVD name, so avoid another ADB probe in that case. Use the
    // request only when both the scan and confirmation leave identity Unknown.
    const confirmedName =
      this.deps.isUnknownEmulatorName(scannedName, deviceId) && timeoutMs > 0
        ? (
            await this.deps.getRunningAvdName(
              { name: scannedName, platform: "android", deviceId },
              timeoutMs,
              signal,
            )
          ).name
        : "";
    const resolvedName =
      confirmedName ||
      (this.deps.isUnknownEmulatorName(scannedName, deviceId) ? requestedName : scannedName);
    if (
      resolvedName !== requestedName &&
      !this.deps.isUnknownEmulatorName(requestedName, deviceId)
    ) {
      const message =
        `Emulator identity mismatch: requested AVD '${requestedName}' but ` +
        `${deviceId} reports '${resolvedName}'. Select the correct AVD or serial and retry.`;
      logger.error(message);
      throw new ActionableError(message);
    }
    return resolvedName;
  }

  private async modelForBootedEmulator(
    device: BootedDevice,
    avdName: { name: string; consoleBusyDuringProbe?: boolean; nameProbeTimedOut?: boolean },
    infoTimeoutMs: number,
    { skipNameEnrichment, signal }: { skipNameEnrichment: boolean; signal?: AbortSignal },
  ): Promise<string | undefined> {
    if (avdName.consoleBusyDuringProbe) {
      // The AVD identity is unresolved, so model metadata is not worth
      // contending with the destructive console operation.
      return undefined;
    }
    return await this.resolveDeviceModel(device, infoTimeoutMs, skipNameEnrichment, {
      signal,
      avdName: avdName.name,
    });
  }

  private async resolveEmulatorArchitecture(
    device: BootedDevice,
    avdName: { name: string; consoleBusyDuringProbe?: boolean; nameProbeTimedOut?: boolean },
    infoTimeoutMs: number,
    { skipNameEnrichment, signal }: { skipNameEnrichment: boolean; signal?: AbortSignal },
  ): Promise<string | undefined> {
    if (skipNameEnrichment || avdName.consoleBusyDuringProbe || !avdName.name) {
      return undefined;
    }

    try {
      const config = await this.deps.avdConfigReader().readConfig(avdName.name);
      if (config) {
        const architecture = configuredAvdArchitecture(config, undefined);
        if (architecture) {
          return architecture;
        }
      }
    } catch (error) {
      logger.debug(`Failed to read AVD config for ${avdName.name}: ${error}`);
    }

    return this.resolvePhysicalDeviceArchitecture(device, infoTimeoutMs, skipNameEnrichment, {
      signal,
      avdName: avdName.name,
    });
  }

  private discoveredEmulatorDevice(
    device: BootedDevice,
    avdName: { name: string; consoleBusyDuringProbe?: boolean; nameProbeTimedOut?: boolean },
    model: string | undefined,
    architecture: string | undefined,
  ): BootedDevice {
    return {
      ...device,
      foreignOwned: undefined,
      name: avdName.name || this.deps.unknownEmulatorName(device.deviceId),
      platform: "android",
      deviceId: device.deviceId,
      observedAt: this.deps.observationSequence().next(),
      source: "local",
      ...(avdName.name === "" &&
        avdName.consoleBusyDuringProbe === true && {
          consoleBusyDuringProbe: avdName.consoleBusyDuringProbe,
        }),
      ...(avdName.name === "" &&
        avdName.nameProbeTimedOut === true && {
          nameProbeTimedOut: true,
        }),
      ...(model ? { model } : {}),
      ...(architecture ? { architecture } : {}),
    };
  }

  private discoveredPhysicalDevice(
    device: BootedDevice,
    model: string | undefined,
    architecture: string | undefined,
  ): BootedDevice {
    return {
      ...device,
      foreignOwned: undefined,
      name: model ?? device.deviceId,
      platform: "android",
      deviceId: device.deviceId,
      source: "local",
      ...(model ? { model } : {}),
      ...(architecture ? { architecture } : {}),
    };
  }

  /**
   * Resolve a booted device's CPU ABI from the runtime and cache it (keyed like
   * the model cache) to avoid repeated ADB calls.
   */
  private async resolvePhysicalDeviceArchitecture(
    device: BootedDevice,
    infoTimeoutMs: number,
    skipNameEnrichment: boolean,
    { signal, avdName }: { signal?: AbortSignal; avdName?: string } = {},
  ): Promise<string | undefined> {
    const cacheKey = this.deviceInfoCacheKey(device.deviceId, avdName);
    const cachedArchitecture = cacheKey ? this.architectureCache.get(cacheKey) : undefined;
    if (cachedArchitecture) {
      logger.debug(`Got CPU architecture for ${device.deviceId}: "${cachedArchitecture}" (cached)`);
      return cachedArchitecture;
    }
    if (skipNameEnrichment) {
      // This scan explicitly forbids optional runtime metadata probes.
      return undefined;
    }
    try {
      const adbWithDevice = this.deps.adbFactory().create(device);
      const result = await adbWithDevice.executeCommand("shell getprop ro.product.cpu.abi", {
        timeoutMs: infoTimeoutMs,
        noRetry: true,
        signal,
      });
      const architecture = result.stdout.trim();
      if (!architecture || architecture === "unknown") {
        logger.debug(`No CPU architecture found for ${device.deviceId}`);
        return undefined;
      }
      if (cacheKey) {
        this.architectureCache.set(cacheKey, architecture);
      }
      logger.debug(`Got CPU architecture for ${device.deviceId}: "${architecture}"`);
      return architecture;
    } catch (error) {
      this.deps.throwIfAborted(signal);
      // A device can still be described without this optional metadata.
      logger.debug(`Failed to get CPU architecture for ${device.deviceId}: ${error}`);
      return undefined;
    }
  }
}
