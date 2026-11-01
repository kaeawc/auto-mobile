import { BootedDevice, DeviceInfo, ActionableError, Platform } from "../../../models";
import {
  PlatformDeviceManager,
  type BootedDeviceDiscovery,
  type DeviceDiscoveryError,
} from "../../../devices/deviceUtils";
import { type Timer } from "../../../utils/SystemTimer";
import { isAndroidEmulatorSerial } from "../../../utils/androidSerial";
import { logger } from "../../../utils/logger";
import { reconcileDiscoveryObservation } from "../../../daemon/discoveryReconcile";
import { defaultDaemonContext } from "../../../daemon/daemonContext";
import {
  BootedDeviceDiscoveryIncompleteError,
  type DeviceBootResult,
  AndroidBootedDeviceDiscoveryIncompleteError,
  AndroidDeviceIdentityUnresolvedError,
} from "../../../devices/deviceBootService";
import {
  discoveryRefreshOutcome,
  deviceListRefreshFailureMessage,
} from "../../../daemon/devicePoolRefresh";
import { type StartDeviceArgs } from "../core/contracts";
import { describeStartDeviceRequest } from "../provisioning/provisioning";
import { runWithinShutdownDeadline, type StableDeviceTarget } from "../core/deadlines";
import {
  isUnknownAndroidRuntimeName,
  isVirtualAndroidDevice,
  getBootedAndroidStableName,
  getValidatedPooledAndroidAvdName,
} from "../identity/androidIdentity";

/**
 * True when the running device resolved for `args.deviceId` is not the device
 * the caller named. On Android `deviceId` doubles as an AVD image name (see
 * `getAndroidSchema`), so a serial that necessarily differs from the requested
 * string is still the requested device when the AVD name matches.
 */
export function isMismatchedBootedDeviceId(
  args: StartDeviceArgs,
  device: BootedDevice,
  sourceImage: DeviceInfo | undefined,
): boolean {
  if (!args.deviceId || device.deviceId === args.deviceId) {
    return false;
  }
  return !(
    device.platform === "android" &&
    (device.name === args.deviceId || sourceImage?.name === args.deviceId)
  );
}

export function validateBootIdentity(
  args: StartDeviceArgs,
  device: BootedDevice,
  source: "booted" | "cold-boot",
  sourceImage?: DeviceInfo,
): void {
  const requested = describeStartDeviceRequest(args);
  const resolved = `${device.platform} ${device.name} (${device.deviceId})`;
  if (device.platform !== args.platform) {
    throw new ActionableError(
      `startDevice identity mismatch: requested=[${requested}] resolved=[${resolved}] ` +
        "phase=pool-match: resolved platform differs from requested platform",
    );
  }
  if (args.platform === "android" && args.avdName && device.name !== args.avdName) {
    throw new ActionableError(
      `target_identity_mismatch: Requested Android AVD '${args.avdName}' ` +
        `resolved to '${device.name}' (${device.deviceId}).`,
    );
  }
  if (source === "booted" && isMismatchedBootedDeviceId(args, device, sourceImage)) {
    throw new ActionableError(
      `startDevice identity mismatch: requested=[${requested}] resolved=[${resolved}] ` +
        "phase=pool-match: running device ID differs from the requested device ID",
    );
  }
  if (
    source === "cold-boot" &&
    device.platform === "ios" &&
    sourceImage?.deviceId &&
    sourceImage.deviceId !== device.deviceId
  ) {
    throw new ActionableError(
      `startDevice identity mismatch: requested=[${requested}] selected=[${sourceImage.name} ` +
        `(${sourceImage.deviceId})] resolved=[${resolved}] phase=pool-match: ` +
        "iOS runtime UDID differs from the selected simulator UDID",
    );
  }
}

/**
 * getAndroid accepts `avdName` and `deviceId` together (see `getAndroidSchema`).
 * `deviceId` is a serial OR an image name, so the pair identifies one device
 * whenever the resolved device carries the requested serial — or is that image.
 * Anything else is a genuine `identifier_conflict`, reportable only here,
 * because the mapping from AVD name to serial is not known until discovery.
 */
/**
 * Reject a contradictory `avdName` + `deviceId` pair BEFORE any boot.
 * `validateRequestedAndroidSerial` is the post-boot authority, but by the time
 * it runs a stopped AVD has already been cold-booted and then killed just to
 * report the conflict (Codex thread on #6833). A configured AVD name can be
 * resolved from the image inventory, and a running-emulator serial can be
 * resolved from one booted-device discovery sweep, without booting anything.
 *
 * A non-serial `deviceId` remains deferred unless it is itself a configured AVD
 * name. Anything ambiguous — inventory discovery unavailable, an unknown
 * non-serial identifier, or a running device whose runtime name is still
 * `Unknown (<serial>)` — likewise defers, so this check only ever rejects a
 * pair it can positively contradict.
 */
