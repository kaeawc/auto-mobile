import { ActionableError, toActionableError } from "../models";
import type { DeviceMatchCriteria } from "../models/DeviceMatchCriteria";
import { DEVICE_POOL_MATCHING } from "../daemon/poolConfig";
import type { DeviceReadinessReservation } from "../daemon/devicePool";
import { deleteInternalToolParams } from "../daemon/constants";
import type { DeviceMatcher } from "../utils/deviceMatcher";
import type { PlatformDeviceManager } from "../devices/deviceUtils";
import type { Timer } from "../utils/SystemTimer";
import type { DeviceBootResult } from "../devices/deviceBootService";
import type {
  VirtualDeviceLifecycleCoordinator,
  VirtualDeviceLifecycleLease,
} from "../devices/virtualDeviceLifecycleCoordinator";
import { stableStringify } from "../utils/stableStringify";
import { createPerformanceTracker } from "../utils/PerformanceTracker";
import { ambientPerfFor, runWithPerfTracker } from "../utils/PerfContext";
import { DEFAULT_DEVICE_READY_TIMEOUT_MS } from "../utils/deviceTimeouts";
import { DEFAULT_RUNNER_PROVISION_TIMEOUT_MS } from "../utils/runnerReadinessConfig";
import { isAndroidEmulatorSerial } from "../utils/androidSerial";
import { raceWithDeadline } from "../utils/raceWithDeadline";
import { logger } from "../utils/logger";
import { errorMessage } from "../utils/describeUnknownError";
import type { ProgressCallback } from "./toolRegistry";
import {
  acceptancePresentationOrder,
  acquisitionLifecycleTimeoutError,
  cancelUnownedColdBoot,
  describeStartDeviceRequest,
  getAndroidSchema,
  getAppleSchema,
  getDeviceToolsDependencies,
  reserveAndroidStartupLease,
  reserveStableDeviceLifecycle,
  resolveAndroidStartStableDeviceLifecycleTarget,
  runWithinShutdownDeadline,
  validateRequestedAndroidIdentifiersBeforeBoot,
} from "./deviceTools";
import type {
  DevicePreparationBudgets,
  DeviceToolsDependencies,
  GetAndroidArgs,
  GetAppleArgs,
  StableDeviceTarget,
  StartDeviceArgs,
} from "./deviceTools";
import type { createStartDeviceHandlers } from "./deviceToolsStartDevice";
import { resolveTransportDeadlineMs } from "./formTools";

// Match the cancellation settlement grace in RunnerReadinessService and DeviceBootService.
const ABORT_SETTLEMENT_GRACE_MS = 1_000;

/** Cap acquisition budgets using the existing anchored/legacy transport contract. */
export function acquisitionDeadlineMs(rawArgs: unknown, requestedDeadlineMs: number): number {
  return Math.min(
    requestedDeadlineMs,
    resolveTransportDeadlineMs(rawArgs) ?? Number.POSITIVE_INFINITY,
  );
}

async function awaitFailedAcquisitionCleanup(
  cleanup: () => Promise<void>,
  timer: Timer,
): Promise<void> {
  // raceWithDeadline observes late rejection; log it as well so a detached
  // reservation release failure remains visible after the caller has returned.
  const observedCleanup = cleanup().catch((error: unknown) => {
    logger.warn(
      `[DeviceTools] Failed acquisition reservation release failed: ${errorMessage(error)}`,
      error,
    );
  });
  try {
    await raceWithDeadline(observedCleanup, {
      timer,
      timeoutMs: ABORT_SETTLEMENT_GRACE_MS,
      label: "Failed device acquisition cleanup",
    });
  } catch (error) {
    logger.warn(
      `[DeviceTools] Failed acquisition cleanup did not settle: ${errorMessage(error)}`,
      error,
    );
  }
}

type AcquisitionHooks = {
  getBootAndPrepareDevice: () => ReturnType<
    typeof createStartDeviceHandlers
  >["bootAndPrepareDevice"];
};

async function reserveStartStableDeviceLifecycle(
  stableTarget: StableDeviceTarget | undefined,
  budgets: DevicePreparationBudgets,
  timer: Timer,
  deadlineMs: number,
  signal: AbortSignal | undefined,
  coordinator: VirtualDeviceLifecycleCoordinator,
): Promise<VirtualDeviceLifecycleLease | undefined> {
  if (!stableTarget) {
    return undefined;
  }
  return await reserveStableDeviceLifecycle(
    stableTarget,
    {
      name: stableTarget.stableId,
      platform: stableTarget.platform,
      deviceId: stableTarget.stableId,
    },
    timer,
    deadlineMs,
    {
      requestAbortSignal: signal,
      timeoutError: (detail) =>
        acquisitionLifecycleTimeoutError(
          budgets,
          `${stableTarget.platform}:${stableTarget.stableId}`,
          detail,
        ),
      operation: "start",
      coordinator: coordinator,
    },
  );
}

