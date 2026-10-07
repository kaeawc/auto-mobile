import { captureAutolockPolicy } from "../daemon/deviceAutolockPolicy";
import type { HostChildProcess as ChildProcess } from "../utils/HostCommandExecutor";
import { ActionableError, BootedDevice, DeviceInfo } from "../models";
import type { DeviceMatcher } from "../utils/deviceMatcher";
import { PlatformDeviceManager } from "../devices/deviceUtils";
import { DEVICE_POOL_MATCHING } from "../daemon/poolConfig";
import { DaemonState } from "../daemon/daemonState";
import type { DeviceReadinessLevel } from "../devices/DeviceSessionManager";
import type { DeviceReadinessReservation } from "../daemon/devicePool";
import { DeviceBootService, type DeviceBootResult } from "../devices/deviceBootService";
import { IOSCtrlProxyClient } from "../features/observe/ios/IOSCtrlProxyClient";
import { IOSCtrlProxyManager } from "../ctrlProxy/IOSCtrlProxyManager";
import { AndroidCtrlProxyClient } from "../features/observe/android/AndroidCtrlProxyClient";
import { logger } from "../utils/logger";
import { createPerformanceTracker } from "../utils/PerformanceTracker";
import { ambientPerfFor, runWithPerfTracker } from "../utils/PerfContext";
import { createStructuredToolResponse, type StructuredToolResponse } from "../utils/toolUtils";
import {
  deviceReadinessLockKey,
  moveDeviceAcquisitionReadiness,
  trackDeviceAcquisitionReadiness,
} from "../utils/deviceReadinessLock";
import {
  createDefaultRunnerReadinessService,
  RunnerReadinessError,
  type RunnerReadinessRequest,
} from "../ctrlProxy/RunnerReadinessService";
import { FileQrPosterWriter } from "../utils/qr/QrPosterWriter";
import { raceWithDeadline } from "../utils/raceWithDeadline";
import { runWithAbortSignal } from "../utils/AbortContext";
import { runWithAcquisitionDeadline } from "./deviceToolsAcquisition";
import type { Timer } from "../utils/SystemTimer";
import { DEFAULT_START_DEVICE_TIMEOUT_MS } from "../utils/deviceTimeouts";
import type { VirtualDeviceLifecycleLease } from "../devices/virtualDeviceLifecycleCoordinator";
import { registerDirectSessionDevice } from "./directSessionDeviceRegistry";
import { describeDevice, projectBootedDevice } from "./deviceDescription";
import type { StartDeviceReadiness } from "./toolOutputSchemas";
import { ProgressCallback } from "./toolRegistry";
import { errorMessage } from "../utils/describeUnknownError";
import type { StableConfiguredDeviceImage } from "../utils/configuredDeviceInventory";
import {
  acquisitionLifecycleTimeoutError,
  androidSourceImageWithBootedMetadata,
  assertAndroidBootDidNotEnterRecovery,
  clearColdBootShutdownMarker,
  configuredImageForAcquiredDevice,
  deviceIdentityPayload,
  getDeviceToolsDependencies,
  getStartDevicePool,
  getVerifiedWarmAndroidAvdIdentity,
  initializedDevicePool,
  prepareStartDeviceRunnerReadiness,
  publishWarmDeviceReady,
  refreshResourcesAfterCommittedBoot,
  reserveInitialDeviceForReadiness,
  resolveRunnerReadinessTimeoutMs,
  runOperationWithinDeadline,
  setAcquisitionStage,
  startDeviceSchema,
  validateBootIdentity,
  validatePooledDeviceMapping,
  validatePreservedSystemUiAnrRecoverySession,
  validateRequestedAndroidSerial,
} from "./deviceTools";
import type {
  DevicePreparationBudgets,
  DeviceToolsDependencies,
  StartDeviceArgs,
} from "./deviceTools";

type StartDeviceHooks = {
  prepareDevice: (
    args: StartDeviceArgs,
    budgets: DevicePreparationBudgets,
    progress?: ProgressCallback,
    signal?: AbortSignal,
  ) => Promise<StructuredToolResponse>;
  stripInternalAcquisitionParams: (rawArgs: object) => Record<string, unknown>;
};

