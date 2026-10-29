import { didSourceSucceedForDevice, discoverySourceFor } from "../utils/discoverySource";
import type { BootedDevice, Platform } from "../models";
import type {
  BootedDeviceDiscovery,
  BootedDeviceDiscoveryOptions,
  MultiPlatformDeviceManager,
} from "../devices/deviceUtils";
import { transitionalHeldSimulators } from "./adbOfflineHeldDevices";
import type { Session } from "./sessionManager";
import {
  interruptVideoRecording,
  type listActiveVideoRecordings,
  stopVideoRecordingUnattended,
} from "./videoRecordingManager";
import { AndroidOfflineProbeError } from "../utils/android-cmdline-tools/AndroidEmulatorClient";
import { isAndroidTransportAddressSerial } from "../utils/androidSerial";
import { errorMessage } from "../utils/describeUnknownError";
import { logger } from "../utils/logger";
import { raceWithDeadline } from "../utils/raceWithDeadline";
import type { Timer } from "../utils/SystemTimer";
import {
  type DisconnectMonitorEvaluation,
  isTransitionalAdbState,
  OFFLINE_DEVICE_DISCONNECT_BUDGET_MS,
  recordingCandidateIncarnations,
  selectTransitionalDeviceIds,
} from "./disconnectMonitor";
import type { DevicePool, PooledDevice } from "./devicePool";
import { MISSING_DEVICE_MISS_THRESHOLD } from "./missingDeviceLiveness";

/**
 * The stateless half of the device-disconnect monitor, split out of daemon.ts (#11808): discovery
 * reconciliation, the listed-state probe, candidate and recording collection, miss logging and the
 * recording stop at disconnect. Every function reads the daemon only through the narrow port types
 * below, so each is unit-testable with fakes; the miss maps and the tick itself stay on `Daemon`.
 */

// Reuse pool refresh snapshots to reduce simctl cost; held simulator loss can wait up to 15 seconds.
// Missing devices still require a fresh confirmation before their absence counts.
export const MONITOR_IOS_LIST_MAX_AGE_MS = 15_000;

export const DEVICE_DISCONNECT_MISS_THRESHOLD = MISSING_DEVICE_MISS_THRESHOLD;
// Retain plan-time evidence while requiring two inactive observations before cleanup.
export const PLAN_DEVICE_DISCONNECT_MISS_CAP = DEVICE_DISCONNECT_MISS_THRESHOLD - 2;
// How long device-disconnect cleanup waits for a recording's stop before releasing the device.
// An iOS recording started with `resolution` is re-encoded by ffmpeg on stop, which an
// unattended stop bounds by up to 10 minutes; the device and its session must not wait that
// long. This is the stream-copy post-process budget (and the former fixed bound). The stop
// keeps running in the background under its own unattended ceiling.
export const DISCONNECT_RECORDING_STOP_WAIT_MS = 60_000;

/** The active-recording fields the collectors read; the real listing satisfies it. */
type ActiveRecordings = readonly Pick<
  Awaited<ReturnType<typeof listActiveVideoRecordings>>[number],
  "deviceId" | "platform" | "recordingId"
>[];

/** The pool surface discovery reconciliation and monitor-time alias mapping use. */
export type DeviceLossDiscoveryPool = Pick<
  DevicePool,
  | "getAllDevices"
  | "getAndroidTransportAliases"
  | "mapAndroidDiscovery"
  | "normalizeAndroidDiscovery"
  | "reconcileDiscoveryObservation"
>;

function needsFreshTransitionalSimulatorRead(
  discovery: BootedDeviceDiscovery,
  iosDeviceListMaxAgeMs: number | undefined,
): boolean {
  return iosDeviceListMaxAgeMs !== undefined && (discovery.transitionalSimulators?.length ?? 0) > 0;
}

