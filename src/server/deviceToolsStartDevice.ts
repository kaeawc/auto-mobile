import {
  internalMcpSessionId,
  internalOneShotCli,
  internalRestartResumeSessionUuid,
  internalRestartResumeTargets,
} from "./internalToolParams";
import { disabledDeviceResourceReport } from "../utils/iosDeviceResourceImpact";
import type { DeviceBootResult } from "../devices/deviceBootSelection";
import { captureAutolockPolicy } from "../daemon/deviceAutolockPolicy";
import { getProvisionedDeviceTransportFence } from "../utils/provisionedDeviceTransportFence";
import type { HostChildProcess as ChildProcess } from "../utils/HostCommandExecutor";
import { DeviceShuttingDownError } from "../models/deviceAcquisitionRefusals";
import { ActionableError, BootedDevice, DeviceInfo, type Platform } from "../models";
import { PlatformDeviceManager } from "../devices/deviceUtils";
import { DEVICE_POOL_MATCHING } from "../daemon/poolConfig";
import type { DaemonStateLike } from "../daemon/daemonState";
import { lifecycleRequester } from "../features/deviceLifecycle/lifecycleRequester";
import { type SessionRecoveryTarget } from "../daemon/sessionManager";
import type { DeviceReadinessLevel } from "../daemon/readiness/DeviceReadiness";
import { recordAcquiredSessionReadiness } from "./recordAcquiredSessionReadiness";
import { type AcquisitionReceipt } from "../daemon/acquisitionReceipt";
import type { DeviceReadinessReservation } from "../daemon/devicePool";
import { DeviceBootService } from "../devices/deviceBootService";
import { IOSCtrlProxyClient } from "../features/observe/ios/IOSCtrlProxyClient";
import { IOSCtrlProxyManager } from "../ctrlProxy/IOSCtrlProxyManager";
import { AndroidCtrlProxyClient } from "../features/observe/android/AndroidCtrlProxyClient";
import { logger } from "../utils/logger";
import { createPerformanceTracker, isDebugPerfEnabled } from "../utils/PerformanceTracker";
import { ambientPerfFor, runWithPerfTracker } from "../utils/PerfContext";
import { createStructuredToolResponse, type StructuredToolResponse } from "../utils/toolUtils";
import {
  deviceReadinessLockKey,
  moveDeviceAcquisitionReadiness,
  trackDeviceAcquisitionReadiness,
} from "../utils/deviceReadinessLock";
import {
  RunnerReadinessError,
  type RunnerReadinessRequest,
} from "../ctrlProxy/RunnerReadinessService";
import { createDefaultRunnerReadinessService } from "../daemon/defaultRunnerReadinessService";
import { FileQrPosterWriter } from "../utils/qr/QrPosterWriter";
import { raceWithDeadline } from "../utils/raceWithDeadline";
import { getAbortSignal } from "../utils/AbortContext";
import { DEFAULT_START_DEVICE_TIMEOUT_MS } from "../utils/deviceTimeouts";
import { registerDirectSessionDevice } from "../utils/directSessionDeviceRegistry";
import { describeDevice, projectBootedDevice } from "../daemon/deviceDescription";
import type { StartDeviceReadiness } from "./toolOutputSchemas";
import { ProgressCallback } from "./toolRegistry";
import { errorMessage } from "../utils/describeUnknownError";
import type { StableConfiguredDeviceImage } from "../utils/configuredDeviceInventory";
import { runWithAcquisitionDeadline } from "./deviceToolsAcquisition";
import { isWatchStartRequest, startWatchDevice } from "./deviceToolsWatchOs";
import {
  DevicePreparationBudgets,
  DeviceToolsDependencies,
  StartDeviceArgs,
  type StartDeviceSessionArgs,
  type StartDeviceRequest,
  acquisitionLifecycleTimeoutError,
  androidSourceImageWithBootedMetadata,
  assertAndroidBootDidNotEnterRecovery,
  bindUndoneIfUndelivered,
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
  admitRestartReservedStart,
  startRequester,
} from "../features/deviceLifecycle/deviceLifecycleCore";
import {
  CreatedDeviceRollback,
  waitForDevicePreparation,
  BootPreparationOptions,
  createdDeviceRollbackFor,
  rollbackCreatedDeviceAfterBoot,
  recordStartedDevice,
  startMatchExclusions,
  devicesHeldByOtherSessions,
} from "./deviceToolsBootPreparation";
export { type CreatedDeviceRollback } from "./deviceToolsBootPreparation";