/** Bound a request's wait; shared removal cleanup must retain its own lifetime. */
async function waitForDevicePreparation<T>(
  operation: (signal?: AbortSignal) => Promise<T>,
  options: {
    timer: Pick<Timer, "now" | "setTimeout" | "clearTimeout">;
    deadlineMs: number;
    signal?: AbortSignal;
    timeoutError: () => Error;
    cancelOperation?: boolean;
  },
): Promise<T> {
  const { timer, deadlineMs, signal, timeoutError, cancelOperation } = options;
  // Caller cancellation takes precedence even when the deadline is already past.
  signal?.throwIfAborted();
  const remainingMs = Math.floor(deadlineMs - timer.now());
  if (remainingMs <= 0) {
    throw timeoutError();
  }
  if (cancelOperation) {
    return await runOperationWithinDeadline(timer, deadlineMs, signal, timeoutError, operation);
  }
  return await raceWithDeadline(() => runWithAbortSignal(undefined, () => operation()), {
    timer,
    timeoutMs: remainingMs,
    signal,
    label: "Device preparation",
    timeoutError,
  });
}

type BootPreparationOptions = {
  autolockEnabled: boolean;
  deviceMatcher: DeviceMatcher;
  bootDeadlineMs: number;
  requestedIdentity: string;
  progress: ProgressCallback | undefined;
  signal: AbortSignal | undefined;
  perf: ReturnType<typeof createPerformanceTracker>;
  releaseReadinessReservations: DeviceReadinessReservation[];
  lifecycleLease: VirtualDeviceLifecycleLease;
  state: {
    boot: DeviceBootResult | undefined;
    ownershipTransferred: boolean;
    // Every unowned cold boot this request cancelled, recovery included. The
    // lifecycle lease is released only once all of them have settled.
    coldBootSettlements: Promise<void>[];
    bindingSettlements: Promise<unknown>[];
  };
};

