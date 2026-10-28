import {
  FileAvdConfigReader,
  type AvdConfigReader,
} from "../utils/android-cmdline-tools/AvdConfigReader";
import { avdConfigFormFactor } from "../utils/android-cmdline-tools/avdDeviceInfoEnrichment";
import { isUnknownEmulatorName } from "../utils/android-cmdline-tools/emulatorReadinessEvaluation";
import { isAndroidEmulatorSerial } from "../utils/androidSerial";
import { logger } from "../utils/logger";
import { errorMessage } from "../utils/describeUnknownError";
import {
  explicitReadTargetPlatform,
  matchRunningReadTarget,
  providedReadTargetNotFound,
} from "../devices/runningReadTarget";
import type { BootedDevice, SomePlatform } from "../models";
import { ActionableError } from "../models/ActionableError";
import {
  listBootedDevicesForResource,
  listBootedDevicesForReadWithStatus,
  type BootedResourceReadListing,
} from "./resourceDeviceResolver";
import { BootedDeviceDiscoveryIncompleteError } from "../models/BootedDeviceDiscoveryIncompleteError";
import { sequenceBackoff, type BackoffInput } from "../utils/Backoff";
import { defaultTimer, type Timer } from "../utils/SystemTimer";
import { raceWithDeadline } from "../utils/raceWithDeadline";
import { DefaultRetryExecutor } from "../utils/retry/RetryExecutor";
import type { PooledDevice } from "../daemon/devicePoolTypes";

export interface DeviceObservationAccess {
  /** Host-only metadata; injected readers keep custom access independent of host AVD files. */
  avdConfigReader?: AvdConfigReader;
  listBooted(signal: AbortSignal | undefined): Promise<BootedDevice[]>;
  listBootedWithStatus?(signal: AbortSignal | undefined): Promise<BootedResourceReadListing>;
  isAuthorized(device: BootedDevice): boolean;
}

export const defaultDeviceObservationAccess: DeviceObservationAccess = {
  avdConfigReader: new FileAvdConfigReader(),
  listBooted: (signal) =>
    listBootedDevicesForResource("either", "observe", { signal, requireFresh: true }),
  listBootedWithStatus: (signal) => listBootedDevicesForReadWithStatus("either", "observe", signal),
  // The local daemon socket admits observation reads regardless of pool ownership.
  isAuthorized: () => true,
};

/** Inventory confirmation is read-only and may establish a stopped target on a healthy platform. */
export type ConfirmStoppedReadTarget = (listing: BootedResourceReadListing) => Promise<boolean>;

export interface DeviceReadRetryOptions {
  timer?: Timer;
  backoff?: BackoffInput;
}

function incompleteReadPlatform(listing: BootedResourceReadListing, platform: SomePlatform) {
  return (["android", "ios"] as const).find(
    (p) =>
      (platform === "either" || platform === p) &&
      !listing.scanned[p] &&
      (platform !== "either" || listing.discoveryErrors?.[p]?.code !== "unavailable"),
  );
}

function retryableReadDiscovery(error: unknown): boolean {
  return (
    error instanceof BootedDeviceDiscoveryIncompleteError &&
    error.discoveryError?.code !== "unavailable"
  );
}

/** Retry only unproven absence; a fresh match on a healthy platform answers immediately. */
async function findObservationReadTarget(
  deviceId: string,
  signal: AbortSignal | undefined,
  access: DeviceObservationAccess,
  platform: SomePlatform,
  retry: DeviceReadRetryOptions,
  confirmStopped?: ConfirmStoppedReadTarget,
): Promise<{ device: BootedDevice | undefined; devices: BootedDevice[] }> {
  const targetPlatform = explicitReadTargetPlatform(deviceId, platform);
  try {
    return await new DefaultRetryExecutor(retry.timer).executeOrThrow(
      async () => {
        signal?.throwIfAborted();
        // The plain listing scans Android and iOS only, so a watch never reads as freshly listed.
        const listing: BootedResourceReadListing = access.listBootedWithStatus
          ? await access.listBootedWithStatus(signal)
          : {
              devices: await access.listBooted(signal),
              scanned: { android: true, ios: true, watchos: false },
            };
        signal?.throwIfAborted();
        const fresh = listing.devices.filter((device) => listing.scanned[device.platform]);
        let device = matchRunningReadTarget(fresh, deviceId, targetPlatform);
        if (!device) {
          const failedPlatform = incompleteReadPlatform(listing, targetPlatform);
          if (failedPlatform && !(await confirmStopped?.(listing))) {
            throw new BootedDeviceDiscoveryIncompleteError(
              failedPlatform,
              listing.discoveryErrors?.[failedPlatform],
            );
          }
        }
        if (device && access.avdConfigReader) {
          device = await enrichBootedDeviceFormFactor(device, access.avdConfigReader);
          signal?.throwIfAborted();
        }
        return { device, devices: fresh };
      },
      {
        maxAttempts: 3,
        delays: retry.backoff ?? sequenceBackoff([250, 750]),
        signal,
        shouldRetry: retryableReadDiscovery,
        expectedFailure: {
          reason: "read discovery remains incomplete",
          matches: (error) => error instanceof BootedDeviceDiscoveryIncompleteError,
        },
      },
    );
  } catch (error) {
    // Cancellation preserves the caller's exact reason, including a bare abort's DOMException.
    signal?.throwIfAborted();
    throw error;
  }
}

