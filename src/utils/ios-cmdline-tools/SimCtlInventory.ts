import { SimCtlCreation } from "./SimCtlCreation";
import { isTemplateSimName } from "./SimulatorTemplateKey";
import { isIosSimulatorRuntime } from "./simulatorRuntimeFamily";
import {
  type SimCtlCatalog,
  AppleDevice,
  AppleDeviceRuntime,
  AppleDeviceType,
  normalizeIosVersion,
  pickHighestRuntime,
  isDeviceAvailable,
  SimulatorList,
  simulatorModel,
} from "./SimCtlSupport";

import { parseSimctlRuntimes } from "./simctlRuntimes";
import { parseSimctlDeviceTypes } from "./simctlDeviceTypes";

import { errorMessage } from "../describeUnknownError";
import { trackAmbient } from "../PerfContext";

import { logger } from "../logger";

import { ExecResult, ActionableError, DeviceInfo, BootedDevice } from "../../models";

import { Timer } from "../SystemTimer";
import { TTLCache } from "../cache/Cache";
import { SingleFlight } from "../cache/SingleFlight";
import { raceWithDeadline } from "../raceWithDeadline";
import type { DiscoveryObservationSequence } from "../DiscoveryObservationSequence";

import { inferIosFormFactor, isIosDuoDeviceType } from "./iosDeviceType";

import { getAbortSignal, runWithAbortSignal } from "../AbortContext";

import { iosSimulatorCapabilityInventory } from "../virtualDeviceCapabilities";
import { hostAudioSnapshot } from "../audio/defaultHostAudioProbe";

import { compareStrictNumericVersions } from "../deviceMatcher";

import { type SimulatorDeviceTypeProfileSource } from "./SimulatorDeviceTypeProfiles";
import { simulatorDeviceDisplays, type SimulatorDisplay } from "./SimulatorDisplays";
import type { DeviceDisplays } from "../../models/DisplayPanel";
import {
  isTransitionalSimulatorState,
  type TransitionalSimulator,
} from "../../models/TransitionalSimulator";
import { SimctlUnavailableError } from "./SimctlUnavailableError";

export interface SimCtlInventoryContext {
  resolveRuntimeIdentifier(requestedVersion?: string, signal?: AbortSignal): Promise<string>;
  execAsync: (
    file: string,
    args: string[],
    maxBuffer?: number,
    signal?: AbortSignal,
    env?: NodeJS.ProcessEnv,
  ) => Promise<ExecResult>;
  executeCommandArgs(args: string[], timeoutMs?: number, signal?: AbortSignal): Promise<ExecResult>;
  timer: Timer;
  hostArchitecture: string;
  enumerateDisplays(
    deviceId: string,
    timeoutMs?: number,
    signal?: AbortSignal,
  ): Promise<SimulatorDisplay[]>;
  deviceTypeProfiles: SimulatorDeviceTypeProfileSource;
  observationSequence: DiscoveryObservationSequence;
  getBootedSimulatorsChecked(
    timeoutMs?: number,
    signal?: AbortSignal,
    options?: { bypassCache?: boolean; maxCacheAgeMs?: number },
  ): Promise<BootedDevice[]>;
  getSimulatorListingChecked(
    timeoutMs?: number,
    signal?: AbortSignal,
    options?: { bypassCache?: boolean; maxCacheAgeMs?: number },
  ): Promise<{ booted: BootedDevice[]; transitional: TransitionalSimulator[] }>;
  listSimulators(timeoutMs?: number, signal?: AbortSignal): Promise<SimulatorList>;
  listSimulatorImages(
    timeoutMs?: number,
    options?: { bypassCache?: boolean; signal?: AbortSignal },
  ): Promise<DeviceInfo[]>;
  getDeviceInfo(udid: string): Promise<AppleDevice | null>;
  invalidateDeviceListCache(): void;
}
interface CatalogState {
  cache: TTLCache<string, SimCtlCatalog>;
  flight: SingleFlight<number, SimCtlCatalog>;
  generation: number;
}

export class SimCtlInventory {
  // Production clients share defaultTimer; fake timers keep independent hosts isolated.
  private static readonly catalogs = new WeakMap<Timer, CatalogState>();

  private catalogState(): CatalogState {
    let state = SimCtlInventory.catalogs.get(this.context.timer);
    if (!state) {
      state = {
        cache: new TTLCache(this.context.timer, { ttlMs: 60_000, maxEntries: 1 }),
        flight: new SingleFlight(),
        generation: 0,
      };
      SimCtlInventory.catalogs.set(this.context.timer, state);
    }
    return state;
  }

  async getCatalogChecked(signal = getAbortSignal()): Promise<SimCtlCatalog> {
    signal?.throwIfAborted();
    const state = this.catalogState();
    const cached = state.cache.get("catalog");
    if (cached) {
      return cached;
    }
    const generation = state.generation;
    return state.flight.run(
      generation,
      (flightSignal) =>
        runWithAbortSignal(undefined, async () => {
          const [runtimes, deviceTypes] = await Promise.all([
            this.getRuntimesChecked(undefined, flightSignal),
            this.getDeviceTypesChecked(flightSignal),
          ]);
          flightSignal?.throwIfAborted();
          const catalog = { runtimes, deviceTypes };
          // Invalidation fences a listing that began before a failed create.
          if (state.generation === generation) {
            state.cache.set("catalog", catalog);
          }
          return catalog;
        }),
      signal,
      { cancelWhenAllWaitersAbort: true },
    );
  }