type StartDeviceHooks = {
  prepareDevice: (
    args: StartDeviceArgs,
    budgets: DevicePreparationBudgets,
    progress?: ProgressCallback,
    signal?: AbortSignal,
  ) => Promise<StructuredToolResponse>;
  stripInternalAcquisitionParams: (rawArgs: object) => Record<string, unknown>;
};

function explicitDeviceOwnershipCheck(daemonState: DaemonStateLike) {
  return async (deviceId: string, platform: Platform): Promise<void> => {
    await getStartDevicePool(daemonState)?.assertNotClaimedByForeignDaemon(
      deviceId,
      platform,
      undefined,
      0,
    );
  };
}

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
    rollbackCreatedDevice: createdDeviceRollbackFor(options),
    checkBootCapacity: deps.checkBootCapacity,
    assertExplicitDeviceNotForeignOwned: explicitDeviceOwnershipCheck(deps.daemonState),
    onAndroidColdBootTrackingChanged: () => {
      void deps.notifyDeviceInventoryResourcesChanged(false).catch((error) => {
        logger.warn(
          `[DeviceTools] Resource notify after cold-boot tracking change failed: ${errorMessage(error)}`,
          error,
        );
      });
    },
  });
  admitRestartReservedStart(args);
  const exclusions = await startMatchExclusions(args, deps.daemonState);
  const deferDeviceIds = devicesHeldByOtherSessions(args, deps.daemonState);
  perf.startOperation("bootDevice");
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
        ...exclusions,
        deferDeviceIds,
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
  const mappingOptions = { signal, totalDeadlineMs: budgets.automationDeadlineMs };
  await validatePooledDeviceMapping(state.boot.device, requestedIdentity, mappingOptions);
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
  await reserveBootReadiness(args, budgets, deps, deps.daemonState, options);

  // A new incarnation must not inherit a prior intentional-shutdown marker
  // while its per-device runner setup is in flight.
  clearColdBootShutdownMarker(state.boot.source, state.boot.device.deviceId);

  if (state.boot.device.platform === "ios") {
    await waitForBootedIosRunnerCleanup(budgets, deps, options);
  }

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
      daemonState: deps.daemonState,
      totalDeadlineMs: budgets.automationDeadlineMs,
      readinessTimeoutMs: budgets.automationReadyTimeoutMs,
      timer: deps.timer,
      signal,
      progress,
      perf,
      requestedIdentity,
      ensureCtrlProxyReady: deps.ensureCtrlProxyReady ?? ensureCtrlProxyReady,
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
      daemonState: deps.daemonState,
      preparation,
      readinessResult,
      acquisitionReadinessKey,
    });
  });
  state.ownershipTransferred = true;
  recordStartedDevice(state.boot, options, sessionId);

  refreshResourcesAfterCommittedBoot(state.boot, deps);
  return buildBootedResponse(state.boot, perf, sessionId, {
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
  daemonState: DaemonStateLike,
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
        const resumeSessionId = restartResumeSessionForDevice(args, state.boot!.device);
        if (resumeSessionId && daemonState.isInitialized()) {
          initialReservations.push(
            await daemonState
              .getDevicePool()
              .reserveRestartRecoveryReadiness(
                state.boot!.device,
                state.boot!.sourceImage?.name ?? state.boot!.device.name,
                resumeSessionId,
              ),
          );
        } else {
          await reserveInitialDeviceForReadiness(
            daemonState,
            state.boot!,
            initialReservations,
            internalMcpSessionId(args),
            internalOneShotCli(args),
          );
        }
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
    daemonState: DaemonStateLike;
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
    const mappingOptions = { signal, totalDeadlineMs: budgets.automationDeadlineMs };
    await validatePooledDeviceMapping(state.boot.device, requestedIdentity, mappingOptions);

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
            bindUndoneIfUndelivered(
              async (receipt, bindSignal) => {
                return await bindBootedDeviceSession(
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
                    receipt,
                    signal: bindSignal,
                  },
                );
              },
              () => state.boot,
            ),
            {
              timeoutError: () =>
                acquisitionLifecycleTimeoutError(
                  budgets,
                  requestedIdentity,
                  "binding the device session",
                ),
              onOrphan: (settlement) => {
                state.bindingSettlements.push(settlement);
              },
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

export async function ensureCtrlProxyReady(request: RunnerReadinessRequest): Promise<void> {
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
    const pool = getStartDevicePool(getDeviceToolsDependencies().daemonState);
    if (
      pool &&
      (await waitForDevicePreparation(
        async () => await pool.isShutdownReserved(request.device.deviceId),
        preparationOptions,
      ))
    ) {
      throw new DeviceShuttingDownError(request.device.deviceId);
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

export async function bindBootedDeviceSession(
  device: BootedDevice,
  args: StartDeviceSessionArgs,
  sourceImage: DeviceInfo | undefined,
  childProcess: ChildProcess | null | undefined,
  {
    autolockEnabled = captureAutolockPolicy(getDeviceToolsDependencies().env),
    readinessReservationOwners,
    verifiedAndroidAvdIdentity,
    achievedReadiness = "automationReady",
    collectCancellationSettlement,
    receipt,
    signal,
  }: {
    autolockEnabled?: boolean;
    readinessReservationOwners?: ReadonlySet<symbol>;
    verifiedAndroidAvdIdentity?: DeviceInfo;
    achievedReadiness?: DeviceReadinessLevel;
    collectCancellationSettlement?: (settlement: Promise<void>) => void;
    /** Filled in with the session this bind mints, for a caller that may have to take it back. */
    receipt?: AcquisitionReceipt;
    /** The bind's cancel signal; autolock acquisition stops when it aborts (#15671). */
    signal: AbortSignal | undefined;
  },
): Promise<string> {
  if (device.platform === "android") {
    // A deliberate startDevice/provisionDevice boot owns this serial now; a tombstone left by a
    // previously retired emulator must not fence it (#11134).
    await getProvisionedDeviceTransportFence().clear(device.deviceId);
  }
  // Reserve the exact ready device before resource notifications publish it
  // to concurrent allocators.
  const { daemonState, idGenerator } = getDeviceToolsDependencies();
  if (!daemonState.isInitialized()) {
    const sessionId = idGenerator.next();
    registerDirectSessionDevice(sessionId, device);
    return sessionId;
  }
  // An admitted restart must resume R even when autolock is enabled. Ordinary autolock
  // mints a session and must never replace a holder released or expired during this boot.
  const resumeSessionId = restartResumeSessionForDevice(args, device);
  // A one-shot `--cli` call is anonymous: autolock keys its session on the per-connection MCP id,
  // which the next CLI call never shares, so it would refuse that call. Bind it as an anonymous
  // acquisition below, which later one-shot calls reuse (#11096, #11148).
  const useAutolock = autolockEnabled && !internalOneShotCli(args);
  if (useAutolock && !resumeSessionId) {
    const autolockSessionId = await daemonState
      .getDevicePool()
      .autolockDevice(
        device.deviceId,
        device.platform,
        internalMcpSessionId(args),
        sourceImage,
        childProcess,
        device,
        readinessReservationOwners,
        verifiedAndroidAvdIdentity,
        achievedReadiness,
        collectCancellationSettlement,
        { autolockEnabled, receipt, signal },
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

  const sessionId = resumeSessionId ?? getDeviceToolsDependencies().idGenerator.next();
  const bind = (recoveryTarget?: SessionRecoveryTarget) =>
    daemonState.getDevicePool().bindOrReuseDeviceSession({
      sessionId,
      deviceId: device.deviceId,
      platform: device.platform,
      sourceImage,
      childProcess,
      expectedIdentity: device,
      allowSessionRebind: false,
      readinessReservationOwners,
      verifiedAndroidAvdIdentity,
      mcpSessionId: internalMcpSessionId(args),
      oneShotCli: internalOneShotCli(args),
      receipt,
      refusePreparedForOtherRequest: false,
      recoveryTarget,
    });
  if (resumeSessionId) {
    return await resumePreparedDeviceSession(
      device,
      args,
      resumeSessionId,
      bind,
      {
        autolockEnabled: useAutolock,
        achievedReadiness,
      },
      daemonState,
    );
  }
  const boundSessionId = await bind();
  recordAcquiredSessionReadiness(daemonState, boundSessionId, achievedReadiness);
  return boundSessionId;
}

/** A join can complete without running this start's assigner, so adopt R through the reuse bind. */
async function resumePreparedDeviceSession(
  device: BootedDevice,
  args: StartDeviceSessionArgs,
  resumeSessionId: string,
  bind: (target?: SessionRecoveryTarget) => Promise<string>,
  {
    autolockEnabled,
    achievedReadiness,
  }: {
    autolockEnabled: boolean;
    achievedReadiness: DeviceReadinessLevel;
  },
  daemonState: Pick<DaemonStateLike, "getDevicePool" | "getSessionManager">,
): Promise<string> {
  const pool = daemonState.getDevicePool();
  // The resume bind and adoption share a close fence, including provisionDevice callers.
  const endResumeBind = pool.beginMcpBind(internalMcpSessionId(args));
  try {
    let boundByStart = false;
    let recoveryTarget: SessionRecoveryTarget | undefined = internalRestartResumeTargets(
      args,
    )?.find((reservation) => reservation.sessionId === resumeSessionId)?.target;
    const session = await daemonState.getSessionManager().getOrCreateSession(
      resumeSessionId,
      {
        assignDeviceToSession: async (_id, _platform, target) => {
          if (!target || !pool.matchesRestartRecoveryTarget(device, target)) {
            throw new ActionableError(
              `Cannot safely recover session ${resumeSessionId}: prepared device does not match its recovery target.`,
            );
          }
          recoveryTarget = target;
          const bound = await bind(target);
          boundByStart = true;
          return bound;
        },
      },
      device.platform,
      undefined,
      true,
      { signal: getAbortSignal() },
    );
    if (session.assignedDevice !== device.deviceId || session.platform !== device.platform) {
      throw new ActionableError(
        `Session '${resumeSessionId}' is already assigned to a different device.`,
      );
    }
    if (!boundByStart) {
      await bind(recoveryTarget);
    }
    recordAcquiredSessionReadiness(daemonState, resumeSessionId, achievedReadiness);
    if (autolockEnabled) {
      await pool.adoptResumedAutolockSession(
        resumeSessionId,
        device,
        internalMcpSessionId(args),
        achievedReadiness,
      );
    }
    return resumeSessionId;
  } finally {
    endResumeBind();
  }
}

export function restartResumeSessionForDevice(
  args: StartDeviceSessionArgs,
  device: BootedDevice,
): string | undefined {
  const pool = initializedDevicePool();
  if (!pool) {
    return undefined;
  }
  const resumeSessionUuid = internalRestartResumeSessionUuid(args);
  const admitted = internalRestartResumeTargets(args)?.find(
    ({ sessionId, target }) =>
      (!resumeSessionUuid || sessionId === resumeSessionUuid) &&
      pool.matchesRestartRecoveryTarget(device, target),
  );
  if (admitted) {
    return admitted.sessionId;
  }
  if (resumeSessionUuid) {
    throw new ActionableError(
      `Cannot safely recover session ${resumeSessionUuid}: prepared device does not match its recovery target.`,
    );
  }
  const reservation = pool.restartReservationForStart?.(
    device.platform,
    [device.deviceId],
    startRequester(args),
  );
  return reservation?.owned &&
    reservation.restartHandoff &&
    pool.matchesRestartRecoveryTarget(device, reservation.target)
    ? reservation.sessionUuid
    : undefined;
}

/**
 * Human label for how the device came up. `cold-boot` only means this call launched the
 * emulator process: a snapshot-loaded (quickboot) launch takes the same path, so the text
 * must not claim a cold boot. The structured `acquisition` field keeps its enum value.
 */
export function bootSourceLabel(source: "booted" | "cold-boot"): string {
  return source === "cold-boot" ? "started by this call" : "already booted";
}

function buildBootedResponse(
  { device, source, provisioned, prebootDisabledResources }: DeviceBootResult,
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
    message: `${device.platform} '${device.name}' is ready (${bootSourceLabel(source)})`,
    ...projected,
    ...disabledDeviceResourceReport(
      Object.fromEntries(
        (provisioned && device.platform === "ios" ? (prebootDisabledResources ?? []) : []).map(
          (key) => [key, { state: "disabled" }],
        ),
      ),
    ),
    deviceIdentity: deviceIdentityPayload(device, sourceImage),
    processId: processId ?? null,
    isReady: true,
    acquisition,
    readiness,
    // The per-command timing tree (~170 adb polls on a cold boot) is a daemon
    // diagnostic, not something a client acts on (#11636); it stays behind the
    // existing --debug-perf opt-in. `readiness.elapsedMs` carries the total.
    ...(isDebugPerfEnabled()
      ? {
          timing: timing ?? {},
        }
      : {}),
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

/** Boot + prepare, rolling a createIfMissing image back via the injected rollback (#11100, #11827). */
export function createBootAndPrepareDevice(rollbackCreatedDevice: CreatedDeviceRollback) {
  return async (
    args: StartDeviceArgs,
    budgets: DevicePreparationBudgets,
    deps: DeviceToolsDependencies,
    deviceUtils: PlatformDeviceManager,
    options: BootPreparationOptions,
  ) => {
    const bootOptions = { ...options, rollbackCreatedDevice };
    // Keep a close during boot visible through a resumed session's bind and autolock adoption.
    const pool = options.autolockEnabled ? initializedDevicePool() : undefined;
    const endAutolockBind = pool?.beginMcpBind(internalMcpSessionId(args));
    try {
      return await bootAndPrepareDevice(args, budgets, deps, deviceUtils, bootOptions);
    } catch (error) {
      await rollbackCreatedDeviceAfterBoot(bootOptions, error);
      throw error;
    } finally {
      endAutolockBind?.();
    }
  };
}

export function createStartDeviceHandlers(hooks: StartDeviceHooks) {
  const { prepareDevice, stripInternalAcquisitionParams } = hooks;
  const startDeviceHandler = async (
    rawArgs: StartDeviceArgs | StartDeviceRequest,
    progress?: ProgressCallback,
    signal?: AbortSignal,
  ) => {
    if (isWatchStartRequest(rawArgs)) {
      return await startWatchDevice(rawArgs, bindBootedDeviceSession, signal);
    }
    const internalSessionId = internalMcpSessionId(rawArgs);
    const args = {
      ...startDeviceSchema.parse(stripInternalAcquisitionParams(rawArgs)),
      __mcpSessionId: internalSessionId,
      __requesterSessionUuid: lifecycleRequester(rawArgs).sessionUuid,
      ...(internalOneShotCli(rawArgs) ? { __oneShotCli: true } : {}),
    };
    validateCameraPosterPlatform(args);
    const exactAndroidAvdName = args.platform === "android" ? args.avdName : undefined;
    const totalTimeoutMs = args.timeoutMs ?? DEFAULT_START_DEVICE_TIMEOUT_MS;
    return await runWithAcquisitionDeadline(
      rawArgs,
      getDeviceToolsDependencies().timer.now() + totalTimeoutMs,
      signal,
      "startDevice",
      async (deadlineMs, requestSignal, stage) => {
        // Poster rendering runs under the acquisition deadline and cancellation.
        const resolvedArgs = await raceWithDeadline(resolveCameraPosterQr(args), {
          timer: getDeviceToolsDependencies().timer,
          signal: requestSignal,
          label: "startDevice camera poster",
        });
        const target = {
          ...resolvedArgs,
          ...(exactAndroidAvdName ? { name: exactAndroidAvdName, matchExactName: true } : {}),
        };
        return prepareDevice(
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
        );
      },
    );
  };

  return {
    startDeviceHandler,
    bindBootedDeviceSession,
    ensureCtrlProxyReady,
  };
}