/** Resolve a read-only target without session creation or device-pool ownership changes. */
export async function resolveDeviceForObservationRead(
  deviceId: string,
  signal: AbortSignal | undefined,
  access: DeviceObservationAccess = defaultDeviceObservationAccess,
  platform: SomePlatform = "either",
  retry: DeviceReadRetryOptions = {},
): Promise<BootedDevice> {
  const { device, devices } = await findObservationReadTarget(
    deviceId,
    signal,
    access,
    platform,
    retry,
  );
  if (!device) {
    throw providedReadTargetNotFound(deviceId, platform, devices);
  }
  assertObservationReadAccess(device, access);
  return device;
}

export function assertObservationReadAccess(
  device: BootedDevice,
  access: DeviceObservationAccess = defaultDeviceObservationAccess,
): void {
  if (!access.isAuthorized(device)) {
    throw new ActionableError("Observation access denied.");
  }
}

/**
 * The read-only device path for a device-aware tool (#10830): resolve the target from the booted
 * list and authorize it, without acquiring, readying or pinning a device.
 */
export function sessionlessDeviceReadFor(
  access: DeviceObservationAccess = defaultDeviceObservationAccess,
  retry: DeviceReadRetryOptions = {},
): {
  resolve(deviceId: string, signal?: AbortSignal, platform?: SomePlatform): Promise<BootedDevice>;
  findRunning(
    deviceId: string,
    signal?: AbortSignal,
    platform?: SomePlatform,
    confirmStopped?: ConfirmStoppedReadTarget,
  ): Promise<BootedDevice | undefined>;
  assertAuthorized(device: BootedDevice): void;
} {
  return {
    resolve: (deviceId, signal, platform) =>
      resolveDeviceForObservationRead(deviceId, signal, access, platform, retry),
    findRunning: async (deviceId, signal, platform, confirmStopped) => {
      const { device } = await findObservationReadTarget(
        deviceId,
        signal,
        access,
        platform ?? "either",
        retry,
        confirmStopped,
      );
      return device;
    },
    assertAuthorized: (device) => assertObservationReadAccess(device, access),
  };
}

/** Add only configured form-factor evidence, without issuing another device command. */
async function enrichBootedDeviceFormFactor(
  device: BootedDevice,
  reader: AvdConfigReader,
): Promise<BootedDevice> {
  if (
    device.platform !== "android" ||
    !isAndroidEmulatorSerial(device.deviceId) ||
    device.formFactor !== undefined ||
    !device.name.trim() ||
    device.name === device.deviceId ||
    isUnknownEmulatorName(device.name, device.deviceId)
  ) {
    return device;
  }
  try {
    const config = await reader.readConfig(device.name);
    if (!config) {
      // Optional host metadata: missing config leaves device reads usable without an inferred field.
      logger.debug(`No AVD config for ${device.name}`);
      return device;
    }
    const formFactor = avdConfigFormFactor(config);
    return formFactor === "unknown" ? device : { ...device, formFactor };
  } catch (error) {
    // Optional host metadata: unreadable config leaves form factor absent and never blocks observe.
    logger.debug(`AVD form factor unavailable for ${device.name}: ${errorMessage(error)}`);
    return device;
  }
}

const HELD_FORM_FACTOR_READ_TIMEOUT_MS = 2000;

/** Optional form-factor metadata shared by all handlers using one held pool incarnation. */
export class HeldDeviceFormFactorResolver {
  // Weak keys follow the pool entry's lifetime, so retired devices do not accumulate here.
  private readonly cache = new WeakMap<
    PooledDevice,
    { identity: string; value: Promise<BootedDevice["formFactor"]> }
  >();

  constructor(
    private readonly reader: AvdConfigReader | undefined,
    private readonly timer: Timer = defaultTimer,
    private readonly timeoutMs: number = HELD_FORM_FACTOR_READ_TIMEOUT_MS,
  ) {}

  async enrich(device: BootedDevice, pooled: PooledDevice | null): Promise<BootedDevice> {
    const formFactor = await this.resolve(device, pooled);
    return formFactor === undefined ? device : { ...device, formFactor };
  }

  private resolve(
    device: BootedDevice,
    pooled: PooledDevice | null,
  ): Promise<BootedDevice["formFactor"]> {
    const known = pooled?.androidImage?.formFactor;
    if (known !== undefined || !pooled || !this.reader) {
      return Promise.resolve(known);
    }
    const identity = `${pooled.incarnation}:${pooled.avdName ?? device.name}`;
    const cached = this.cache.get(pooled);
    if (cached?.identity === identity) {
      return cached.value;
    }
    // Unknown emulator metadata needs one host read, shared even by concurrent calls. Known
    // phones above pay none. Cache settled absence too: missing/unreadable config is not polled.
    const name = pooled.avdName ?? device.name;
    const value: Promise<BootedDevice["formFactor"]> = raceWithDeadline(
      enrichBootedDeviceFormFactor({ ...device, name }, this.reader).then(
        (enriched) => enriched.formFactor,
      ),
      {
        timer: this.timer,
        timeoutMs: this.timeoutMs,
        label: `AVD form factor read for ${name}`,
        onTimeout: () => {
          // Optional host metadata is safe to retry; never evict a replacement read.
          if (this.cache.get(pooled)?.value === value) {
            this.cache.delete(pooled);
          }
        },
      },
    ).catch((error) => {
      logger.debug(`AVD form factor unavailable for ${name}: ${errorMessage(error)}`);
      return undefined;
    });
    this.cache.set(pooled, { identity, value });
    return value;
  }
}