const bootAndPrepareDevice = async (
  args: StartDeviceArgs,
  budgets: DevicePreparationBudgets,
  deps: DeviceToolsDependencies,
  deviceUtils: PlatformDeviceManager,
  options: BootPreparationOptions,
) => {
  const {
    deviceMatcher,
    bootDeadlineMs,
    requestedIdentity,
    progress,
    signal,
    perf,
    releaseReadinessReservations,
    lifecycleLease,
    state,
  } = options;
  // Excludes pre-boot reservations; includes boot, runner recovery, and session binding.
  const readinessStartedAtMs = deps.timer.now();
  const preparation: BootPreparationState = { recovered: false, sourceImage: undefined };
  const bootService = new DeviceBootService({
    deviceManager: deviceUtils,
    deviceMatcher,
    displayInventory: deps.displayInventory,
    deviceCreationGate: deps.deviceCreationGateFactory(),
    deviceProvisioner: deps.deviceProvisionerFactory(),
    matchingStrategy: DEVICE_POOL_MATCHING,
    timer: deps.timer,
    lifecycleLease,
    allowExternalLeaseAdoptionRecheck: true,
    lifecycleCoordinator: deps.lifecycleCoordinator,
    // An owned emulator that survives SIGKILL keeps the lease held until it exits (#9901).
    retainLeaseUntil: (settlement) => state.coldBootSettlements.push(settlement),
    // The daemon outlives the request, so a cancelled boot's cleanup finishes in the background (#9920).
    cleanupMayOutliveRequest: true,
    onAndroidColdBootTrackingChanged: () => {
      void deps.notifyDeviceInventoryResourcesChanged(false).catch((error) => {
        logger.warn(
          `[DeviceTools] Resource notify after cold-boot tracking change failed: ${errorMessage(error)}`,
          error,
        );
      });
    },
  });
  perf.startOperation("bootDevice");
  const recoveryTargets =
    args.platform === "android"
      ? getStartDevicePool(DaemonState.getInstance())?.getRecoveringAndroidTargets()
      : undefined;
  // Establish the (--debug-perf-gated) ambient tracker around the shared
  // acquisition boot attempt (getAndroid/getApple/startDevice), matching
  // provisionDevice's boot scope, so the emulator/simctl/adb discovery, boot,
  // and boot-readiness commands attribute their spans here (see PerfContext).
  state.boot = await runWithPerfTracker(ambientPerfFor(perf), () =>
    bootService.boot(
      {
        ...args,
        operationName: budgets.operationName,
        timeoutMs: budgets.bootTimeoutMs,
        totalDeadlineMs: bootDeadlineMs,
        signal,
        excludeDeviceNames: recoveryTargets?.names,
        excludeDeviceIds: recoveryTargets?.serials,
      },
      progress ? { report: progress } : undefined,
    ),
  );
  assertAndroidBootDidNotEnterRecovery(args, state.boot);
  perf.endOperation("bootDevice");
  validateBootIdentity(args, state.boot.device, state.boot.source, state.boot.sourceImage);
  validateRequestedAndroidSerial(
    budgets.requestedAndroidIdentifierPair,
    state.boot.device,
    state.boot.sourceImage,
  );
  validatePooledDeviceMapping(state.boot.device, requestedIdentity);
  // A warm AVD has no cold-boot source image, but its explicit getAndroid
  // identifier is still the stable identity needed for later recovery.
  preparation.sourceImage =
    state.boot.sourceImage ??
    (budgets.androidAvdName
      ? {
          name: budgets.androidAvdName,
          platform: "android" as const,
          isRunning: true,
          source: "local" as const,
        }
      : undefined);
  preparation.sourceImage = androidSourceImageWithBootedMetadata(
    state.boot.device,
    preparation.sourceImage,
    initializedDevicePool()?.getDevice(state.boot.device.deviceId)?.androidImage,
  );
  const daemonState = DaemonState.getInstance();
  await reserveBootReadiness(args, budgets, deps, daemonState, options);

  // A new incarnation must not inherit a prior intentional-shutdown marker
  // while its per-device runner setup is in flight.
  clearColdBootShutdownMarker(state.boot.source, state.boot.device.deviceId);

  if (state.boot.device.platform === "ios") {
    await waitForBootedIosRunnerCleanup(budgets, deps, options);
  }

  const ctrlProxySetup = deps.ensureCtrlProxyReady ?? ensureCtrlProxyReady;
  // #6280 P2 follow-up: mark this device's readiness lock key as having an
  // acquisition in flight for the ENTIRE span from runner setup through
  // session bind/record, not just while the readiness lock itself is held.
  // `RunnerReadinessService.ensureReady` (invoked inside
  // `prepareStartDeviceRunnerReadiness`) releases that lock the instant
  // CtrlProxy setup finishes — well before this function goes on to bind
  // (or reuse) the session and record its achieved readiness below. A
  // concurrent tool call on an already-known session UUID (a post-restart
  // recovered session reused rather than freshly created here) can queue
  // behind the readiness lock and acquire it in that gap; without this
  // marker it would observe still-unrecorded readiness and redundantly
  // reset/rerun CtrlProxy on the device just prepared.
  // `ensureReadinessUpgraded` in `ToolExecutionContext` awaits this marker
  // instead of racing a second setup.
  const acquisitionReadinessKey = deviceReadinessLockKey(
    state.boot.device.platform,
    state.boot.device.deviceId,
  );
  const sessionId = await trackDeviceAcquisitionReadiness(acquisitionReadinessKey, async () => {
    setAcquisitionStage(budgets, "preparing the automation runner");
    const readinessResult = await prepareStartDeviceRunnerReadiness({
      autolockEnabled: options.autolockEnabled,
      boot: state.boot!,
      args,
      operationName: budgets.operationName,
      bootService,
      deviceUtils,
      daemonState,
      totalDeadlineMs: budgets.automationDeadlineMs,
      readinessTimeoutMs: budgets.automationReadyTimeoutMs,
      timer: deps.timer,
      signal,
      progress,
      perf,
      requestedIdentity,
      ensureCtrlProxyReady: ctrlProxySetup,
      releaseReadinessReservations,
      publishRecoveredReadinessMarker: (replacement) =>
        moveDeviceAcquisitionReadiness(
          acquisitionReadinessKey,
          deviceReadinessLockKey(replacement.platform, replacement.deviceId),
        ),
      collectColdBootSettlement: (settlement) => {
        if (settlement) {
          state.coldBootSettlements.push(settlement);
        }
      },
    });
    return await bindPreparedDevice(args, budgets, deps, {
      ...options,
      daemonState,
      preparation,
      readinessResult,
      acquisitionReadinessKey,
    });
  });
  state.ownershipTransferred = true;

  refreshResourcesAfterCommittedBoot(state.boot, deps);
  return buildBootedResponse(state.boot.device, state.boot.source, perf, sessionId, {
    readiness: {
      level: "automationReady",
      checks: ["bootCompleted", "runnerReady", "sessionBound"],
      elapsedMs: deps.timer.now() - readinessStartedAtMs,
      recovered: preparation.recovered,
    },
    processId: state.boot.processId,
    sourceImage: preparation.sourceImage,
    configuredImage: configuredImageForAcquiredDevice(state.boot.device, preparation.sourceImage),
  });
};