  private invalidateCatalog(): void {
    const state = this.catalogState();
    state.generation++;
    state.cache.clear();
  }

  /** Read-only cache diagnostics; invalidation is the sole public mutation seam. */
  static deviceListSnapshots(): {
    cached: readonly DeviceInfo[] | null;
    lastGood: readonly DeviceInfo[] | null;
  } {
    return {
      cached: SimCtlInventory.deviceListCache?.devices ?? null,
      lastGood: SimCtlInventory.lastGoodDeviceList?.devices ?? null,
    };
  }

  // 30 seconds

  // Static cache for device list
  // `observedAt` is the discovery stamp taken when the listing was recorded, so a
  // cache hit replays it instead of looking newer than later evidence (#11103).
  private static deviceListCache: {
    devices: DeviceInfo[];
    timestamp: number;
    observedAt: number;
  } | null = null;

  private static lastLoggedDeviceListSignature: string | undefined;

  private static readonly DEVICE_LIST_CACHE_TTL = 5000;
  // 5 seconds
  // Last-known-good device list, retained past a failed listing so a transient
  // `simctl` error degrades to a stale-but-usable snapshot instead of throwing
  // (issue #6576), mirroring DevicectlDeviceLister.lastGood.
  private static lastGoodDeviceList: { devices: DeviceInfo[]; timestamp: number } | null = null;

  private static readonly LAST_GOOD_DEVICE_LIST_RETENTION_MS = 60_000;

  // Concurrent cold/expired-cache callers share one `simctl list devices`
  // invocation rather than each spawning their own process (issue #6576).
  private static inFlightDeviceList: Promise<DeviceInfo[]> | null = null;

  // Ceiling on the SHARED `simctl list devices` invocation behind
  // inFlightDeviceList. Deliberately NOT any individual caller's timeoutMs --
  // that would let one bounded/aborted caller cut the read short (or, before
  // this fix, extend it) for every other waiter sharing the same promise.
  // Mirrors DevicectlDeviceLister.DEVICE_LIST_TIMEOUT_MS; each waiter instead
  // races the shared result against its OWN deadline/signal (issue #6576).
  private static readonly SHARED_DEVICE_LIST_TIMEOUT_MS = 15_000;

  // Invalidation epoch. A listing started in an older epoch must not
  // repopulate the cache/last-good snapshot after a create/delete/reset.
  private static deviceListGeneration = 0;

  // Physical listing order is distinct from invalidation. Only successful
  // reads advance the recorded sequence, so a failed newer refresh does not
  // discard an older flight's usable result; once a newer read succeeds, an
  // older completion cannot overwrite it.
  private static deviceListRequestSequence = 0;

  private static recordedDeviceListRequestSequence = 0;

  private static inFlightDeviceListRequestSequence: number | null = null;
  private static readonly DISPLAY_BYPASS_REFRESH_MIN_INTERVAL_MS = 60_000;
  private static readonly simulatorDisplays = new Map<
    string,
    { lastUsedAt?: string; displays?: SimulatorDisplay[]; enumeratedAt: number }
  >();
  // Concurrent listings during a boot storm would otherwise each spawn their own
  // `simctl io enumerate` for a boot whose first read has not finished (#15214).
  private static readonly simulatorDisplayFlights = new Map<
    string,
    { lastUsedAt?: string; promise: Promise<SimulatorDisplay[]> }
  >();

  /**
   * Drop the shared device-list snapshot so the next list re-reads simctl.
   * Also drops the last-good fallback: a caller invalidating the cache knows
   * something changed (a device was created/deleted, or a test is resetting
   * state), so a subsequent transient failure must not resurrect the
   * pre-invalidation snapshot as if it were still trustworthy (issue #6576).
   *
   * Also bumps `deviceListGeneration` so an in-flight listing that was already
   * running when this invalidation fires cannot repopulate the cache with the
   * obsolete snapshot it captured before the mutation (issue #6576).
   */
  static invalidateDeviceListCache(): void {
    SimCtlInventory.lastLoggedDeviceListSignature = undefined;
    SimCtlInventory.simulatorDisplays.clear();
    SimCtlInventory.simulatorDisplayFlights.clear();
    SimCtlInventory.deviceListCache = null;
    SimCtlInventory.lastGoodDeviceList = null;
    SimCtlInventory.inFlightDeviceList = null;
    SimCtlInventory.inFlightDeviceListRequestSequence = null;
    SimCtlInventory.deviceListGeneration++;
  }

  constructor(private readonly context: SimCtlInventoryContext) {}

