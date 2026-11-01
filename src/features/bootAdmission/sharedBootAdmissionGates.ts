import type {
  BootCapacityReserver,
  BootReservationOptions,
  BootSlotReservation,
} from "../../devices/bootAdmission/BootSlotReservation";
import { join } from "node:path";
import { adbServerScope } from "../../daemon/foreignDeviceOwnership";
import { getAdbServerScopedAutoMobileDir } from "../../utils/tempDir";
import { FileHostBootAdmissionRegistry } from "./FileHostBootAdmissionRegistry";
import { ActionableError } from "../../models/ActionableError";
import type { Platform } from "../../models/Platform";
import { defaultAdbClientFactory } from "../../utils/android-cmdline-tools/AdbClientFactory";
import { FileAvdConfigReader } from "../../utils/android-cmdline-tools/AvdConfigReader";
import { DefaultHostCommandExecutor } from "../../utils/HostCommandExecutor";
import { SimCtlClient } from "../../utils/ios-cmdline-tools/SimCtlClient";
import { defaultTimer, type Timer } from "../../utils/SystemTimer";
import { testOverrides } from "../../utils/testOverrides";
import {
  InMemoryBootDurationHistory,
  type BootDurationHistory,
} from "../iosSimFleet/BootDurationHistory";
import type { IosSimCapacityGate, IosSimulatorOwnershipReader } from "../iosSimFleet/CapacityGate";
import { createIosSimCapacityGate } from "../iosSimFleet/defaultIosBootInstrumentation";
import { AndroidBootAdmissionGate } from "./AndroidBootAdmissionGate";
import { adbEmulatorSerialLister, CommandAndroidCapacitySource } from "./AndroidCapacitySource";
import {
  isBootCapacityGateEnabled,
  type BootCapacityReporter,
  type BootCapacitySnapshot,
} from "./BootAdmissionGate";
import { raceWithDeadline } from "../../utils/raceWithDeadline";
import { logger } from "../../utils/logger";
import { errorMessage } from "../../utils/describeUnknownError";

import { nodeProcFs } from "./procProcessTable";

const ADB_LISTING_TIMEOUT_MS = 5_000;

/**
 * Where the Android boot-admission lock and records live: one directory per adb server
 * (`adbServerScope`), under the adb-server coordination root. It ignores
 * AUTOMOBILE_COORDINATION_DIR and the data directory, so daemons that share an adb server share
 * one boot limit. The root is AUTOMOBILE_ADB_SERVER_COORDINATION_DIR when set, else the home
 * directory getAdbServerScopedAutoMobileDir resolves (which follows HOME under Bun). Daemons
 * that resolve different roots do NOT share admissions (#11903).
 */
export function androidBootAdmissionRegistryDirectory(
  env: NodeJS.ProcessEnv = process.env,
  homeDir?: string,
): string {
  return join(
    getAdbServerScopedAutoMobileDir(adbServerScope(env), "boot-admissions", env, homeDir),
    "android",
  );
}

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
let iosOwnership: IosSimulatorOwnershipReader | undefined;

/** Composition-side reader, resolved lazily even if the shared gate already exists. */
export function installIosSimulatorOwnershipReader(reader: IosSimulatorOwnershipReader): void {
  iosOwnership = reader;
}

const defaultIosOwnership: IosSimulatorOwnershipReader = {
  refresh: async () => {
    await iosOwnership?.refresh();
  },
  isAutoMobileOwned: (udid) => iosOwnership?.isAutoMobileOwned(udid) ?? false,
};

/** Lazily builds the gates from the environment on first use. */
export function getSharedBootAdmissionGates(
  deps: SharedBootAdmissionGateDeps = {},
): SharedBootAdmissionGates {
  shared ??= createBootAdmissionGates(deps);
  return shared;
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
          new CommandAndroidCapacitySource(
            adbEmulatorSerialLister(
              {
                getDeviceStates: async (options) => {
                  const adb = defaultAdbClientFactory.create(null);
                  if (!adb.getDeviceStates) {
                    // A failed listing, never zero emulators: the gate must not fail open.
                    throw new ActionableError("adb client cannot list raw device states");
                  }
                  return adb.getDeviceStates(options);
                },
              },
              ADB_LISTING_TIMEOUT_MS,
            ),
            executor,
            undefined,
            {
              timer,
              processTableSupported: (deps.hostPlatform ?? process.platform) !== "win32",
              procFs: (deps.hostPlatform ?? process.platform) === "linux" ? nodeProcFs : undefined,
            },
          ),
          timer,
          {
            env,
            resolvedHardware: async (avdName) => {
              const config = await new FileAvdConfigReader().readConfig(avdName);
              return config
                ? {
                    ...(config.effectiveRamMb === undefined
                      ? {}
                      : { guestBytes: config.effectiveRamMb * 1024 * 1024 }),
                    ...(config.effectiveCpuCores === undefined
                      ? {}
                      : { cpuCores: config.effectiveCpuCores }),
                  }
                : undefined;
            },
            hostRegistry: new FileHostBootAdmissionRegistry({
              timer,
              directory: () => androidBootAdmissionRegistryDirectory(env),
            }),
          },
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
            ownership: defaultIosOwnership,
            env,
            executor,
          }),
    iosBootHistory,
  };
}

/** The read-only half of a gate: would one more cold boot be refused now. */
export interface BootCapacityAsserter {
  assertCapacityAvailable(options: { signal?: AbortSignal }): Promise<void>;
}

/**
 * The gate whose ledger a boot of `platform` takes a slot in. Apple Watch and Apple TV simulators
 * are simulators: the iOS gate already counts every Booted simulator whatever its runtime, so their
 * boots are admitted against that same limit rather than bypassing it.
 */
export function bootGatePlatform(platform: Platform): "android" | "ios" {
  return platform === "android" ? "android" : "ios";
}

/**
 * Read-only check that one more cold boot of `platform` fits right now; throws the typed retryable
 * `BootCapacityExhaustedError` at the limit. A platform whose boots are not gated always passes.
 */
export async function assertBootCapacityAvailable(
  platform: Platform,
  options: { signal?: AbortSignal } = {},
  gates: Partial<Record<"android" | "ios", BootCapacityAsserter>> = getSharedBootAdmissionGates(),
): Promise<void> {
  await gates[bootGatePlatform(platform)]?.assertCapacityAvailable(options);
}

/** Reserve against the very same ledger that ordinary platform boots consult. */
export async function reserveBootCapacity(
  platform: Platform,
  options: BootReservationOptions,
  gates: Partial<Record<Platform, BootCapacityReserver>> = getSharedBootAdmissionGates(),
): Promise<BootSlotReservation> {
  options.signal?.throwIfAborted();
  return (
    (await gates[bootGatePlatform(platform)]?.reserveBoot(options)) ?? {
      run: (operation) => operation(),
      release: () => {},
      markReplacedDeviceGone: () => {},
    }
  );
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
      const controller = new AbortController();
      try {
        const snapshot = await raceWithDeadline(
          () => reporter.describeCapacity({ signal: controller.signal }),
          {
            timer,
            timeoutMs: CAPACITY_REPORT_TIMEOUT_MS,
            label: `Reporting ${platform} boot capacity`,
            onTimeout: () => controller.abort(),
          },
        );
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