type BootPreparationState = {
  recovered: boolean;
  sourceImage: DeviceInfo | undefined;
};

async function waitForBootedIosRunnerCleanup(
  budgets: DevicePreparationBudgets,
  deps: DeviceToolsDependencies,
  { state, signal, requestedIdentity }: BootPreparationOptions,
): Promise<void> {
  setAcquisitionStage(budgets, "waiting for iOS runner removal cleanup");
  IOSCtrlProxyClient.resumeAfterDeviceStart(state.boot!.device.deviceId);
  // Removal cleanup can still be draining after simctl reports the new boot.
  await waitForDevicePreparation(
    async () =>
      await IOSCtrlProxyManager.getExistingInstance(
        state.boot!.device.deviceId,
      )?.rearmAfterDeviceReappearance(),
    {
      timer: deps.timer,
      deadlineMs: budgets.automationDeadlineMs,
      signal,
      timeoutError: () =>
        acquisitionLifecycleTimeoutError(
          budgets,
          requestedIdentity,
          "waiting for iOS runner removal cleanup",
        ),
    },
  );
}

async function reserveBootReadiness(
  args: StartDeviceArgs,
  budgets: DevicePreparationBudgets,
  deps: DeviceToolsDependencies,
  daemonState: DaemonState,
  { state, signal, requestedIdentity, releaseReadinessReservations }: BootPreparationOptions,
): Promise<void> {
  setAcquisitionStage(budgets, "reserving the device for readiness");
  const initialReservations: DeviceReadinessReservation[] = [];
  let reservationAccepted = false;
  let reservationAbandoned = false;
  const releaseInitialReservations = async () => {
    for (const release of initialReservations.splice(0)) {
      try {
        await release();
      } catch (error) {
        logger.warn(
          `[DeviceTools] Late initial readiness reservation release failed: ${errorMessage(error)}`,
          error,
        );
      }
    }
  };
  try {
    await waitForDevicePreparation(
      async (reservationSignal) => {
        await reserveInitialDeviceForReadiness(
          daemonState,
          state.boot!,
          initialReservations,
          args.__mcpSessionId,
        );
        // A grant can win the mutex just as the caller loses its deadline race.
        // Never publish that orphan into the caller's already-drained release list.
        if (reservationAbandoned || reservationSignal?.aborted) {
          await releaseInitialReservations();
          reservationSignal?.throwIfAborted();
        }
      },
      {
        timer: deps.timer,
        deadlineMs: budgets.automationDeadlineMs,
        signal,
        cancelOperation: true,
        timeoutError: () =>
          acquisitionLifecycleTimeoutError(
            budgets,
            requestedIdentity,
            "reserving the device for readiness",
          ),
      },
    );
    releaseReadinessReservations.push(...initialReservations.splice(0));
    reservationAccepted = true;
  } finally {
    if (!reservationAccepted) {
      reservationAbandoned = true;
      // Do not let a release queued behind the same mutex hold up cancellation.
      void releaseInitialReservations();
    }
  }
}