async function resolveStartStableDeviceLifecycleTarget(
  args: StartDeviceArgs,
  budgets: DevicePreparationBudgets,
  deviceUtils: PlatformDeviceManager,
  deviceMatcher: DeviceMatcher,
  timer: Timer,
  signal: AbortSignal | undefined,
): Promise<StableDeviceTarget | undefined> {
  if (budgets.stableTarget) {
    return budgets.stableTarget;
  }
  if (args.platform === "android" && args.deviceId) {
    return await resolveAndroidStartStableDeviceLifecycleTarget(
      args.deviceId,
      budgets.automationDeadlineMs,
      deviceUtils,
      timer,
      signal,
    );
  }
  if (args.platform !== "ios" || !args.name || args.deviceId) {
    return undefined;
  }
  const discovery = await runWithinShutdownDeadline(
    { name: args.name, platform: "ios", deviceId: args.name },
    timer,
    budgets.automationDeadlineMs,
    "iOS simulator identity discovery did not complete",
    {
      requestAbortSignal: signal,
      operation: async () =>
        await deviceUtils.getDeviceImagesDetailed("ios", {
          bypassIosDeviceListCache: true,
        }),
    },
  );
  if (!discovery.succeededPlatforms.has("ios")) {
    throw new ActionableError(
      `Cannot uniquely resolve iOS device '${args.name}' for lifecycle coordination; provide deviceId.`,
    );
  }
  const criteria: DeviceMatchCriteria = {
    platform: "ios",
    name: args.name,
    minOsVersion: args.minOsVersion,
    maxOsVersion: args.maxOsVersion,
    formFactor: args.formFactor,
    requires: args.requires,
    screenSize: args.screenSize,
  };
  const match = deviceMatcher.matchDeviceImage(
    criteria,
    discovery.devices.filter((device) => device.platform === "ios" && device.deviceId),
    DEVICE_POOL_MATCHING,
  );
  if (!match?.deviceId) {
    // This legacy name is a creation criterion when create-if-missing is
    // enabled, not the stable identity of an existing simulator.
    return undefined;
  }
  return { platform: "ios", stableId: match.deviceId };
}

async function reserveStartSelectorDeviceLifecycle(
  args: StartDeviceArgs,
  budgets: DevicePreparationBudgets,
  deps: DeviceToolsDependencies,
  signal: AbortSignal | undefined,
): Promise<VirtualDeviceLifecycleLease> {
  const selector = stableStringify({
    deviceId: args.deviceId,
    name: args.name,
    minOsVersion: args.minOsVersion,
    maxOsVersion: args.maxOsVersion,
    formFactor: args.formFactor,
    requires: args.requires,
    screenSize: args.screenSize,
  });
  try {
    return await deps.lifecycleCoordinator.reserve(
      { kind: "selector", platform: args.platform, selector },
      { operation: "start", deadlineMs: budgets.automationDeadlineMs, signal },
    );
  } catch (error) {
    // Same acquisition-phase labeling as the stable-identity path above; the
    // selector fallback had no deadline attribution at all.
    if (deps.timer.now() >= budgets.automationDeadlineMs) {
      throw acquisitionLifecycleTimeoutError(
        budgets,
        `${args.platform}:${selector}`,
        "waiting for selector device lifecycle reservation",
      );
    }
    throw error;
  }
}