export async function discoverAndReconcile(
  devicePool: DeviceLossDiscoveryPool,
  deviceManager: Pick<MultiPlatformDeviceManager, "getBootedDevicesDetailed">,
  {
    isPlanDevice = () => false,
    platform = "either",
    bypassAndroidDeviceListCache = false,
    heldDevices = [],
    iosDeviceListMaxAgeMs,
  }: {
    iosDeviceListMaxAgeMs?: number;
    isPlanDevice?: (deviceId: string) => boolean;
    heldDevices?: readonly { platform: Platform; assignedDevice: string }[];
    platform?: Parameters<MultiPlatformDeviceManager["getBootedDevicesDetailed"]>[0];
    bypassAndroidDeviceListCache?: boolean;
  },
) {
  const trackedDevices = [
    ...devicePool.getAllDevices().map((device) => ({ platform: device.platform, id: device.id })),
    ...heldDevices.map((device) => ({ platform: device.platform, id: device.assignedDevice })),
  ];
  const options = {
    bypassAndroidDeviceListCache,
    skipAndroidProfileEnrichment: true,
    // Pooled watches need their own sweep, on the first read and the confirmation re-read alike.
    ...(platform === "either" ? { includeWatchOs: true } : {}),
    // An unpooled held device still needs liveness evidence from its own source.
    skipPhysicalIosDiscovery: !trackedDevices.some(
      (device) => discoverySourceFor(device.platform, device.id) === "ios-physical",
    ),
  };
  const read = async (readOptions: BootedDeviceDiscoveryOptions) => {
    const observation = await deviceManager.getBootedDevicesDetailed(platform, readOptions);
    observation.devices = await mapMonitorAndroidDiscovery(devicePool, observation.devices);
    return observation;
  };
  let discovery = await read({
    ...options,
    ...(iosDeviceListMaxAgeMs === undefined ? {} : { iosDeviceListMaxAgeMs }),
  });
  const refreshTransitionalSimulators = needsFreshTransitionalSimulatorRead(
    discovery,
    iosDeviceListMaxAgeMs,
  );
  const present = new Set(discovery.devices.map((device) => device.deviceId));
  const missingDevices = trackedDevices.filter(
    (device) => !isPlanDevice(device.id) && !present.has(device.id),
  );
  if (
    refreshTransitionalSimulators ||
    missingDevices.some(
      (device) =>
        didSourceSucceedForDevice(discovery, device.platform, device.id) &&
        (device.platform === "ios" || !bypassAndroidDeviceListCache),
    )
  ) {
    // Plan-time misses are capped below confirmation; its own loss check already reads fresh.
    // Transitional snapshots read with an extended max age also need fresh state.
    // Otherwise only the fresh confirmation reaches reconciliation and miss counting. Healthy/
    // idle sweeps keep the cheap cached path; a failed confirmation supplies no absence evidence.
    discovery = await read({
      ...options,
      bypassAndroidDeviceListCache:
        bypassAndroidDeviceListCache ||
        missingDevices.some((device) => device.platform === "android"),
      bypassIosDeviceListCache:
        refreshTransitionalSimulators ||
        missingDevices.some(
          (device) => discoverySourceFor(device.platform, device.id) === "ios-simulator",
        ),
      bypassPhysicalIosDeviceListCache: missingDevices.some(
        (device) => discoverySourceFor(device.platform, device.id) === "ios-physical",
      ),
    });
  }
  // Reconciliation can quarantine identity and cancel in-flight work. Only
  // plan-owned observations stay presence-only during allocation/restarts.
  const observations = discovery.devices.filter((device) => !isPlanDevice(device.deviceId));
  if (observations.length > 0 || trackedDevices.some((device) => !isPlanDevice(device.id))) {
    await devicePool.reconcileDiscoveryObservation(observations, "disconnect-monitor", {
      settleMembership: true,
    });
  }
  return discovery;
}

/**
 * Monitor ticks only map known transports. A wireless adb port change shows
 * up as an unknown `host:port` row while the pooled transport goes missing;
 * probe-and-fold it (ro.serialno + boot_id) before that counts as a miss, or
 * the held session is released after three ticks (#11133).
 */
async function mapMonitorAndroidDiscovery(
  devicePool: DeviceLossDiscoveryPool,
  devices: BootedDevice[],
): Promise<BootedDevice[]> {
  const mapped = devicePool.mapAndroidDiscovery(devices);
  const present = new Set(mapped.map((device) => device.deviceId));
  const pooled = devicePool.getAllDevices().filter((device) => device.platform === "android");
  const pooledIds = new Set(pooled.map((device) => device.id));
  const unmappedTransport = mapped.some(
    (device) =>
      device.platform === "android" &&
      !pooledIds.has(device.deviceId) &&
      isAndroidTransportAddressSerial(device.deviceId),
  );
  if (!unmappedTransport) {
    return mapped;
  }
  const missingTransportCandidate = pooled.some(
    (device) =>
      !present.has(device.id) &&
      [device.id, ...devicePool.getAndroidTransportAliases(device.id)].some(
        isAndroidTransportAddressSerial,
      ),
  );
  if (!missingTransportCandidate) {
    return mapped;
  }
  // Additive fold: a monitor tick must not prune alias groups or connection evidence.
  return await devicePool.normalizeAndroidDiscovery(devices, false, () => true, false);
}