async function bindPreparedDevice(
  args: StartDeviceArgs,
  budgets: DevicePreparationBudgets,
  deps: DeviceToolsDependencies,
  {
    state,
    signal,
    requestedIdentity,
    releaseReadinessReservations,
    daemonState,
    preparation,
    readinessResult,
    acquisitionReadinessKey,
    autolockEnabled,
  }: BootPreparationOptions & {
    daemonState: DaemonState;
    preparation: BootPreparationState;
    readinessResult: Awaited<ReturnType<typeof prepareStartDeviceRunnerReadiness>>;
    acquisitionReadinessKey: string;
  },
): Promise<string> {
  setAcquisitionStage(budgets, "binding the device session");
  try {
    // The System UI ANR recovery branch below skips `runOperationWithinDeadline`,
    // so check cancellation before any binding side effect (#6034).
    await throwIfBindingAborted(signal, readinessResult);
    state.boot = readinessResult.boot;
    preparation.recovered = readinessResult.recovered;
    validateBootIdentity(args, state.boot.device, state.boot.source, state.boot.sourceImage);
    moveDeviceAcquisitionReadiness(
      acquisitionReadinessKey,
      deviceReadinessLockKey(state.boot.device.platform, state.boot.device.deviceId),
    );
    preparation.sourceImage = state.boot.sourceImage ?? preparation.sourceImage;
    preparation.sourceImage = androidSourceImageWithBootedMetadata(
      state.boot.device,
      preparation.sourceImage,
      initializedDevicePool()?.getDevice(state.boot.device.deviceId)?.androidImage,
    );
    // Re-check under the later binding lock because pool identity can change
    // while runner setup is in flight.
    validatePooledDeviceMapping(state.boot.device, requestedIdentity);

    // Publish only after runner health passes. Readiness remains per-device,
    // so 20-40 concurrent emulators do not serialize on a host-wide gate.
    publishWarmDeviceReady(state.boot.source, state.boot.device.deviceId);
    await validatePreservedSystemUiAnrRecoverySession(
      readinessResult.preservedSessionId,
      readinessResult.validatePreservedSession,
      readinessResult.retireReplacement,
    );
    const verifiedWarmAndroidAvdIdentity = getVerifiedWarmAndroidAvdIdentity(
      state.boot,
      preparation.sourceImage,
    );
    // Recovery must revalidate the caller through the same autolock path;
    // a preserved UUID alone is not proof that this client owns the session.
    // Reuse the acquisition snapshot for recovery, binding, and readiness recording.
    const boundSessionId =
      readinessResult.preservedSessionId && !autolockEnabled
        ? readinessResult.preservedSessionId
        : await runOperationWithinDeadline(
            deps.timer,
            budgets.automationDeadlineMs,
            signal,
            () =>
              acquisitionLifecycleTimeoutError(
                budgets,
                requestedIdentity,
                "binding the device session",
              ),
            async () =>
              await bindBootedDeviceSession(
                state.boot!.device,
                args,
                state.boot!.sourceImage && !readinessResult.preservedSessionId
                  ? preparation.sourceImage
                  : undefined,
                // Recovery already registered this process and its output tail.
                readinessResult.preservedSessionId ? undefined : state.boot!.processHandle,
                {
                  readinessReservationOwners: new Set(
                    releaseReadinessReservations.map((reservation) => reservation.owner),
                  ),
                  verifiedAndroidAvdIdentity: verifiedWarmAndroidAvdIdentity,
                  autolockEnabled,
                  achievedReadiness: "automationReady",
                  collectCancellationSettlement: (settlement) => {
                    state.bindingSettlements.push(settlement);
                  },
                },
              ),
            (settlement) => {
              state.bindingSettlements.push(settlement);
            },
          );
    if (readinessResult.preservedSessionId && !autolockEnabled) {
      // Preserved-session validation can outlast the deadline; recheck before committing.
      await throwIfBindingAborted(signal, readinessResult);
      // #6227 round 7: without autolock, System UI ANR recovery bypasses
      // `bindBootedDeviceSession` (and therefore its own
      // `recordAcquiredSessionReadiness` call) entirely when a preserved
      // session is being reused. But by this point
      // `prepareStartDeviceRunnerReadiness` has already run the *same*
      // `ensureCtrlProxyReady` setup this function always awaits for a
      // freshly-bound session — recovery re-verified runner readiness on the
      // replacement device before handing back `preservedSessionId` (see
      // `ensureRunnerReadyWithSystemUiAnrRecovery`) — so the achieved level
      // here is unconditionally `automationReady`, exactly like the
      // freshly-bound branch. Recording it here closes the gap where a
      // recovered session's readiness cache stayed `undefined` and the first
      // `automationReady` tool after recovery redundantly re-ran setup.
      // WITH autolock the branch above went through `bindBootedDeviceSession`
      // instead, and `autolockDevice` already recorded readiness for the
      // session it returned — which need not be `preservedSessionId`, so
      // recording it here would bump an unrelated session's expiry.
      recordAcquiredSessionReadiness(
        daemonState,
        readinessResult.preservedSessionId,
        "automationReady",
      );
    }
    return boundSessionId;
  } finally {
    readinessResult.releaseRecoveryRouteLease?.();
  }
}