async function reserveStartDeviceLifecycleReservations(
  args: StartDeviceArgs,
  budgets: DevicePreparationBudgets,
  deps: DeviceToolsDependencies,
  deviceUtils: PlatformDeviceManager,
  {
    deviceMatcher,
    bootDeadlineMs,
    signal,
  }: { deviceMatcher: DeviceMatcher; bootDeadlineMs: number; signal: AbortSignal | undefined },
): Promise<{
  releaseAndroidStartupLease: (() => Promise<void>) | undefined;
  lifecycleLease: VirtualDeviceLifecycleLease;
}> {
  let releaseAndroidStartupLease: (() => Promise<void>) | undefined;
  let lifecycleLease: VirtualDeviceLifecycleLease | undefined;
  try {
    releaseAndroidStartupLease = await reserveAndroidStartupLease(
      args,
      budgets,
      bootDeadlineMs,
      deps.timer,
      deviceUtils,
      signal,
    );
    const stableTarget = await resolveStartStableDeviceLifecycleTarget(
      args,
      budgets,
      deviceUtils,
      deviceMatcher,
      deps.timer,
      signal,
    );
    lifecycleLease =
      (await reserveStartStableDeviceLifecycle(
        stableTarget,
        budgets,
        deps.timer,
        budgets.automationDeadlineMs,
        signal,
        deps.lifecycleCoordinator,
      )) ?? (await reserveStartSelectorDeviceLifecycle(args, budgets, deps, signal));
    if (stableTarget?.platform === "ios" && args.name && !args.deviceId) {
      const revalidatedTarget = await resolveStartStableDeviceLifecycleTarget(
        args,
        budgets,
        deviceUtils,
        deviceMatcher,
        deps.timer,
        signal,
      );
      if (
        revalidatedTarget?.platform !== "ios" ||
        revalidatedTarget.stableId !== stableTarget.stableId
      ) {
        throw new ActionableError(
          `iOS simulator '${args.name}' changed while waiting for lifecycle coordination; retry the request.`,
        );
      }
    }
    return { releaseAndroidStartupLease, lifecycleLease };
  } catch (error) {
    lifecycleLease?.release();
    // This partial-reservation rollback is also on prepareDevice's failure
    // path, before its outer finally has received the reservations.
    await awaitFailedAcquisitionCleanup(async () => {
      await releaseAndroidStartupLease?.();
    }, deps.timer);
    throw error;
  }
}