  /**
   * Resolve the simulator runtime identifier to target with a 3-tier fallback:
   *   1. exact version prefix (SDK "26.3" matches runtime "26.3.0")
   *   2. major.minor prefix (SDK "26.3.1" matches runtime "26.3.x")
   *   3. highest runtime in the same major (SDK 26.3 → 26.4 when 26.3 is absent)
   *
   * The identifier is looked up rather than constructed because its format
   * varies across Xcode versions (iOS-26-3 vs iOS-26-3-0).
   *
   * Candidates are ordered by numeric version components rather than string
   * comparison (so "26.10" ranks above "26.9").
   *
   * @param requestedVersion - iOS version to target; defaults to the active
   *                           Xcode iphonesimulator SDK version.
   */
  async resolveRuntimeIdentifier(requestedVersion?: string, signal?: AbortSignal): Promise<string> {
    const version = (requestedVersion ?? (await this.detectIosSdkVersion(signal))).trim();
    if (!version) {
      throw new ActionableError(
        "Could not determine an iOS version to target. Ensure Xcode is installed and " +
          "'xcrun --sdk iphonesimulator --show-sdk-version' returns a version.",
      );
    }

    const runtimes = await this.listIosRuntimes(signal);
    const majorMinor = version.split(".").slice(0, 2).join(".");
    const major = version.split(".")[0];

    const prefixes = [version, `${majorMinor}.`, `${major}.`];
    for (const prefix of prefixes) {
      const match = pickHighestRuntime(runtimes, prefix);
      if (match) {
        logger.debug(
          `[iOS] Resolved runtime ${match.identifier} for iOS ${version} (prefix "${prefix}")`,
        );
        return match.identifier;
      }
    }

    const available =
      runtimes.map((runtime) => `${runtime.name} (${runtime.version})`).join(", ") || "<none>";
    throw new ActionableError(
      `No iOS simulator runtime found for iOS ${version} (tried ${version}, ${majorMinor}.x, ${major}.x). ` +
        `Available runtimes: ${available}. Install one via Xcode > Settings > Components.`,
    );
  }

  /**
   * Resolve the newest available runtime satisfying both requested bounds.
   * Unlike SDK compatibility resolution, bounds are strict predicates and
   * never fall back to another version in the same major.
   */
  async resolveRuntimeIdentifiersForBounds(
    minVersion?: string,
    maxVersion?: string,
    signal?: AbortSignal,
  ): Promise<string[]> {
    if (minVersion === undefined && maxVersion === undefined) {
      return [await this.context.resolveRuntimeIdentifier(undefined, signal)];
    }
    const min = this.parseRequestedRuntimeBound(minVersion, "min");
    const max = this.parseRequestedRuntimeBound(maxVersion, "max");
    const runtimes = await this.listIosRuntimes(signal);
    const matching = runtimes
      .filter(
        (runtime) => !Number.isNaN(compareStrictNumericVersions(runtime.version, runtime.version)),
      )
      .filter(({ version }) => {
        if (min && compareStrictNumericVersions(version, min) < 0) {
          return false;
        }
        return !max || compareStrictNumericVersions(version, max) <= 0;
      })
      .sort((left, right) => compareStrictNumericVersions(right.version, left.version));

    if (matching.length > 0) {
      logger.debug(
        `[iOS] Resolved ${matching.length} runtime candidate(s) within requested range ` +
          `(min=${minVersion ?? "any"}, max=${maxVersion ?? "any"})`,
      );
      return matching.map((runtime) => runtime.identifier);
    }

    const available = runtimes.map((runtime) => runtime.name).join(", ") || "<none>";
    throw new ActionableError(
      "No available iOS simulator runtime matches the requested range " +
        `(min=${minVersion ?? "any"}, max=${maxVersion ?? "any"}). ` +
        `Available runtimes: ${available}. Install one via Xcode > Settings > Components.`,
    );
  }

  parseRequestedRuntimeBound(version: string | undefined, edge: "min" | "max"): string | undefined {
    if (version === undefined) {
      return undefined;
    }
    const trimmed = version.trim();
    if (Number.isNaN(compareStrictNumericVersions(trimmed, trimmed))) {
      throw new ActionableError(
        `Invalid iOS ${edge}OsVersion '${version}'. Pass a numeric version such as '18.2'.`,
      );
    }
    return trimmed;
  }

  /** Read the active Xcode iphonesimulator SDK version. */
  async detectIosSdkVersion(signal?: AbortSignal): Promise<string> {
    try {
      // Direct xcrun (not a `simctl` subcommand), so it bypasses the
      // executeCommandArgv funnel; give it its own ambient leaf (see PerfContext).
      const result = await trackAmbient("xcrun --show-sdk-version", () =>
        this.context.execAsync(
          "xcrun",
          ["--sdk", "iphonesimulator", "--show-sdk-version"],
          undefined,
          signal,
        ),
      );
      return result.stdout.trim();
    } catch (error) {
      throw new ActionableError(
        "Could not detect the iOS SDK version from Xcode " +
          `('xcrun --sdk iphonesimulator --show-sdk-version' failed: ${errorMessage(error)}). ` +
          "Ensure Xcode and its command line tools are installed and selected via xcode-select.",
      );
    }
  }

  /** List installed iOS simulator runtimes that are actually available. */
  async listIosRuntimes(signal?: AbortSignal): Promise<AppleDeviceRuntime[]> {
    const result = await this.context.executeCommandArgs(
      ["list", "runtimes", "iOS", "--json"],
      undefined,
      signal,
    );
    try {
      return parseSimctlRuntimes(result.stdout, "not-unavailable");
    } catch (error) {
      throw new ActionableError(
        "Failed to parse iOS simulator runtimes from 'xcrun simctl list runtimes iOS --json': " +
          `${errorMessage(error)}. ` +
          `stdout (first 300 chars): ${result.stdout.trim().slice(0, 300) || "<empty>"}.`,
      );
    }
  }