/**
 * A held USB+Wi-Fi phone is keyed by its USB serial; after an unplug its
 * still-attached Wi-Fi alias may be listed offline/authorizing. Map each
 * known alias serial to the canonical id it speaks for (#11133).
 */
export function androidAliasOwners(
  devicePool: Pick<DevicePool, "getAndroidTransportAliases">,
  deviceIds: Iterable<string>,
): Map<string, string> {
  return new Map(
    [...deviceIds].flatMap((deviceId) =>
      devicePool
        .getAndroidTransportAliases(deviceId)
        .map((alias): [string, string] => [alias, deviceId]),
    ),
  );
}

/** Offline canonical ids, counting an offline alias serial as its canonical (#11133). */
export async function getAndroidOfflineCanonicalIds(
  devicePool: Pick<DevicePool, "getAndroidTransportAliases">,
  deviceManager: Pick<MultiPlatformDeviceManager, "getAndroidOfflineDeviceIds">,
  deviceIds: Iterable<string>,
): Promise<Set<string>> {
  const ids = [...deviceIds];
  const aliasOwners = androidAliasOwners(devicePool, ids);
  const offline = await deviceManager.getAndroidOfflineDeviceIds(
    new Set([...ids, ...aliasOwners.keys()]),
  );
  return new Set([...offline].map((id) => aliasOwners.get(id) ?? id));
}

function findMissingAndroidCandidates(
  candidateDeviceIds: Set<string>,
  bootedDeviceIds: Set<string>,
  candidatePlatforms: Map<string, Platform>,
): Set<string> {
  return new Set(
    [...candidateDeviceIds].filter(
      (deviceId) =>
        !bootedDeviceIds.has(deviceId) && candidatePlatforms.get(deviceId) === "android",
    ),
  );
}

export interface ListedAndroidStates {
  offlineDeviceIds?: Set<string>;
  offlineTransportIds?: Map<string, Set<string>>;
  transitionalAdbDeviceIds?: Set<string>;
  listedNonDeviceIds?: Set<string>;
}

/**
 * Online-ness is otherwise binary: an in-session Android emulator that
 * dropped to ADB `offline` looks identical to one that is fully gone, since
 * bootedDeviceIds only ever contains `device`-state serials. Ask only about
 * candidates already missing from that list, so a fully-healthy sweep never
 * pays for this extra `devices -l` probe (#7536). Every non-`device` row
 * counts as still attached for the immediate physical-device path; only
 * `offline` drives reconnect (#11090), and the transitional rows (`offline`,
 * `unauthorized`) are held under the budget (#11592). Every set is undefined
 * when the probe is skipped (plan active) or fails.
 */
export async function probeListedAndroidStates(
  devicePool: Pick<DevicePool, "getAndroidTransportAliases">,
  deviceManager: Pick<MultiPlatformDeviceManager, "getAndroidListedDeviceStates">,
  planActive: boolean,
  candidateDeviceIds: Set<string>,
  bootedDeviceIds: Set<string>,
  candidatePlatforms: Map<string, Platform>,
): Promise<ListedAndroidStates> {
  if (planActive) {
    return {};
  }
  const missingAndroidCandidateIds = findMissingAndroidCandidates(
    candidateDeviceIds,
    bootedDeviceIds,
    candidatePlatforms,
  );
  const aliasOwners = androidAliasOwners(devicePool, missingAndroidCandidateIds);
  try {
    const listedStates =
      missingAndroidCandidateIds.size > 0
        ? await deviceManager.getAndroidListedDeviceStates(
            new Set([...missingAndroidCandidateIds, ...aliasOwners.keys()]),
          )
        : new Map<string, string>();
    const candidateStates = [...listedStates].map(([id, state]): [string, string] => [
      aliasOwners.get(id) ?? id,
      state,
    ]);
    const offlineTransportIds = new Map<string, Set<string>>();
    for (const [id, state] of listedStates) {
      const canonicalId = aliasOwners.get(id) ?? id;
      if (state === "offline" && missingAndroidCandidateIds.has(canonicalId)) {
        const transports = offlineTransportIds.get(canonicalId) ?? new Set<string>();
        transports.add(id);
        offlineTransportIds.set(canonicalId, transports);
      }
    }
    return {
      offlineTransportIds,
      listedNonDeviceIds: new Set(candidateStates.map(([id]) => id)),
      offlineDeviceIds: new Set(
        candidateStates.filter(([, state]) => state === "offline").map(([id]) => id),
      ),
      transitionalAdbDeviceIds: new Set(
        candidateStates.filter(([, state]) => isTransitionalAdbState(state)).map(([id]) => id),
      ),
    };
  } catch (error) {
    if (!(error instanceof AndroidOfflineProbeError)) {
      throw error;
    }
    // Auxiliary probe failure supplies no evidence that an offline episode ended.
    logger.warn(`[DisconnectMonitor] Retaining offline recovery attempts: ${errorMessage(error)}`);
    return {};
  }
}