async function prepareDevice(
  getBootAndPrepareDevice: AcquisitionHooks["getBootAndPrepareDevice"],
  args: StartDeviceArgs,
  budgets: DevicePreparationBudgets,
  progress?: ProgressCallback,
  signal?: AbortSignal,
) {
  const perf = createPerformanceTracker(true);
  perf.serial(budgets.operationName);
  const deps = getDeviceToolsDependencies();
  const deviceUtils = deps.deviceManagerFactory();
  const deviceMatcher = deps.deviceMatcherFactory();
  const bootDeadlineMs = Math.min(
    deps.timer.now() + budgets.bootTimeoutMs,
    budgets.automationDeadlineMs,
  );
  const requestedIdentity = describeStartDeviceRequest(args);
  const state: {
    boot: DeviceBootResult | undefined;
    ownershipTransferred: boolean;
    // Every unowned cold boot this request cancelled, recovery included, plus
    // a pre-boot reconcile still in flight when its deadline fired. The
    // lifecycle lease is released only once all of them have settled.
    coldBootSettlements: Promise<void>[];
    bindingSettlements: Promise<unknown>[];
  } = {
    boot: undefined,
    ownershipTransferred: false,
    coldBootSettlements: [],
    bindingSettlements: [],
  };
  const releaseReadinessReservations: DeviceReadinessReservation[] = [];
  let preparationFailed = false;
  let lifecycleReservations:
    | Awaited<ReturnType<typeof reserveStartDeviceLifecycleReservations>>
    | undefined;
  try {
    // Scope the pre-boot lifecycle reservation (runs `getDeviceImagesDetailed`
    // → `simctl list` discovery) so its commands attribute into perfTiming,
    // matching the boot scope inside bootAndPrepareDevice (see PerfContext).
    lifecycleReservations = await runWithPerfTracker(ambientPerfFor(perf), () =>
      reserveStartDeviceLifecycleReservations(args, budgets, deps, deviceUtils, {
        deviceMatcher: deviceMatcher,
        bootDeadlineMs: bootDeadlineMs,
        signal: signal,
      }),
    );
    const coordinatedSignals = [signal, lifecycleReservations.lifecycleLease.signal].filter(
      (candidate): candidate is AbortSignal => candidate !== undefined,
    );
    const coordinatedSignal =
      coordinatedSignals.length === 1 ? coordinatedSignals[0] : AbortSignal.any(coordinatedSignals);
    // Reject a contradictory Android avdName + deviceId pair before booting,
    // so a stopped AVD is not cold-booted and killed just to report it. Run
    // after its lifecycle lease, however, so a serial not yet visible during
    // reset recovery gets a chance to appear before discovery decides.
    await runWithPerfTracker(ambientPerfFor(perf), () =>
      validateRequestedAndroidIdentifiersBeforeBoot(
        budgets.requestedAndroidIdentifierPair,
        deviceUtils,
        bootDeadlineMs,
        deps.timer,
        coordinatedSignal,
        (settlement) => {
          if (settlement) {
            state.coldBootSettlements.push(settlement);
          }
        },
      ),
    );
    return await getBootAndPrepareDevice()(args, budgets, deps, deviceUtils, {
      deviceMatcher: deviceMatcher,
      bootDeadlineMs: bootDeadlineMs,
      requestedIdentity: requestedIdentity,
      progress: progress,
      signal: coordinatedSignal,
      perf: perf,
      releaseReadinessReservations: releaseReadinessReservations,
      lifecycleLease: lifecycleReservations.lifecycleLease,
      state: state,
    });
  } catch (error) {
    preparationFailed = true;
    perf.end();
    if (!state.ownershipTransferred) {
      const settlement = cancelUnownedColdBoot(state.boot);
      if (settlement) {
        state.coldBootSettlements.push(settlement);
      }
    }
    // The startup-lease boundary propagates raw caller abort reasons; later
    // preparation retains its established structured cancellation errors.
    if (!lifecycleReservations) {
      signal?.throwIfAborted();
    }
    if (error instanceof ActionableError) {
      throw error;
    }
    throw toActionableError(error, `Failed to start ${args.platform} device`);
  } finally {
    const cleanup = async () => {
      const releaseReadiness = async () => {
        for (const releaseReservation of releaseReadinessReservations.reverse()) {
          await releaseReservation();
        }
      };
      if (state.bindingSettlements.length > 0) {
        // A cancelled binding may still hold the assignment mutex while its
        // persistence write drains. Keep identity reservations until rollback
        // settles, but do not make the timed-out caller wait for that write.
        void Promise.allSettled([...state.bindingSettlements, ...state.coldBootSettlements])
          .then(async () => {
            try {
              await releaseReadiness();
            } finally {
              lifecycleReservations?.lifecycleLease.release();
              await lifecycleReservations?.releaseAndroidStartupLease?.();
            }
          })
          .catch((error: unknown) => {
            logger.warn(
              `[DeviceTools] Deferred binding reservation release failed: ${errorMessage(error)}`,
              error,
            );
          });
      } else {
        await releaseReadiness();
        if (state.coldBootSettlements.length > 0) {
          // Release exactly once whatever the settlements do — `finally` guarantees
          // the lease is not stranded if one completes by rejecting. Not every
          // settlement is bounded: `cancelUnownedColdBoot` waits at most two
          // grace periods, but a survivor handed over by `retainLeaseUntil` settles
          // only when its exit event fires or a periodic pid re-check finds it gone
          // (#9920), so an unkillable emulator holds the lease until then. While it
          // does, the lease reports it to start/provision requests ("held by
          // unkillable process N") instead of leaving them queued. A System UI ANR
          // replacement retired mid-recovery settles here too, so the AVD's key
          // cannot be handed to the next request while the emulator this one only
          // signalled is still running.
          void Promise.allSettled(state.coldBootSettlements)
            .finally(() => lifecycleReservations?.lifecycleLease.release())
            .catch((error: unknown) => {
              logger.warn(
                `[DeviceTools] Deferred lifecycle lease release failed: ${errorMessage(error)}`,
                error,
              );
            });
        } else {
          lifecycleReservations?.lifecycleLease.release();
        }
        await lifecycleReservations?.releaseAndroidStartupLease?.();
      }
    };
    if (!preparationFailed) {
      await cleanup();
    } else {
      // Preserve the existing release order and settlement ownership. A mutex
      // waiter cannot be cancelled; let this same cleanup finish exactly once
      // when its holder drains, without wedging the failed caller behind it.
      await awaitFailedAcquisitionCleanup(cleanup, deps.timer);
    }
  }
}