  /**
   * Get the list of available (booted and shutdown) simulator UDIDs
   * @returns Promise with an array of device UDIDs
   */
  async listSimulatorImages(
    timeoutMs?: number,
    options: { bypassCache?: boolean; signal?: AbortSignal } = {},
  ): Promise<DeviceInfo[]> {
    // An already-aborted caller must fail even on a cache hit below -- a cached
    // "success" for a request the caller has already given up on is silently
    // wrong (issue #6576).
    const signal = options.signal ?? getAbortSignal();
    signal?.throwIfAborted();

    // Check cache first
    if (!options.bypassCache && SimCtlInventory.deviceListCache) {
      const cacheAge = this.context.timer.now() - SimCtlInventory.deviceListCache.timestamp;
      if (cacheAge < SimCtlInventory.DEVICE_LIST_CACHE_TTL) {
        logger.info(`Getting list of iOS simulators (cached, age: ${cacheAge}ms)`);
        return SimCtlInventory.deviceListCache.devices;
      }
    }

    // A caller that explicitly bypassed the cache wants a read that is
    // provably fresh (e.g. boot verification via readSimulatorState), so it
    // must not join an in-flight request some other caller's options started
    // — that request's failure-fallback behavior is not this caller's to
    // inherit. Run it standalone instead of sharing the coalescing slot below.
    if (options.bypassCache) {
      return this.runListSimulatorImages(timeoutMs, { bypassCache: true, signal });
    }

    return this.raceOwnDeadline(this.runListSimulatorImages(undefined, {}), timeoutMs, signal);
  }

  sharedDeviceList(): Promise<DeviceInfo[]> {
    if (!SimCtlInventory.inFlightDeviceList) {
      const generation = SimCtlInventory.deviceListGeneration;
      const requestSequence = ++SimCtlInventory.deviceListRequestSequence;
      const flight = runWithAbortSignal(undefined, () =>
        this.listDevicesForBootedCheck(SimCtlInventory.SHARED_DEVICE_LIST_TIMEOUT_MS, undefined),
      )
        .then((devices) => {
          this.recordDeviceListSnapshot(devices, generation, requestSequence);
          return devices;
        })
        .finally(() => {
          if (SimCtlInventory.inFlightDeviceList === flight) {
            SimCtlInventory.inFlightDeviceList = null;
            SimCtlInventory.inFlightDeviceListRequestSequence = null;
          }
        });
      SimCtlInventory.inFlightDeviceList = flight;
      SimCtlInventory.inFlightDeviceListRequestSequence = requestSequence;
    }
    return SimCtlInventory.inFlightDeviceList;
  }

  /**
   * Await a listing shared with other callers (`SimCtlClient.inFlightDeviceList`)
   * but bound ONLY by THIS caller's own timeout/signal. Losing that race must
   * not cancel the shared fetch or affect any other waiter racing the same
   * promise (issue #6576) -- unlike `executeCommandArgv`'s timeout, this never
   * aborts the underlying process, since other callers may still need it.
   */
  async raceOwnDeadline(
    shared: Promise<DeviceInfo[]>,
    timeoutMs: number | undefined,
    signal: AbortSignal | undefined,
  ): Promise<DeviceInfo[]> {
    signal?.throwIfAborted();
    if (timeoutMs === undefined && !signal) {
      return shared;
    }

    return await raceWithDeadline(shared, {
      timer: this.context.timer,
      timeoutMs,
      signal,
      label: "iOS simulator listing",
      timeoutError: () =>
        new Error(`Timed out waiting for iOS simulator listing after ${timeoutMs}ms`),
    });
  }

