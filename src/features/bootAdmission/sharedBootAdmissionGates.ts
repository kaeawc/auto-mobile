import type { Platform } from "../../models/Platform";
import { defaultAdbClientFactory } from "../../utils/android-cmdline-tools/AdbClientFactory";
import { DefaultHostCommandExecutor } from "../../utils/HostCommandExecutor";
import { SimCtlClient } from "../../utils/ios-cmdline-tools/SimCtlClient";
import { defaultTimer, type Timer } from "../../utils/SystemTimer";
import { testOverrides } from "../../utils/testOverrides";
import {
  InMemoryBootDurationHistory,
  type BootDurationHistory,
} from "../iosSimFleet/BootDurationHistory";
import type { IosSimCapacityGate } from "../iosSimFleet/CapacityGate";
import { createIosSimCapacityGate } from "../iosSimFleet/defaultIosBootInstrumentation";
import { AndroidBootAdmissionGate } from "./AndroidBootAdmissionGate";
import { CommandAndroidCapacitySource } from "./AndroidCapacitySource";
import {
  isBootCapacityGateEnabled,
  type BootCapacityReporter,
  type BootCapacitySnapshot,
} from "./BootAdmissionGate";
import { raceWithDeadline } from "../../utils/raceWithDeadline";
import { logger } from "../../utils/logger";
import { errorMessage } from "../../utils/describeUnknownError";

const ADB_LISTING_TIMEOUT_MS = 5_000;

/**
 * The process-wide gates. One per platform so every device manager in this
 * process (daemon pool, tool handlers, recovery) shares one ledger of
 * admitted boots; a per-manager gate could not see its siblings' boots.
 */
export interface SharedBootAdmissionGates {
  /** Undefined when Android boots are not gated (opted out). */
  android: AndroidBootAdmissionGate | undefined;
  /** Undefined when iOS boots are not gated (opted out). */
  ios: IosSimCapacityGate | undefined;
  /** Boot durations shared with the iOS gate's warm-device matching. */
  iosBootHistory: BootDurationHistory;
}

export interface SharedBootAdmissionGateDeps {
  env?: NodeJS.ProcessEnv;
  timer?: Timer;
  /** Host OS; the iOS gate exists only on darwin. Defaults to `process.platform`. */
  hostPlatform?: NodeJS.Platform;
}

let shared: SharedBootAdmissionGates | undefined;

/** Lazily builds the gates from the environment on first use. */
export function getSharedBootAdmissionGates(
  deps: SharedBootAdmissionGateDeps = {},
): SharedBootAdmissionGates {
  shared ??= createBootAdmissionGates(deps);
  return shared;
}

/** Test seam: forget the shared gates so the next call rebuilds them. */
export function resetSharedBootAdmissionGates(): void {
  shared = undefined;
}

export function createBootAdmissionGates(
  deps: SharedBootAdmissionGateDeps = {},
): SharedBootAdmissionGates {
  const env = deps.env ?? process.env;
  const timer = deps.timer ?? defaultTimer;
  const iosBootHistory = new InMemoryBootDurationHistory();
  // Unit tests never sample the real host; gate tests build gates over fakes.
  const androidEnabled =
    !testOverrides.bootAdmissionGatesDisabled && isBootCapacityGateEnabled("android", env);
  const executor = new DefaultHostCommandExecutor();
  return {
    android: androidEnabled
      ? new AndroidBootAdmissionGate(
          new CommandAndroidCapacitySource(async (signal) => {
            const devices = await defaultAdbClientFactory.create(null).getBootedAndroidDevices({
              bypassCache: true,
              throwOnMissingAdb: true,
              timeoutMs: ADB_LISTING_TIMEOUT_MS,
              signal,
            });
            return devices
              .map((device) => device.deviceId)
              .filter((deviceId) => deviceId.startsWith("emulator-"));
          }, executor),
          timer,
          { env },
        )
      : undefined,
    // simulators exist only on macOS: elsewhere there is nothing to gate or report, and
    // the fleet sample would shell out to a missing `xcrun` on every listing.
    ios:
      testOverrides.bootAdmissionGatesDisabled ||
      (deps.hostPlatform ?? process.platform) !== "darwin"
        ? undefined
        : createIosSimCapacityGate({
            simctl: new SimCtlClient(null),
            timer,
            history: iosBootHistory,
            env,
            executor,
          }),
    iosBootHistory,
  };
}

/**
 * Read-only check that one more cold boot of `platform` fits right now; throws the typed retryable
 * `BootCapacityExhaustedError` at the limit. A platform whose boots are not gated always passes.
 */
export async function assertBootCapacityAvailable(
  platform: Platform,
  options: { signal?: AbortSignal } = {},
  gates: Pick<SharedBootAdmissionGates, "android" | "ios"> = getSharedBootAdmissionGates(),
): Promise<void> {
  await gates[platform]?.assertCapacityAvailable(options);
}

const CAPACITY_REPORT_TIMEOUT_MS = 3_000;

export type BootCapacityReport = Partial<Record<Platform, BootCapacitySnapshot>>;

/**
 * Capacity per gated platform for listings: `{ limit, booted, inFlight }`.
 * Best-effort and bounded: a platform whose sample fails or runs long is left
 * out, and undefined means no requested platform is gated.
 */
export async function describeBootCapacity(
  platforms: readonly Platform[],
  reporters: Partial<Record<Platform, BootCapacityReporter>> = gatedReporters(
    getSharedBootAdmissionGates(),
  ),
  timer: Timer = defaultTimer,
): Promise<BootCapacityReport | undefined> {
  const entries = await Promise.all(
    platforms.map(async (platform) => {
      const reporter = reporters[platform];
      if (!reporter) {
        return [];
      }
      try {
        const snapshot = await raceWithDeadline(() => reporter.describeCapacity(), {
          timer,
          timeoutMs: CAPACITY_REPORT_TIMEOUT_MS,
          label: `Reporting ${platform} boot capacity`,
        });
        return [[platform, snapshot] as const];
      } catch (error) {
        logger.warn(
          `[BootAdmission] ${platform} capacity report failed: ${errorMessage(error)}`,
          error,
        );
        return [];
      }
    }),
  );
  const report: BootCapacityReport = Object.fromEntries(entries.flat());
  return Object.keys(report).length > 0 ? report : undefined;
}

function gatedReporters(
  gates: SharedBootAdmissionGates,
): Partial<Record<Platform, BootCapacityReporter>> {
  return {
    ...(gates.android ? { android: gates.android } : {}),
    ...(gates.ios ? { ios: gates.ios } : {}),
  };
}