// Compatibility implementation. New callers use getAndroid/getApple so their
// platform identity and readiness budgets are explicit.
function stripInternalAcquisitionParams(rawArgs: object) {
  const externalArgs = { ...rawArgs } as Record<string, unknown>;
  deleteInternalToolParams(externalArgs);
  return externalArgs;
}
async function getAndroidHandler(
  prepareDevice: PrepareDevice,
  rawArgs: GetAndroidArgs & Record<string, unknown>,
  progress?: ProgressCallback,
  signal?: AbortSignal,
) {
  const { __mcpSessionId } = rawArgs;
  const presentationOrder = acceptancePresentationOrder(rawArgs);
  const externalArgs = stripInternalAcquisitionParams(rawArgs);
  const args = getAndroidSchema.parse(externalArgs);
  const bootTimeoutMs = args.bootTimeoutMs ?? DEFAULT_DEVICE_READY_TIMEOUT_MS;
  const automationReadyTimeoutMs =
    args.automationReadyTimeoutMs ?? DEFAULT_RUNNER_PROVISION_TIMEOUT_MS;
  const startedAtMs = getDeviceToolsDependencies().timer.now();
  const mcpSessionId = typeof __mcpSessionId === "string" ? __mcpSessionId : undefined;
  // Prefer the AVD name (exact virtual-device identity); otherwise target the
  // booted serial by deviceId (#5870). A paired AVD name and serial keeps
  // lifecycle coordination by stable name while directing boot to the
  // validated serial.
  const explicitAdbSerial =
    args.deviceId && isAndroidEmulatorSerial(args.deviceId) ? args.deviceId : undefined;
  const target: StartDeviceArgs = args.avdName
    ? {
        platform: "android",
        requires: args.requires,
        name: args.avdName,
        ...(explicitAdbSerial ? { deviceId: explicitAdbSerial } : {}),
        matchExactName: true,
        ...(presentationOrder !== undefined ? { presentationOrder } : {}),
        preferRunning: true,
        createIfMissing: false,
        __mcpSessionId: mcpSessionId,
      }
    : {
        platform: "android",
        requires: args.requires,
        deviceId: args.deviceId,
        preferRunning: true,
        createIfMissing: false,
        __mcpSessionId: mcpSessionId,
      };
  return await prepareDevice(
    target,
    {
      bootTimeoutMs,
      automationReadyTimeoutMs,
      automationDeadlineMs: acquisitionDeadlineMs(
        rawArgs,
        startedAtMs + bootTimeoutMs + automationReadyTimeoutMs,
      ),
      operationName: "getAndroid",
      ...(args.avdName
        ? {
            androidAvdName: args.avdName,
            stableTarget: { platform: "android", stableId: args.avdName },
            ...(args.deviceId
              ? {
                  requestedAndroidIdentifierPair: {
                    avdName: args.avdName,
                    deviceId: args.deviceId,
                  },
                }
              : {}),
          }
        : {}),
    },
    progress,
    signal,
  );
}

async function getAppleHandler(
  prepareDevice: PrepareDevice,
  rawArgs: GetAppleArgs & Record<string, unknown>,
  progress?: ProgressCallback,
  signal?: AbortSignal,
) {
  const { __mcpSessionId } = rawArgs;
  const presentationOrder = acceptancePresentationOrder(rawArgs);
  const externalArgs = stripInternalAcquisitionParams(rawArgs);
  const args = getAppleSchema.parse(externalArgs);
  // #5870: `deviceId` is an accepted alias for `udid` on iOS.
  const udid = args.udid ?? args.deviceId!;
  const bootTimeoutMs = args.bootTimeoutMs ?? DEFAULT_DEVICE_READY_TIMEOUT_MS;
  const automationReadyTimeoutMs =
    args.automationReadyTimeoutMs ?? DEFAULT_RUNNER_PROVISION_TIMEOUT_MS;
  const startedAtMs = getDeviceToolsDependencies().timer.now();
  return await prepareDevice(
    {
      platform: "ios",
      deviceId: udid,
      preferRunning: true,
      ...(presentationOrder !== undefined ? { presentationOrder } : {}),
      createIfMissing: false,
      __mcpSessionId: typeof __mcpSessionId === "string" ? __mcpSessionId : undefined,
    },
    {
      bootTimeoutMs,
      automationReadyTimeoutMs,
      automationDeadlineMs: acquisitionDeadlineMs(
        rawArgs,
        startedAtMs + bootTimeoutMs + automationReadyTimeoutMs,
      ),
      operationName: "getApple",
      stableTarget: { platform: "ios", stableId: udid },
    },
    progress,
    signal,
  );
}

type PrepareDevice = (
  args: StartDeviceArgs,
  budgets: DevicePreparationBudgets,
  progress?: ProgressCallback,
  signal?: AbortSignal,
) => ReturnType<typeof prepareDevice>;

export function createAcquisitionHandlers(hooks: AcquisitionHooks) {
  const { getBootAndPrepareDevice } = hooks;
  const prepare: PrepareDevice = (args, budgets, progress, signal) =>
    prepareDevice(getBootAndPrepareDevice, args, budgets, progress, signal);
  return {
    prepareDevice: prepare,
    stripInternalAcquisitionParams,
    getAndroidHandler: (
      rawArgs: GetAndroidArgs & Record<string, unknown>,
      progress?: ProgressCallback,
      signal?: AbortSignal,
    ) => getAndroidHandler(prepare, rawArgs, progress, signal),
    getAppleHandler: (
      rawArgs: GetAppleArgs & Record<string, unknown>,
      progress?: ProgressCallback,
      signal?: AbortSignal,
    ) => getAppleHandler(prepare, rawArgs, progress, signal),
  };
}