  /** Map a raw `simctl list devices --json` payload into sorted {@link DeviceInfo} records. */
  async mapSimulatorListToDeviceInfos(
    simulatorList: SimulatorList,
    deadlineMs: number | undefined,
    signal: AbortSignal | undefined,
  ): Promise<DeviceInfo[]> {
    // Watch, Apple TV and Vision Pro simulators share this listing but are not iOS devices
    // (#14901, #15885), so only iOS runtimes are kept.
    const iosRuntimes = Object.entries(simulatorList.devices).filter(([runtimeId]) =>
      isIosSimulatorRuntime(runtimeId),
    );
    const listedDevices = iosRuntimes.flatMap(([, runtimeDevices]) => runtimeDevices);
    const signature = JSON.stringify(
      listedDevices
        .map(({ udid, state, isAvailable, name }): [string, string, boolean, string] => [
          udid,
          state,
          isAvailable,
          name,
        ])
        .sort(([a], [b]) => a.localeCompare(b)),
    );
    const changed = signature !== SimCtlInventory.lastLoggedDeviceListSignature;
    if (!changed) {
      logger.debug(`iOS simulator listing unchanged (${listedDevices.length} simulators)`);
    }
    this.retireStoppedSimulatorDisplays(simulatorList);
    const devices = await Promise.all(
      iosRuntimes.flatMap(([runtimeId, runtimeDevices]) =>
        runtimeDevices
          .filter((device) => !isTemplateSimName(device.name))
          .map(async (device): Promise<DeviceInfo> => {
            if (changed) {
              logger.debug(
                `Found iOS simulator: ${device.name} (${device.udid}) state=${device.state}`,
              );
            }
            const iosVersion = normalizeIosVersion(runtimeId, device.os_version);
            const [profile, displays] = await Promise.all([
              device.deviceTypeIdentifier
                ? this.profileForDeviceType(device.deviceTypeIdentifier, deadlineMs, signal)
                : Promise.resolve(null),
              this.displaysForBootedSimulator(device, deadlineMs, signal),
            ]);
            const deviceDisplays = simulatorDeviceDisplays(displays, device.deviceTypeIdentifier);
            return {
              name: device.name,
              platform: "ios",
              deviceId: device.udid,
              isRunning: device.state === "Booted",
              state: device.state,
              isAvailable: device.isAvailable,
              availabilityError: device.availabilityError,
              iosVersion,
              osVersion: iosVersion,
              formFactor: inferIosFormFactor(device.deviceTypeIdentifier),
              deviceType: device.deviceTypeIdentifier,
              runtimeId,
              runtime: runtimeId,
              model: simulatorModel(device.model, profile),
              // Simulator processes execute on the host architecture; this does not
              // require another simctl invocation.
              architecture: this.context.hostArchitecture,
              screenWidth: profile?.pixelWidth ?? undefined,
              screenHeight: profile?.pixelHeight ?? undefined,
              screenDensity: profile?.dpi ?? undefined,
              ...(deviceDisplays ? { displays: deviceDisplays } : {}),
              capabilityInventory: iosSimulatorCapabilityInventory({
                isAvailable: device.isAvailable,
                availabilityError: device.availabilityError,
                runtime: runtimeId,
                hostAudio: hostAudioSnapshot(),
              }),
            } as DeviceInfo;
          }),
      ),
    );
    SimCtlInventory.lastLoggedDeviceListSignature = signature;
    devices.sort((a, b) => (a.deviceId || "").localeCompare(b.deviceId || ""));
    return devices;
  }

  private retireStoppedSimulatorDisplays(simulatorList: SimulatorList): void {
    const bootedIds = new Set(
      Object.values(simulatorList.devices).flatMap((devices) =>
        devices.filter((device) => device.state === "Booted").map((device) => device.udid),
      ),
    );
    for (const udid of SimCtlInventory.simulatorDisplays.keys()) {
      if (!bootedIds.has(udid)) {
        SimCtlInventory.simulatorDisplays.delete(udid);
        SimCtlInventory.simulatorDisplayFlights.delete(udid);
      }
    }
  }

  async displaysForBootedSimulator(
    device: AppleDevice,
    deadlineMs: number | undefined,
    signal: AbortSignal | undefined,
  ): Promise<SimulatorDisplay[]> {
    if (device.state !== "Booted") {
      SimCtlInventory.simulatorDisplays.delete(device.udid);
      SimCtlInventory.simulatorDisplayFlights.delete(device.udid);
      return [];
    }
    // Duo panels can change with fold state without a new boot timestamp.
    const cacheable = !isIosDuoDeviceType(device.deviceTypeIdentifier);
    const cached = SimCtlInventory.simulatorDisplays.get(device.udid);
    if (cacheable && cached?.displays && cached.lastUsedAt === device.lastUsedAt) {
      return cached.displays;
    }
    const remainingMs =
      deadlineMs === undefined ? undefined : deadlineMs - this.context.timer.now();
    if (remainingMs !== undefined && remainingMs <= 0) {
      return [];
    }
    const inFlight = SimCtlInventory.simulatorDisplayFlights.get(device.udid);
    if (inFlight && inFlight.lastUsedAt === device.lastUsedAt) {
      return this.awaitDisplayFlight(inFlight.promise, remainingMs, signal);
    }
    // The starter's signal and remaining budget bound the command; a joined listing whose
    // starter was cancelled degrades to no displays (optional enrichment) and the next
    // listing retries. Each waiter bounds only its own wait.
    const flight: { lastUsedAt?: string; promise: Promise<SimulatorDisplay[]> } = {
      lastUsedAt: device.lastUsedAt,
      promise: this.enumerateBootedSimulatorDisplays(
        device,
        remainingMs,
        signal,
        cacheable,
      ).finally(() => {
        if (SimCtlInventory.simulatorDisplayFlights.get(device.udid) === flight) {
          SimCtlInventory.simulatorDisplayFlights.delete(device.udid);
        }
      }),
    };
    SimCtlInventory.simulatorDisplayFlights.set(device.udid, flight);
    return this.awaitDisplayFlight(flight.promise, remainingMs, signal);
  }

  /** Bound one waiter on a shared display read; leaving never cancels the read for others. */
  private async awaitDisplayFlight(
    flight: Promise<SimulatorDisplay[]>,
    remainingMs: number | undefined,
    signal: AbortSignal | undefined,
  ): Promise<SimulatorDisplay[]> {
    try {
      return await raceWithDeadline(flight, {
        timer: this.context.timer,
        timeoutMs: remainingMs,
        signal,
        label: "iOS simulator display enumeration",
      });
    } catch (error) {
      if (signal?.aborted) {
        throw error;
      }
      // Optional display enrichment cannot make the device inventory unavailable.
      logger.debug(`Display enrichment wait ended early: ${errorMessage(error)}`);
      return [];
    }
  }