export async function validateRequestedAndroidConfiguredAvdPairBeforeBoot(
  pair: { avdName: string; deviceId: string },
  deviceUtils: PlatformDeviceManager,
  bootDeadlineMs: number,
  { timer, signal }: { timer: Timer; signal?: AbortSignal },
): Promise<boolean> {
  const { avdName, deviceId } = pair;
  if (isAndroidEmulatorSerial(deviceId)) {
    return false;
  }
  const inventory = await runWithinShutdownDeadline(
    { name: avdName, platform: "android", deviceId },
    timer,
    bootDeadlineMs,
    {
      detail: "Android pre-boot AVD identity validation did not complete",
      requestAbortSignal: signal,
      operation: async (signal) =>
        await deviceUtils.getDeviceImagesDetailed("android", {
          signal,
        }),
      timeoutMs: undefined,
      phase: "pre-boot AVD identity validation",
    },
  );
  if (!inventory.succeededPlatforms.has("android")) {
    return true;
  }
  const configuredAvdNames = new Set(
    inventory.devices
      .filter((device) => device.platform === "android")
      .map((device) => device.name),
  );
  if (configuredAvdNames.has(avdName) && configuredAvdNames.has(deviceId)) {
    throw new ActionableError(
      `identifier_conflict: avdName '${avdName}' and deviceId '${deviceId}' name ` +
        "different configured AVDs. Pass only the identifier you mean.",
    );
  }
  return true;
}

/**
 * Collects the process-exit settlements of cold boots this request cancelled but
 * never owned. `prepareDevice` defers its lifecycle-lease release onto every one
 * of them, so an AVD's stable key is not handed to the next request while an
 * emulator this one only signalled is still running.
 */
export type ColdBootSettlementCollector = (settlement: Promise<void> | undefined) => void;

export async function validateRequestedAndroidIdentifiersBeforeBoot(
  pair: { avdName: string; deviceId: string } | undefined,
  deviceUtils: PlatformDeviceManager,
  bootDeadlineMs: number,
  {
    timer,
    signal,
    collectPendingSettlement,
  }: {
    signal: AbortSignal | undefined;
    collectPendingSettlement?: ColdBootSettlementCollector;
    timer: Timer;
  },
): Promise<void> {
  if (!pair) {
    return;
  }
  const { avdName, deviceId } = pair;
  if (!avdName || avdName === deviceId) {
    return;
  }
  if (
    await validateRequestedAndroidConfiguredAvdPairBeforeBoot(pair, deviceUtils, bootDeadlineMs, {
      timer,
      signal,
    })
  ) {
    return;
  }
  const discovery = await runWithinShutdownDeadline(
    { name: avdName, platform: "android", deviceId },
    timer,
    bootDeadlineMs,
    {
      detail: "Android pre-boot serial validation did not complete",
      requestAbortSignal: signal,
      operation: async (signal) => {
        const discovery = await deviceUtils.getBootedDevicesDetailed("android", {
          bypassAndroidDeviceListCache: true,
          skipForeignEnrichment: true,
          signal,
        });
        if (signal.aborted) {
          // The deadline/abort already settled prepareDevice and released its
          // lifecycle lease. Dropping this stale snapshot is safe: the post-boot
          // recheck for the next acquisition will observe with current context.
          logger.debug(
            `[DeviceTools] Dropping stale pre-boot serial validation discovery after deadline/abort for avdName=${avdName}`,
          );
          return discovery;
        }
        // FUNNEL 1: the post-boot recheck this defers to decides with pool/incarnation
        // context, so the pool must have seen this observation (#6863 review).
        await reconcileDiscoveryObservation(discovery.devices, "pre-boot-serial-validation", {
          signal,
        });
        return discovery;
      },
      timeoutMs: undefined,
      phase: "pre-boot serial validation",
      onOrphan: (pending) => {
        collectPendingSettlement?.(
          pending.then(
            () => undefined,
            () => undefined,
          ),
        );
      },
    },
  );
  if (!discovery.succeededPlatforms.has("android")) {
    // Discovery was unavailable this sweep; a pair we cannot yet contradict is
    // deferred to the post-boot recheck rather than rejected on missing data.
    return;
  }
  const running = discovery.devices.find(
    (device) =>
      !device.foreignOwned && device.platform === "android" && device.deviceId === deviceId,
  );
  if (running && isUnknownAndroidRuntimeName(running)) {
    // The serial is running but its AVD name is not resolvable yet; the
    // post-boot recheck decides with pool/incarnation context.
    return;
  }
  if (running && running.name === avdName) {
    return;
  }
  throw new ActionableError(
    `identifier_conflict: avdName '${avdName}' and deviceId '${deviceId}' name ` +
      `different devices — '${deviceId}' ` +
      (running ? `is running AVD '${running.name}'` : "is not running") +
      `. Pass only the identifier you mean.`,
  );
}