/**
 * Reject a binding whose acquisition was already cancelled, retiring a System UI
 * ANR replacement the same way a failed recovered-readiness check does.
 */
async function throwIfBindingAborted(
  signal: AbortSignal | undefined,
  readinessResult: Awaited<ReturnType<typeof prepareStartDeviceRunnerReadiness>>,
): Promise<void> {
  if (!signal?.aborted) {
    return;
  }
  try {
    await readinessResult.retireReplacement?.();
  } catch (error) {
    logger.warn(
      `[DeviceTools] Failed to retire System UI recovery replacement after cancellation: ${errorMessage(error)}`,
      error,
    );
  }
  signal.throwIfAborted();
}

async function ensureCtrlProxyReady(request: RunnerReadinessRequest): Promise<void> {
  request.perf?.startOperation("ensureCtrlProxy");
  try {
    const timer = getDeviceToolsDependencies().timer;
    const preparationOptions = {
      timer,
      deadlineMs: request.totalDeadlineMs,
      signal: request.signal,
      timeoutError: () =>
        new RunnerReadinessError(
          `${request.operationName ?? "startDevice"} automation runner readiness failed: ` +
            `platform=${request.device.platform} requested=[${request.requestedIdentity}] ` +
            `resolved=[${request.device.name} (${request.device.deviceId})] phase=runner-setup ` +
            "attempts=0 remainingBudgetMs=0: device preparation deadline exhausted",
          false,
          true,
          "runner-setup",
          0,
        ),
    };
    const pool = getStartDevicePool(DaemonState.getInstance());
    if (
      pool &&
      (await waitForDevicePreparation(
        async () => await pool.isShutdownReserved(request.device.deviceId),
        preparationOptions,
      ))
    ) {
      throw new ActionableError(`Device '${request.device.deviceId}' is shutting down.`);
    }
    if (request.device.platform === "ios") {
      IOSCtrlProxyClient.resumeAfterDeviceStart(request.device.deviceId);
      await waitForDevicePreparation(
        async () =>
          await IOSCtrlProxyManager.getExistingInstance(
            request.device.deviceId,
          )?.rearmAfterDeviceReappearance(),
        preparationOptions,
      );
    } else if (request.device.platform === "android") {
      AndroidCtrlProxyClient.resumeAfterDeviceStart(request.device.deviceId);
    }
    await createDefaultRunnerReadinessService(getDeviceToolsDependencies().timer).ensureReady(
      request,
    );
  } finally {
    request.perf?.endOperation("ensureCtrlProxy");
  }
}