/**
 * One rule for both platforms (#11592): a held device the platform still
 * lists mid-transition (adb `offline`/`unauthorized`, simctl `Booting`/
 * `Shutting Down`) is held under the budget instead of counting misses. The
 * simulator half reads the sweep's own listing and the same held-device
 * filter the inventory surfaces use, so an unheld pooled simulator keeps the
 * three-miss rule and the surfaces agree with what the monitor keeps.
 */
export function transitionalCandidateIds(
  devicePool: Pick<DevicePool, "getAssignedDevices">,
  discovery: Pick<BootedDeviceDiscovery, "devices" | "transitionalSimulators">,
  listed: { transitionalAdbDeviceIds?: ReadonlySet<string> },
): Set<string> {
  return selectTransitionalDeviceIds(
    listed.transitionalAdbDeviceIds,
    transitionalHeldSimulators({
      transitional: discovery.transitionalSimulators,
      discovered: discovery.devices,
      devicePool,
    }).map(({ device }) => device.deviceId),
  );
}

export function collectDisconnectCandidates(
  devicePool: {
    getAllDevices(): readonly Pick<PooledDevice, "id" | "platform" | "incarnation">[];
  },
  sessionManager: {
    getAllSessions(): readonly Pick<Session, "assignedDevice" | "platform">[];
  },
  activeRecordings: ActiveRecordings,
) {
  const candidateDeviceIds = new Set<string>();
  const candidatePlatforms = new Map<string, Platform>();
  const candidateIncarnations = recordingCandidateIncarnations(activeRecordings);
  for (const recording of activeRecordings) {
    candidateDeviceIds.add(recording.deviceId);
    candidatePlatforms.set(recording.deviceId, recording.platform);
  }
  for (const device of devicePool.getAllDevices()) {
    candidateDeviceIds.add(device.id);
    candidatePlatforms.set(device.id, device.platform);
    candidateIncarnations.set(device.id, device.incarnation);
  }
  for (const session of sessionManager.getAllSessions()) {
    candidateDeviceIds.add(session.assignedDevice);
    if (!candidatePlatforms.has(session.assignedDevice)) {
      candidatePlatforms.set(session.assignedDevice, session.platform);
    }
  }
  return { candidateDeviceIds, candidatePlatforms, candidateIncarnations };
}

export function collectDisconnectedRecordings<Device extends { id: string }>(
  adbServerResetCohort: readonly Device[],
  missingByDevice: Map<string, string[]>,
  activeRecordings: readonly { deviceId: string; recordingId: string }[],
): Map<string, Device> {
  const processWideAdbServerReset = adbServerResetCohort.length > 0;
  const adbServerResetCohortByDeviceId = new Map(
    adbServerResetCohort.map((device) => [device.id, device]),
  );
  if (processWideAdbServerReset) {
    logger.warn(
      "[DisconnectMonitor] All AutoMobile-owned Android emulators disappeared together; " +
        "treating this as an ADB server reset and recovering by AVD name",
    );
    for (const device of adbServerResetCohort) {
      missingByDevice.set(device.id, []);
    }
  }

  for (const recording of activeRecordings) {
    if (missingByDevice.has(recording.deviceId)) {
      missingByDevice.get(recording.deviceId)!.push(recording.recordingId);
    }
  }
  return adbServerResetCohortByDeviceId;
}