export function validateRequestedAndroidSerial(
  pair: { avdName: string; deviceId: string } | undefined,
  device: BootedDevice,
  sourceImage: DeviceInfo | undefined,
): void {
  if (!pair) {
    return;
  }
  const requested = pair.deviceId;
  if (isAndroidEmulatorSerial(requested) && device.deviceId === requested) {
    if (device.name === pair.avdName) {
      return;
    }
    throw new ActionableError(
      `identifier_conflict: avdName '${pair.avdName}' resolved to ` +
        `${device.name} (${device.deviceId}), which is not the requested AVD. ` +
        "Pass only the identifier you mean.",
    );
  }
  if (
    device.deviceId === requested ||
    device.name === requested ||
    sourceImage?.name === requested
  ) {
    return;
  }
  throw new ActionableError(
    `identifier_conflict: avdName '${pair.avdName}' resolved to ` +
      `${device.name} (${device.deviceId}), which is not the requested deviceId ` +
      `'${requested}'. Pass only the identifier you mean.`,
  );
}

export async function validatePooledDeviceMapping(
  device: BootedDevice,
  requestedIdentity: string,
  options: { signal?: AbortSignal; totalDeadlineMs?: number } = {},
): Promise<void> {
  const devicePool = defaultDaemonContext.devicePool();
  const poolWrites = defaultDaemonContext.devicePoolWrites();
  if (!devicePool || !poolWrites) {
    return;
  }
  let pooled = devicePool.getDevice(device.deviceId);
  // Delegate to the pool's own predicate rather than re-deriving it, so this
  // validator cannot reject a pairing the pool tolerates: a physical iPhone's
  // mutable display name (#5690) and an emulator's `Unknown (<serial>)`
  // placeholder (#10603) are both judged exactly as the pool judges them.
  if (pooled && !devicePool.matchesRuntimeIdentity(pooled, device)) {
    if (devicePool.hasReusableSerial(pooled)) {
      await poolWrites.settlePooledRuntimeIdentity(device.deviceId, {
        ...options,
        platform: device.platform,
      });
      pooled = devicePool.getDevice(device.deviceId);
      if (!pooled || devicePool.matchesRuntimeIdentity(pooled, device)) {
        return;
      }
    }
    const mismatch =
      `startDevice identity mismatch: requested=[${requestedIdentity}] ` +
      `resolved=[${device.name} (${device.deviceId}) platform=${device.platform}] ` +
      `pooled=[${pooled.name} (${pooled.id}) platform=${pooled.platform}] ` +
      "phase=pool-match: stale pool identity conflicts with the resolved runtime";
    if (!devicePool.hasReusableSerial(pooled)) {
      throw new ActionableError(mismatch);
    }
    throw new BootedDeviceDiscoveryIncompleteError(
      device.platform,
      undefined,
      `${mismatch}; a pool refresh is settling it; retry.`,
    );
  }
}

export function assertAndroidBootDidNotEnterRecovery(
  args: StartDeviceArgs,
  boot: DeviceBootResult,
): void {
  if (args.platform !== "android") {
    return;
  }
  const recoveryTargets = defaultDaemonContext.devicePool()?.getRecoveringAndroidTargets();
  if (
    recoveryTargets?.serials.has(boot.device.deviceId) ||
    recoveryTargets?.names.has(boot.device.name)
  ) {
    throw new ActionableError(
      `Android device '${boot.device.name}' entered recovery while booting; retry the request.`,
    );
  }
}

export function getVerifiedWarmAndroidAvdIdentity(
  boot: DeviceBootResult,
  sourceImage: DeviceInfo | undefined,
): DeviceInfo | undefined {
  if (boot.source === "booted" && sourceImage?.platform === "android") {
    return sourceImage;
  }
  return undefined;
}

// This checked discovery is the pre-allocation refresh for a serial selector.
// Use the same outcome as pool refresh before lifecycle resolution can mask its cause.
export function assertAndroidLifecycleDiscovery(
  discovery: BootedDeviceDiscovery,
  matchCount: number,
): void {
  if (matchCount === 0) {
    const outcome = discoveryRefreshOutcome(discovery, 0);
    if (outcome.failure !== undefined) {
      throw new AndroidBootedDeviceDiscoveryIncompleteError(
        discovery.discoveryErrors?.android,
        deviceListRefreshFailureMessage(outcome.failure),
      );
    }
  }
}