async function bindBootedDeviceSession(
  device: BootedDevice,
  args: StartDeviceArgs,
  sourceImage?: DeviceInfo,
  childProcess?: ChildProcess | null,
  {
    autolockEnabled = captureAutolockPolicy(getDeviceToolsDependencies().env),
    readinessReservationOwners,
    verifiedAndroidAvdIdentity,
    achievedReadiness = "automationReady",
    collectCancellationSettlement,
  }: {
    autolockEnabled?: boolean;
    readinessReservationOwners?: ReadonlySet<symbol>;
    verifiedAndroidAvdIdentity?: DeviceInfo;
    achievedReadiness?: DeviceReadinessLevel;
    collectCancellationSettlement?: (settlement: Promise<void>) => void;
  } = {},
): Promise<string> {
  // Reserve the exact ready device before resource notifications publish it
  // to concurrent allocators.
  const daemonState = DaemonState.getInstance();
  if (autolockEnabled && daemonState.isInitialized()) {
    const autolockSessionId = await daemonState
      .getDevicePool()
      .autolockDevice(
        device.deviceId,
        device.platform,
        args.__mcpSessionId,
        sourceImage,
        childProcess,
        device,
        readinessReservationOwners,
        verifiedAndroidAvdIdentity,
        achievedReadiness,
        collectCancellationSettlement,
        { autolockEnabled },
      );
    if (autolockSessionId) {
      // #6227 (round 9): readiness is recorded INSIDE `autolockDevice`, before
      // it publishes the session to the `mcpSessionAutolockMap` route, so a
      // concurrent tool call from the same MCP client cannot observe an
      // unrecorded readiness. Recording here (after exposure) would reopen
      // that race, so it must not move back out.
      return autolockSessionId;
    }
  }

  const sessionId = getDeviceToolsDependencies().idGenerator.next();
  if (!daemonState.isInitialized()) {
    registerDirectSessionDevice(sessionId, device);
    return sessionId;
  }
  const boundSessionId = await daemonState
    .getDevicePool()
    .bindOrReuseDeviceSession(
      sessionId,
      device.deviceId,
      device.platform,
      sourceImage,
      childProcess,
      device,
      false,
      readinessReservationOwners,
      verifiedAndroidAvdIdentity,
      undefined,
      args.__mcpSessionId,
    );
  recordAcquiredSessionReadiness(daemonState, boundSessionId, achievedReadiness);
  return boundSessionId;
}

/**
 * Record the readiness level actually ACHIEVED by acquisition for a session
 * bound by `bindBootedDeviceSession` (#6227 P1 follow-up, round 6 fix). By
 * the time that function runs, the caller has already awaited whatever
 * readiness setup it chose to run for this device: normal `getAndroid` /
 * `startDevice` acquisition always awaits `prepareStartDeviceRunnerReadiness`
 * successfully, so CtrlProxy / accessibility-service setup is genuinely done
 * and `automationReady` is correct. But `provisionDevice({ readiness: "none" })`
 * deliberately SKIPS that setup in `ensureProvisionDeviceReadiness` — for that
 * path recording a hardcoded `automationReady` would be a lie: a later
 * `observe` (or any other `automationReady`-requiring tool) would see the
 * session's `deviceReadiness` slot already satisfied and skip the setup it
 * still needs. Callers must pass the readiness level actually achieved
 * (`achievedReadiness`), not assume the highest one.
 *
 * Called directly (bypassing `bindBootedDeviceSession`) from
 * `bootAndPrepareDevice`'s `readinessResult.preservedSessionId` branch too
 * (#6227 round 7): recovery re-verifies runner readiness on the
 * replacement device before handing back a preserved session id, so that
 * path's achieved level is likewise always `automationReady`.
 *
 * The setter this delegates to (`SessionManager.setDeviceReadiness`) is
 * monotonic by achieved level (#6227 round 7): a lower level passed here
 * for a session that already recorded a higher one is a no-op rather than
 * a downgrade, so callers do not need to compare against the existing
 * record themselves.
 */
function recordAcquiredSessionReadiness(
  daemonState: DaemonState,
  sessionId: string,
  achievedReadiness: DeviceReadinessLevel,
): void {
  daemonState.getSessionManager().setDeviceReadiness(sessionId, achievedReadiness);
}