  private async enumerateBootedSimulatorDisplays(
    device: AppleDevice,
    timeoutMs: number | undefined,
    signal: AbortSignal | undefined,
    cacheable: boolean,
  ): Promise<SimulatorDisplay[]> {
    const entry: { lastUsedAt?: string; displays?: SimulatorDisplay[]; enumeratedAt: number } = {
      lastUsedAt: device.lastUsedAt,
      enumeratedAt: this.context.timer.now(),
    };
    SimCtlInventory.simulatorDisplays.set(device.udid, entry);
    try {
      const displays = await this.context.enumerateDisplays(device.udid, timeoutMs, signal);
      // Empty startup reads must be retried on the next listing.
      // An invalidation or a newer incarnation must not be overwritten by this read.
      if (
        cacheable &&
        displays.length > 0 &&
        SimCtlInventory.simulatorDisplays.get(device.udid) === entry
      ) {
        entry.displays = displays;
      }
      return displays;
    } catch (error) {
      if (signal?.aborted) {
        throw error;
      }
      // Optional display enrichment cannot make the device inventory unavailable.
      logger.debug(
        `Failed to enumerate simulator displays for ${device.udid}: ${errorMessage(error)}`,
      );
      return [];
    }
  }

  async profileForDeviceType(
    deviceTypeIdentifier: string,
    deadlineMs: number | undefined,
    signal: AbortSignal | undefined,
  ): Promise<Awaited<ReturnType<SimulatorDeviceTypeProfileSource["profileFor"]>>> {
    const remainingMs =
      deadlineMs === undefined ? undefined : deadlineMs - this.context.timer.now();
    if (remainingMs !== undefined && remainingMs <= 0) {
      return null;
    }
    if (remainingMs === undefined && signal === undefined) {
      return this.context.deviceTypeProfiles.profileFor(deviceTypeIdentifier);
    }
    // The remaining budget bounds only this caller's wait (the race below); the shared,
    // memoizing source gets the caller's signal but its own default timeout, so a
    // near-deadline listing cannot poison the profile cache with a transient timeout.
    const profile = this.context.deviceTypeProfiles.profileFor(deviceTypeIdentifier, { signal });
    try {
      return await this.raceWithDeadlineAndAbort(profile, remainingMs, signal);
    } catch (error) {
      if (signal?.aborted) {
        throw error;
      }
      // Display dimensions are optional best-effort enrichment; a bounded
      // profile lookup must not fail the simulator listing.
      logger.debug(`Failed to enrich iOS simulator display dimensions: ${errorMessage(error)}`);
      return null;
    }
  }

  /** Race an optional lookup against the remaining budget and the caller's abort signal. */
  async raceWithDeadlineAndAbort<T>(
    operation: Promise<T>,
    remainingMs: number | undefined,
    signal: AbortSignal | undefined,
  ): Promise<T> {
    return await raceWithDeadline(operation, {
      timer: this.context.timer,
      timeoutMs: remainingMs,
      signal,
      label: "iOS simulator device type profile",
      timeoutError: () => new Error("Timed out reading iOS simulator device type profile"),
    });
  }

  /** Write a successful physical listing unless invalidation or a newer success superseded it. */
  recordDeviceListSnapshot(
    devices: DeviceInfo[],
    generation: number,
    requestSequence: number,
  ): boolean {
    if (
      SimCtlInventory.deviceListGeneration !== generation ||
      requestSequence < SimCtlInventory.recordedDeviceListRequestSequence
    ) {
      return false;
    }
    const timestamp = this.context.timer.now();
    SimCtlInventory.deviceListCache = devices.length
      ? { devices, timestamp, observedAt: this.context.observationSequence.next() }
      : null;
    SimCtlInventory.lastGoodDeviceList = { devices, timestamp };
    SimCtlInventory.recordedDeviceListRequestSequence = requestSequence;
    return true;
  }