/**
 * Lifecycle coordination could not prove which device the serial names because a discovery sweep
 * did not complete. Typed retryable `discovery_incomplete`, never a generic error; a genuinely
 * ambiguous identity under COMPLETE discovery keeps its plain ActionableError.
 */
export function androidLifecycleDiscoveryIncomplete(
  deviceId: string,
  discoveryErrors: Partial<Record<Platform, DeviceDiscoveryError>> | undefined,
): AndroidBootedDeviceDiscoveryIncompleteError {
  return new AndroidBootedDeviceDiscoveryIncompleteError(
    discoveryErrors?.android,
    `Cannot uniquely resolve Android device '${deviceId}' for lifecycle coordination.`,
  );
}

export async function resolveAndroidStartStableDeviceLifecycleTarget(
  deviceId: string,
  deadlineMs: number,
  deviceUtils: Pick<PlatformDeviceManager, "getBootedDevicesDetailed" | "getDeviceImagesDetailed">,
  { timer, signal }: { timer: Timer; signal?: AbortSignal },
): Promise<StableDeviceTarget | undefined> {
  const bootedDiscovery = await runWithinShutdownDeadline(
    { name: deviceId, platform: "android", deviceId },
    timer,
    deadlineMs,
    {
      detail: "Android booted-device identity discovery did not complete",
      requestAbortSignal: signal,
      operation: async (signal) => {
        const discovery = await deviceUtils.getBootedDevicesDetailed("android", {
          bypassAndroidDeviceListCache: true,
          skipForeignEnrichment: true,
          signal,
        });
        // FUNNEL 1: lifecycle coordination resolves the AVD behind a serial, which
        // is exactly what the quarantine puts in doubt (#6863 review).
        await reconcileDiscoveryObservation(discovery.devices, "android-start-lifecycle-target");
        return discovery;
      },
    },
  );
  const bootedMatches = bootedDiscovery.devices.filter(
    (device) =>
      !device.foreignOwned && device.platform === "android" && device.deviceId === deviceId,
  );
  if (bootedMatches.length > 1) {
    throw new ActionableError(
      `Cannot uniquely resolve Android device '${deviceId}' for lifecycle coordination.`,
    );
  }
  assertAndroidLifecycleDiscovery(bootedDiscovery, bootedMatches.length);
  const bootedMatch = bootedMatches[0];
  if (bootedMatch && !isVirtualAndroidDevice(bootedMatch)) {
    // Physical devices have no AVD representation; coordinate by the request selector.
    return undefined;
  }

  const imageDiscovery = await runWithinShutdownDeadline(
    { name: deviceId, platform: "android", deviceId },
    timer,
    deadlineMs,
    {
      detail: "Android AVD identity discovery did not complete",
      requestAbortSignal: signal,
      operation: async () => await deviceUtils.getDeviceImagesDetailed("android"),
    },
  );
  if (!imageDiscovery.succeededPlatforms.has("android")) {
    throw androidLifecycleDiscoveryIncomplete(deviceId, imageDiscovery.discoveryErrors);
  }
  const imageMatches = imageDiscovery.devices.filter(
    (device) =>
      device.platform === "android" && (device.deviceId === deviceId || device.name === deviceId),
  );
  if (imageMatches.length > 1) {
    throw new ActionableError(
      `Cannot uniquely resolve Android device '${deviceId}' for lifecycle coordination.`,
    );
  }
  if (imageMatches.length === 1) {
    return { platform: "android", stableId: imageMatches[0].name };
  }

  const devicePool = defaultDaemonContext.devicePool();
  const stableIds = new Set(
    bootedMatches.map((device) => getBootedAndroidStableName(device, devicePool)),
  );
  if (stableIds.size === 0) {
    if (!bootedDiscovery.succeededPlatforms.has("android")) {
      throw androidLifecycleDiscoveryIncomplete(deviceId, bootedDiscovery.discoveryErrors);
    }
    return undefined;
  }
  if (stableIds.size !== 1) {
    throw new ActionableError(
      `Cannot uniquely resolve Android device '${deviceId}' for lifecycle coordination.`,
    );
  }
  if (
    bootedMatches.some(
      (device) =>
        isUnknownAndroidRuntimeName(device) &&
        !getValidatedPooledAndroidAvdName(device, devicePool),
    )
  ) {
    throw new AndroidDeviceIdentityUnresolvedError(deviceId);
  }
  return { platform: "android", stableId: [...stableIds][0] };
}