function buildBootedResponse(
  device: BootedDevice,
  source: "booted" | "cold-boot",
  perf: ReturnType<typeof createPerformanceTracker>,
  sessionId: string,
  {
    readiness,
    processId,
    sourceImage,
    configuredImage,
    achievedReadiness = "automationReady",
  }: {
    readiness: StartDeviceReadiness;
    processId?: number;
    sourceImage?: DeviceInfo;
    configuredImage?: StableConfiguredDeviceImage;
    achievedReadiness?: DeviceReadinessLevel;
  },
) {
  perf.end();
  const timing = perf.getTimings();
  const description = describeDevice({
    kind: "booted",
    device,
    pooled: initializedDevicePool()?.getDevice(device.deviceId) ?? undefined,
    discovery: sourceImage,
    configured: configuredImage,
    session: { sessionId },
    serviceStatus:
      achievedReadiness === "automationReady"
        ? { installed: true, enabled: true, running: true, isCompatible: true }
        : { installed: true, enabled: true, running: false, isCompatible: true },
  });
  const acquisition = source === "booted" ? "already-booted" : "cold-boot";
  const projected = projectBootedDevice(description);
  return createStructuredToolResponse({
    message: `${device.platform} '${device.name}' is ready (${source})`,
    ...projected,
    deviceIdentity: deviceIdentityPayload(device, sourceImage),
    processId: processId ?? null,
    isReady: true,
    acquisition,
    readiness,
    // TimingData's runtime shape is serialized as the legacy flat result.
    // oxlint-disable-next-line auto-mobile/no-unknown-cast
    timing: (timing ?? {}) as unknown as Record<string, number>,
  });
}

function validateCameraPosterPlatform(args: StartDeviceArgs): void {
  if (args.cameraPosterPath !== undefined && args.platform !== "android") {
    throw new ActionableError(
      "cameraPosterPath is unsupported on iOS. Use a stopped Android emulator.",
    );
  }
  if (args.cameraPosterQr !== undefined && args.platform !== "android") {
    throw new ActionableError(
      "cameraPosterQr is unsupported on iOS. Use a stopped Android emulator.",
    );
  }
}

/** Replace `cameraPosterQr` with the rendered poster's `cameraPosterPath`. */
async function resolveCameraPosterQr<T extends StartDeviceArgs>(args: T): Promise<T> {
  const { cameraPosterQr, ...rest } = args;
  if (cameraPosterQr === undefined) {
    return args;
  }
  const writer = getDeviceToolsDependencies().cameraPosterQrWriter ?? new FileQrPosterWriter();
  return { ...rest, cameraPosterPath: await writer.writePoster(cameraPosterQr.text) } as T;
}

export function createStartDeviceHandlers(hooks: StartDeviceHooks) {
  const { prepareDevice, stripInternalAcquisitionParams } = hooks;

  const startDeviceHandler = async (
    rawArgs: StartDeviceArgs,
    progress?: ProgressCallback,
    signal?: AbortSignal,
  ) => {
    const internalSessionId = rawArgs.__mcpSessionId;
    const args = {
      ...startDeviceSchema.parse(stripInternalAcquisitionParams(rawArgs)),
      __mcpSessionId: internalSessionId,
    };
    validateCameraPosterPlatform(args);
    const resolvedArgs = await resolveCameraPosterQr(args);
    const exactAndroidAvdName = args.platform === "android" ? args.avdName : undefined;
    const target = {
      ...resolvedArgs,
      ...(exactAndroidAvdName ? { name: exactAndroidAvdName, matchExactName: true } : {}),
    };
    const totalTimeoutMs = args.timeoutMs ?? DEFAULT_START_DEVICE_TIMEOUT_MS;
    return await runWithAcquisitionDeadline(
      rawArgs,
      getDeviceToolsDependencies().timer.now() + totalTimeoutMs,
      signal,
      "startDevice",
      (deadlineMs, requestSignal, stage) =>
        prepareDevice(
          target,
          {
            bootTimeoutMs: totalTimeoutMs,
            automationReadyTimeoutMs: resolveRunnerReadinessTimeoutMs(args),
            automationDeadlineMs: deadlineMs,
            stage,
            operationName: "startDevice",
            stableTarget:
              args.platform === "android" && target.name && !args.deviceId
                ? { platform: "android", stableId: target.name }
                : args.platform === "ios" && args.deviceId
                  ? { platform: "ios", stableId: args.deviceId }
                  : undefined,
            ...(args.platform === "android" && args.avdName && args.deviceId
              ? {
                  androidAvdName: args.avdName,
                  requestedAndroidIdentifierPair: {
                    avdName: args.avdName,
                    deviceId: args.deviceId,
                  },
                }
              : {}),
          },
          progress,
          requestSignal,
        ),
    );
  };

  return {
    bootAndPrepareDevice,
    startDeviceHandler,
    bindBootedDeviceSession,
    recordAcquiredSessionReadiness,
    ensureCtrlProxyReady,
  };
}