  async runListSimulatorImages(
    timeoutMs: number | undefined,
    options: { bypassCache?: boolean; signal?: AbortSignal },
  ): Promise<DeviceInfo[]> {
    logger.debug("Getting list of iOS simulators");
    const generation = SimCtlInventory.deviceListGeneration;
    const requestSequence = options.bypassCache
      ? ++SimCtlInventory.deviceListRequestSequence
      : undefined;

    try {
      const devices = options.bypassCache
        ? await this.listDevicesForBootedCheck(timeoutMs, options.signal, true)
        : await this.sharedDeviceList();
      if (
        requestSequence !== undefined &&
        this.recordDeviceListSnapshot(devices, generation, requestSequence) &&
        SimCtlInventory.inFlightDeviceListRequestSequence !== null &&
        SimCtlInventory.inFlightDeviceListRequestSequence < requestSequence
      ) {
        SimCtlInventory.inFlightDeviceList = null;
        SimCtlInventory.inFlightDeviceListRequestSequence = null;
      }
      return devices;
    } catch (error) {
      options.signal?.throwIfAborted();
      const detail = errorMessage(error);

      // A caller that explicitly requested a fresh read (e.g. boot
      // verification via readSimulatorState) must never be handed a stale
      // snapshot in place of the failure it asked to observe. Everyone else
      // gets the last-good snapshot within its retention window, mirroring
      // DevicectlDeviceLister.lastGood (issue #6576).
      const lastGood = SimCtlInventory.lastGoodDeviceList;
      if (
        !options.bypassCache &&
        lastGood &&
        this.context.timer.now() - lastGood.timestamp <
          SimCtlInventory.LAST_GOOD_DEVICE_LIST_RETENTION_MS
      ) {
        logger.warn(
          `Failed to get iOS devices: ${detail}. Falling back to last-good simulator list (age: ${this.context.timer.now() - lastGood.timestamp}ms).`,
        );
        return lastGood.devices;
      }

      logger.warn(`Failed to get iOS devices: ${detail}`);
      const message = `Failed to list iOS simulator devices: ${detail}`;
      const listingError = (): ActionableError =>
        error instanceof SimctlUnavailableError
          ? new SimctlUnavailableError(message)
          : new ActionableError(message);
      throw listingError();
    }
  }

  /**
   * Get the list of booted simulator UDIDs
   * @returns Promise with an array of booted device UDIDs
   */
  async getBootedSimulators(timeoutMs?: number, signal?: AbortSignal): Promise<BootedDevice[]> {
    try {
      return await this.context.getBootedSimulatorsChecked(timeoutMs, signal);
    } catch (error) {
      (signal ?? getAbortSignal())?.throwIfAborted();
      logger.debug(`Failed to get booted iOS devices: ${error}`);
      return [];
    }
  }

  /**
   * Like {@link getBootedSimulators} but rethrows discovery failures instead of
   * swallowing them into an empty list. Callers that must distinguish "no
   * simulators are booted" from "simctl discovery failed" should use this.
   *
   * Reuses fresh cached discovery or the shared raw listing. Each waiter retains
   * its own cancellation/deadline, and checked discovery propagates raw errors
   * instead of returning the UI listing's last-good fallback.
   */
  async getBootedSimulatorsChecked(
    timeoutMs?: number,
    signal?: AbortSignal,
    options: { bypassCache?: boolean; maxCacheAgeMs?: number } = {},
  ): Promise<BootedDevice[]> {
    return (await this.context.getSimulatorListingChecked(timeoutMs, signal, options)).booted;
  }

  /**
   * One checked listing read, split into the booted simulators and the ones `simctl` reports
   * `Booting` or `Shutting Down`. The transitional ones are omitted from booted discovery but a
   * session that holds one must still see it on every inventory surface (#11573).
   */
  async getSimulatorListingChecked(
    timeoutMs?: number,
    signal?: AbortSignal,
    options: { bypassCache?: boolean; maxCacheAgeMs?: number } = {},
  ): Promise<{ booted: BootedDevice[]; transitional: TransitionalSimulator[] }> {
    // An already-aborted caller must fail even on a cache hit below -- a cached
    // "success" for a request the caller has already given up on is silently
    // wrong (issue #6576).
    signal ??= getAbortSignal();
    signal?.throwIfAborted();
    const cached = SimCtlInventory.deviceListCache;
    const devices =
      !options.bypassCache &&
      cached &&
      this.context.timer.now() - cached.timestamp <
        (options.maxCacheAgeMs ?? SimCtlInventory.DEVICE_LIST_CACHE_TTL)
        ? cached.devices
        : options.bypassCache
          ? await this.listDevicesForBootedCheck(timeoutMs, signal, true)
          : await this.raceOwnDeadline(this.sharedDeviceList(), timeoutMs, signal);
    // A listing served from (or just recorded into) the cache keeps its recorded
    // stamp; only an unrecorded read is a new observation.
    const recorded = SimCtlInventory.deviceListCache;
    const observedAt =
      recorded?.devices === devices ? recorded.observedAt : this.context.observationSequence.next();

    const listed = devices.filter((device) => isDeviceAvailable(device) && device.deviceId);
    const byDeviceId = (a: BootedDevice, b: BootedDevice) => a.deviceId.localeCompare(b.deviceId);
    const toBooted = (device: DeviceInfo): BootedDevice =>
      ({
        name: device.name,
        platform: "ios",
        deviceId: device.deviceId,
        observedAt,
        iosVersion: device.iosVersion,
        osVersion: device.osVersion,
        formFactor: device.formFactor,
        runtimeId: device.runtimeId,
        runtime: device.runtime,
        deviceType: device.deviceType,
        model: device.model,
        architecture: device.architecture,
        displays: device.displays,
      }) as BootedDevice;
    return {
      booted: listed
        .filter((device) => device.state === "Booted")
        .map(toBooted)
        .sort(byDeviceId),
      transitional: listed
        .flatMap((device) =>
          isTransitionalSimulatorState(device.state)
            ? [{ device: toBooted(device), state: device.state }]
            : [],
        )
        .sort((a, b) => byDeviceId(a.device, b.device)),
    };
  }