export function logDisconnectMisses(
  deviceDisconnectMisses: Map<string, number>,
  disconnectResult: Pick<DisconnectMonitorEvaluation, "missed" | "transitional">,
  planDeviceIds: ReadonlySet<string>,
  bootedDeviceIds: Set<string>,
): void {
  for (const { deviceId, misses: evaluatedMisses, budgetExhausted } of disconnectResult.missed) {
    const planActive = planDeviceIds.has(deviceId);
    const misses = planActive
      ? Math.min(evaluatedMisses, PLAN_DEVICE_DISCONNECT_MISS_CAP)
      : evaluatedMisses;
    if (planActive) {
      // Also lower pre-plan misses so a plan-driven restart gets the same grace.
      deviceDisconnectMisses.set(deviceId, misses);
    }
    const missState = budgetExhausted ? "budget exhausted" : "absent";
    const message = `[DisconnectMonitor] Device ${deviceId} not in booted list (${missState}, miss ${misses}/${DEVICE_DISCONNECT_MISS_THRESHOLD}, booted=${bootedDeviceIds.size})`;
    if (planActive && evaluatedMisses > PLAN_DEVICE_DISCONNECT_MISS_CAP) {
      logger.debug(message);
    } else {
      logger.info(message);
    }
  }
  for (const { deviceId, transitionalForMs } of disconnectResult.transitional) {
    logger.info(
      `[DisconnectMonitor] Device ${deviceId} listed in a transitional state for ${Math.round(transitionalForMs / 1000)}s (budget ${OFFLINE_DEVICE_DISCONNECT_BUDGET_MS / 1000}s); keeping session`,
    );
  }
}

/** What stopping a recording at disconnect needs from the daemon. */
export interface DisconnectRecordingStopDeps {
  timer: Timer;
  /** Recording ids with a stop in flight; shared so a second disconnect never starts a second stop. */
  stoppingRecordings: Set<string>;
}

export async function stopRecordingAfterDeviceDisconnect(
  deps: DisconnectRecordingStopDeps,
  recordingId: string,
  deviceId: string,
): Promise<boolean> {
  const { timer, stoppingRecordings } = deps;
  if (stoppingRecordings.has(recordingId)) {
    return false;
  }
  stoppingRecordings.add(recordingId);
  const stopped = stopOrInterruptRecordingAfterDeviceDisconnect(recordingId, deviceId).finally(() =>
    stoppingRecordings.delete(recordingId),
  );
  const stillStopping = new Error("recording stop still running");
  try {
    return await raceWithDeadline(stopped, {
      timer,
      timeoutMs: DISCONNECT_RECORDING_STOP_WAIT_MS,
      label: "Stop recording after device disconnect",
      timeoutError: () => stillStopping,
    });
  } catch (error) {
    if (error !== stillStopping) {
      throw error;
    }
    // The capture itself ended with the device; what is left is post-processing, bounded by
    // the unattended stop's own ceiling. The recording stays in `stoppingRecordings` until
    // it finishes, so releasing the device neither waits for it nor starts a second stop.
    logger.warn(
      `[Daemon] Recording ${recordingId} is still finishing after device ${deviceId} disconnected; releasing the device without waiting`,
    );
    return true;
  }
}

async function stopOrInterruptRecordingAfterDeviceDisconnect(
  recordingId: string,
  deviceId: string,
): Promise<boolean> {
  try {
    await stopVideoRecordingUnattended(recordingId);
    logger.warn(`[Daemon] Stopped recording ${recordingId} after device ${deviceId} disconnected`);
    return true;
  } catch (error) {
    logger.warn(
      `[Daemon] Failed to stop recording ${recordingId} after device ${deviceId} disconnected: ${error}`,
    );
    return await interruptRecordingAfterDeviceDisconnect(recordingId, deviceId);
  }
}

async function interruptRecordingAfterDeviceDisconnect(
  recordingId: string,
  deviceId: string,
): Promise<boolean> {
  try {
    await interruptVideoRecording(recordingId);
    logger.warn(
      `[Daemon] Marked recording ${recordingId} interrupted after device ${deviceId} disconnected`,
    );
    return true;
  } catch (error) {
    logger.warn(
      `[Daemon] Failed to mark recording ${recordingId} interrupted after device ${deviceId} disconnected: ${error}`,
    );
    return false;
  }
}