  /** Cold-cache path for {@link getBootedSimulatorsChecked}: the raw discovery primitive. */
  async listDevicesForBootedCheck(
    timeoutMs: number | undefined,
    signal: AbortSignal | undefined,
    refreshDisplays = false,
  ): Promise<DeviceInfo[]> {
    if (refreshDisplays) {
      const now = this.context.timer.now();
      for (const [udid, entry] of SimCtlInventory.simulatorDisplays) {
        if (now - entry.enumeratedAt >= SimCtlInventory.DISPLAY_BYPASS_REFRESH_MIN_INTERVAL_MS) {
          SimCtlInventory.simulatorDisplays.delete(udid);
        }
      }
    }
    const deadlineMs = timeoutMs === undefined ? undefined : this.context.timer.now() + timeoutMs;
    // Start optional static metadata alongside the raw list, without making it a readiness gate.
    void this.context.deviceTypeProfiles.prepare?.();
    const simulatorList = await this.context.listSimulators(timeoutMs, signal);
    return this.mapSimulatorListToDeviceInfos(simulatorList, deadlineMs, signal);
  }

  /**
   * Get device information by UDID
   * @param udid - Device UDID
   * @returns Promise with device information or null if not found
   */
  async getDeviceInfo(udid: string): Promise<AppleDevice | null> {
    try {
      // Routes through listSimulatorImages so this shares the cached/coalesced
      // listing instead of always spawning a fresh `simctl` process (issue #6576).
      const device = (await this.context.listSimulatorImages()).find((d) => d.deviceId === udid);
      if (device) {
        return {
          udid: device.deviceId ?? udid,
          name: device.name,
          state: device.state ?? "",
          isAvailable: device.isAvailable ?? false,
          availabilityError: device.availabilityError,
          deviceTypeIdentifier: device.deviceType,
          runtime: device.runtime,
          model: device.model,
          os_version: device.osVersion,
          architecture: device.architecture,
        };
      }

      return null;
    } catch (error) {
      getAbortSignal()?.throwIfAborted();
      logger.warn(`Failed to get iOS device info for ${udid}: ${error}`);
      return null;
    }
  }

  /** Read the physical screens of one booted simulator without enumerating every device. */
  async readDeviceDisplays(
    udid: string,
    signal?: AbortSignal,
  ): Promise<DeviceDisplays | undefined> {
    signal?.throwIfAborted();
    const device = await this.context.getDeviceInfo(udid);
    signal?.throwIfAborted();
    if (!device) {
      throw new Error(`Unable to read display inventory: simulator ${udid} was not found`);
    }
    if (device.state !== "Booted") {
      return undefined;
    }
    const displays = await this.context.enumerateDisplays(udid, 2_000, signal);
    return simulatorDeviceDisplays(displays, device.deviceTypeIdentifier);
  }

  /**
   * Get available device types (iPhone models, iPad models, etc.)
   * @returns Promise with array of device types
   */
  async getDeviceTypes(signal?: AbortSignal): Promise<AppleDeviceType[]> {
    const result = await this.context.executeCommandArgs(
      ["list", "devicetypes", "--json"],
      undefined,
      signal,
    );
    try {
      return parseSimctlDeviceTypes(result.stdout);
    } catch (error) {
      logger.warn(`Failed to parse device types from simctl: ${error}`);
      return [];
    }
  }

  /** Get device types and preserve malformed simctl output as an error. */
  async getDeviceTypesChecked(signal?: AbortSignal): Promise<AppleDeviceType[]> {
    const result = await this.context.executeCommandArgs(
      ["list", "devicetypes", "--json"],
      undefined,
      signal,
    );
    return parseSimctlDeviceTypes(result.stdout);
  }

  /**
   * Get available iOS runtimes
   * @returns Promise with array of runtimes
   */
  async getRuntimes(timeoutMs?: number, signal?: AbortSignal): Promise<AppleDeviceRuntime[]> {
    const result = await this.context.executeCommandArgs(
      ["list", "runtimes", "--json"],
      timeoutMs,
      signal,
    );
    try {
      return parseSimctlRuntimes(result.stdout, "available");
    } catch (error) {
      logger.warn(`Failed to parse runtimes from simctl: ${error}`);
      return [];
    }
  }

  /** Get available runtimes and preserve malformed simctl output as an error. */
  async getRuntimesChecked(
    timeoutMs?: number,
    signal?: AbortSignal,
  ): Promise<AppleDeviceRuntime[]> {
    const result = await this.context.executeCommandArgs(
      ["list", "runtimes", "--json"],
      timeoutMs,
      signal,
    );
    return parseSimctlRuntimes(result.stdout);
  }

  /** Clone without changing argv boundaries; every outcome invalidates inventory. */
  cloneSimulator(sourceUdid: string, name: string, signal?: AbortSignal): Promise<string> {
    return new SimCtlCreation(this.context, () => this.invalidateCatalog()).cloneSimulator(
      sourceUdid,
      name,
      signal,
    );
  }
  createSimulator(
    name: string,
    deviceType: string,
    runtime: string,
    signal?: AbortSignal,
  ): Promise<string> {
    return new SimCtlCreation(this.context, () => this.invalidateCatalog()).createSimulator(
      name,
      deviceType,
      runtime,
      signal,
    );
  }
}
