import type { DaemonCoreServices, DaemonLifecycleState } from "./DaemonCoreState";
import { logger } from "../../utils/logger";
import type { Platform } from "../../models";
import { MultiPlatformDeviceManager } from "../../devices/deviceUtils";
import { type Session } from "../sessionManager";
import { SingleFlightInterval } from "../SingleFlightInterval";
import { PlanDeviceLossMonitor, type PlanDeviceLossPort } from "../deviceDisconnectHandler";
import { DevicePool, type PooledDevice } from "../devicePool";
import { deviceLossCancellationReason } from "../emulatorLossIncident";
import { PlanDeviceActivity } from "../planDeviceActivity";
import { resolveToolSelectionBaseSessionUuid } from "../../features/toolSelection/selectionSessionResolver";
import { getPerformanceMonitor } from "../../features/performance/PerformanceMonitor";
import {
  evaluateDeviceDisconnects,
  pruneStaleOfflineRecoveryAttempts,
  recordingCandidateIncarnations,
  selectImmediateDisconnectCandidates,
  selectOfflineRecoveryCandidates,
  type OfflineEpisode,
  type DisconnectCandidateIncarnation,
} from "../disconnectMonitor";
import {
  defaultAdbTransportRestartRegistry,
  type AdbTransportRestartLookup,
} from "../../utils/android-cmdline-tools/AdbTransportRestartRegistry";
import {
  collectDisconnectCandidates,
  collectDisconnectedRecordings,
  discoverAndReconcile,
  MONITOR_IOS_LIST_MAX_AGE_MS,
  getAndroidOfflineCanonicalIds,
  logDisconnectMisses,
  probeListedAndroidStates,
  stopRecordingAfterDeviceDisconnect,
  transitionalCandidateIds,
} from "../deviceLossDiscovery";
import {
  DisconnectMonitorSchedule,
  isHeldDisconnectDevice,
  eligibleIdleSweepSignature,
  type DisconnectMonitorCadence,
} from "../disconnectMonitorCadence";
import { serverConfig } from "../../utils/ServerConfig";
import { onAdbMissingDevice } from "../../utils/android-cmdline-tools/AdbDeviceHealth";
import type { DaemonSessions } from "./DaemonSessions";
import type { DaemonRecordingHost } from "../daemonStartHost";
import {
  getProcessWideAdbServerResetCohort,
  type CapturedDisconnectCleanup,
  type CapturedDisconnectRecovery,
  type CapturedDisconnectTarget,
} from "./disconnectTargets";
export type { CapturedDisconnectCleanup } from "./disconnectTargets";
import { isProcessWideAdbServerReset } from "./disconnectTargets";

type LogDisconnectMissesArgs =
  Parameters<typeof logDisconnectMisses> extends [unknown, ...infer Rest] ? Rest : never;

interface CapturedDisconnectRecoveryOptions {
  deviceId: string;
  incidentId: string | undefined;
  pooledDevice: PooledDevice | null | undefined;
  sessionId: string | null | undefined;
  session: Session | null;
  forceGeneration: number | undefined;
  preparation?: ReturnType<DevicePool["prepareSessionPreservingRecovery"]>;
}

const DEVICE_DISCONNECT_POLL_INTERVAL_MS = 5000;
const DEVICE_DISCONNECT_IDLE_INTERVAL_MS = 30_000;

export type { DisconnectMonitorCadence } from "../disconnectMonitorCadence";

interface DisconnectSweep {
  adbServerResetCohort: readonly PooledDevice[];
  selectPlatform: (platforms: Platform[], planOnTracked: boolean) => "android" | "ios" | "either";
  idleSignature?: string;
}

/** The pool reads used to decide whether disconnect discovery must stay on its active cadence. */
export interface DisconnectMonitorPool {
  getAllDevices(): readonly Pick<PooledDevice, "id">[];
  getDevice(id: string): Pick<PooledDevice, "status" | "sessionId" | "health"> | null;
  isDeviceLeasedForAndroidStartup: DevicePool["isDeviceLeasedForAndroidStartup"];
}
export interface DaemonDisconnectHost extends Pick<
  DaemonRecordingHost,
  "listActiveVideoRecordings"
> {
  captureDisconnectCleanup: (
    deviceId: string,
    cohort: Map<string, PooledDevice>,
  ) => CapturedDisconnectCleanup;
  stoppingRecordings: () => Set<string>;

  services: Pick<DaemonCoreServices, "sessionManager" | "devicePool" | "timer">;
  lifecycle: Pick<
    DaemonLifecycleState,
    | "socketServer"
    | "deviceDisconnectMonitor"
    | "setDeviceDisconnectMonitor"
    | "deferredSessionRecoverySweeps"
    | "deviceDisconnectMisses"
    | "unsubscribeAdbMissingDevice"
    | "setUnsubscribeAdbMissingDevice"
  >;
  forceDisconnectedDeviceIds: () => Set<string>;
  confirmedDisconnectedDeviceIds: () => Set<string>;
  deviceDisconnectMissIncarnations: () => Map<string, DisconnectCandidateIncarnation>;
  offlineEpisodes: () => Map<string, OfflineEpisode>;
  offlineRecoveryAttemptedDeviceIds: () => Set<string>;
  setOfflineRecoveryAttemptedDeviceIds: (value: Set<string>) => void;
  offlineRecoveryAttemptedIncarnations: () => Map<string, number | string>;
  setOfflineRecoveryAttemptedIncarnations: (value: Map<string, number | string>) => void;
  forceDisconnectedDeviceGenerations: () => Map<string, number>;
  shouldSkipStaleDisconnectCleanup: DaemonDisconnect["shouldSkipStaleDisconnectCleanup"];
  isCapturedDisconnectTargetCurrent: DaemonDisconnect["isCapturedDisconnectTargetCurrent"];
  trackDeferredSessionRecoverySweep: DaemonDisconnect["trackDeferredSessionRecoverySweep"];
  stopRecordingAfterDeviceDisconnect: DaemonDisconnect["stopRecordingAfterDeviceDisconnect"];
  recordAndTryRecoverCapturedDisconnect: DaemonDisconnect["recordAndTryRecoverCapturedDisconnect"];
  cancelAndReleaseSession: DaemonSessions["cancelAndReleaseSession"];
  cleanupDisconnectedDevice: DaemonDisconnect["cleanupDisconnectedDevice"];
  retireAdbServerResetDisconnectState: DaemonDisconnect["retireAdbServerResetDisconnectState"];
}

/** Tracks device-loss evidence and coordinates fenced recovery and recording cleanup. */
export class DaemonDisconnect {
  constructor(private readonly host: DaemonDisconnectHost) {}

  private hasPlanExecution(deviceId: string, sessionUuid?: string): boolean {
    return new PlanDeviceActivity(this.host.services.sessionManager()).hasPlanExecution(
      deviceId,
      sessionUuid,
    );
  }

  private async tryRecoverCapturedDisconnectTarget(
    options: CapturedDisconnectRecoveryOptions,
  ): Promise<boolean> {
    const { deviceId, incidentId, pooledDevice, sessionId, session, forceGeneration, preparation } =
      options;
    if (!preparation) {
      if (
        sessionId &&
        (await this.host.services
          .devicePool()
          .waitForSessionPreservingRecovery(sessionId, incidentId))
      ) {
        this.host.retireAdbServerResetDisconnectState(deviceId, forceGeneration);
        return true;
      }
      if (sessionId && this.host.services.devicePool().isSessionRecoveryInFlight(sessionId)) {
        await this.host.services
          .devicePool()
          .finishEmulatorLossIncident(incidentId, "not-attempted");
        this.host.retireAdbServerResetDisconnectState(deviceId, forceGeneration);
        return true;
      }
    }
    if (!pooledDevice || !sessionId || !session) {
      return false;
    }
    this.host.services.devicePool().finishSessionPreservingRecoveryPreparation(preparation);
    const recovery = await this.host.services
      .devicePool()
      .recoverSessionBoundDeviceAfterLoss(deviceId, incidentId, pooledDevice);
    if (recovery === "not-attempted") {
      return false;
    }
    this.host.retireAdbServerResetDisconnectState(deviceId, forceGeneration);
    return true;
  }

  async recordAndTryRecoverCapturedDisconnect(
    deviceId: string,
    captured: CapturedDisconnectRecovery,
  ): Promise<{ incidentId: string | undefined; handled: boolean }> {
    const {
      pooledDeviceAtDisconnect: pooledDevice,
      assignmentCountAtDisconnect,
      sessionIdAtDisconnect: sessionId,
      sessionAtDisconnect: session,
      forceGenerationAtDisconnect: forceGeneration,
    } = captured;
    if (await this.host.services.devicePool().isShutdownReservationHeld(deviceId)) {
      // killDevice owns intentional disappearance. Leave misses at the threshold
      // so the next poll rechecks the fence if shutdown fails and releases it.
      // Pool cleanup defers reserved/assigned devices and consumes idle markers.
      await this.host.services
        .devicePool()
        .removeDisconnectedDevice(deviceId, true, undefined, pooledDevice ?? undefined);
      return { incidentId: undefined, handled: true };
    }
    const preparation = this.host.services
      .devicePool()
      .prepareSessionPreservingRecovery(deviceId, pooledDevice ?? undefined);
    try {
      const incidentId = await this.host.services
        .devicePool()
        .recordEmulatorLossIncident(
          deviceId,
          this.host.forceDisconnectedDeviceIds().has(deviceId)
            ? "adb-transport-failure"
            : "device-discovery-miss",
          undefined,
          "absent",
        );
      const staleDisconnect =
        (await this.host.shouldSkipStaleDisconnectCleanup(
          pooledDevice,
          deviceId,
          forceGeneration,
        )) ||
        !this.host.isCapturedDisconnectTargetCurrent(deviceId, {
          pooledDeviceAtDisconnect: pooledDevice,
          assignmentCountAtDisconnect,
          sessionIdAtDisconnect: sessionId,
          sessionAtDisconnect: session,
        });
      if (staleDisconnect) {
        await this.host.services
          .devicePool()
          .finishEmulatorLossIncident(incidentId, "not-attempted");
        return { incidentId, handled: true };
      }
      const handled = await this.tryRecoverCapturedDisconnectTarget({
        deviceId,
        incidentId,
        pooledDevice,
        sessionId,
        session,
        forceGeneration,
        preparation,
      });
      return { incidentId, handled };
    } finally {
      this.host.services.devicePool().finishSessionPreservingRecoveryPreparation(preparation);
    }
  }

  startDeviceDisconnectMonitor(
    deviceManager: Pick<
      MultiPlatformDeviceManager,
      | "getBootedDevicesDetailed"
      | "getAndroidOfflineDeviceIds"
      | "getAndroidListedDeviceStates"
      | "recoverAndroidOfflineDevices"
    > = new MultiPlatformDeviceManager(),
    listRecordings: DaemonDisconnectHost["listActiveVideoRecordings"] = this.host
      .listActiveVideoRecordings,
    transportRestarts: AdbTransportRestartLookup = defaultAdbTransportRestartRegistry,
    cadence: DisconnectMonitorCadence = {
      activeIntervalMs: DEVICE_DISCONNECT_POLL_INTERVAL_MS,
      idleIntervalMs: DEVICE_DISCONNECT_IDLE_INTERVAL_MS,
    },
  ): void {
    if (this.host.lifecycle.deviceDisconnectMonitor()) {
      return;
    }

    const checkPlanDeviceLoss = this.createPlanDeviceLossCheck(
      deviceManager,
      (platform) =>
        this.discoverAndReconcile(deviceManager, {
          platform,
          bypassAndroidDeviceListCache: true,
        }),
      transportRestarts,
    );

    const schedule = new DisconnectMonitorSchedule(cadence, this.host.services.timer().now());
    this.host.lifecycle.setDeviceDisconnectMonitor(
      new SingleFlightInterval(
        this.host.services.timer(),
        cadence.activeIntervalMs,
        async () => {
          const sweep: DisconnectSweep = {
            adbServerResetCohort: [],
            selectPlatform: (platforms, planOnTracked) =>
              schedule.selectPlatform(platforms, this.host.services.timer().now(), planOnTracked),
          };
          try {
            await this.checkDisconnects(deviceManager, listRecordings, transportRestarts, {
              checkPlanDeviceLoss,
              sweep,
            });
            schedule.recordSuccess(sweep.idleSignature);
          } catch (error) {
            schedule.recordFailure();
            logger.warn(`[Daemon] Device disconnect monitor failed: ${error}`);
          } finally {
            if (sweep.adbServerResetCohort.length > 0) {
              await this.host.services
                .devicePool()
                .releaseAdbServerResetCohortReservations(sweep.adbServerResetCohort);
            }
          }
        },
        {
          shouldRun: async () => {
            const pool: DisconnectMonitorPool = this.host.services.devicePool();
            const watching =
              this.host.services.sessionManager().getAllSessions().length > 0 ||
              pool.getAllDevices().some(({ id }) => {
                const device = pool.getDevice(id);
                return isHeldDisconnectDevice(device, pool.isDeviceLeasedForAndroidStartup(id));
              }) ||
              serverConfig.isPlanExecutionActive() ||
              (await listRecordings()).length > 0;
            return schedule.shouldRun(watching, this.host.services.timer().now());
          },
        },
      ),
    );
    this.host.lifecycle.deviceDisconnectMonitor()!.start();
  }

  private discoverAndReconcile(
    deviceManager: Parameters<typeof discoverAndReconcile>[1],
    options: Parameters<typeof discoverAndReconcile>[2],
  ) {
    return discoverAndReconcile(this.host.services.devicePool(), deviceManager, {
      ...options,
      isPlanDevice: (id) => this.hasPlanExecution(id),
      heldDevices: [
        ...this.host.services.sessionManager().getAllSessions(),
        ...(options.heldDevices ?? []),
      ],
    });
  }

  private logDisconnectMisses(...args: LogDisconnectMissesArgs): void {
    logDisconnectMisses(this.host.lifecycle.deviceDisconnectMisses(), ...args);
  }

  private collectDisconnectCandidates(
    activeRecordings: Parameters<typeof collectDisconnectCandidates>[2],
  ) {
    return collectDisconnectCandidates(
      this.host.services.devicePool(),
      this.host.services.sessionManager(),
      activeRecordings,
    );
  }

  createPlanDeviceLossCheck(
    deviceManager: Pick<MultiPlatformDeviceManager, "getAndroidOfflineDeviceIds">,
    discover: PlanDeviceLossPort["discover"],
    transportRestarts: AdbTransportRestartLookup = defaultAdbTransportRestartRegistry,
  ): (
    result: ReturnType<typeof evaluateDeviceDisconnects>,
    bootedDeviceIds: ReadonlySet<string>,
  ) => Promise<void> {
    const monitor = new PlanDeviceLossMonitor({
      timer: this.host.services.timer(),
      isTransportRestarting: (id) => transportRestarts.isRestarting(id),
      getDevice: (id) => this.host.services.devicePool().getDevice(id),
      getPlanSessionUuid: (id) =>
        resolveToolSelectionBaseSessionUuid(id, this.host.services.sessionManager()) ?? id,
      hasPlanExecution: (id, sessionUuid) => this.hasPlanExecution(id, sessionUuid),
      getPlanExecutionIds: (id, sessionUuid) =>
        new PlanDeviceActivity(this.host.services.sessionManager()).getPlanExecutionIds(
          id,
          sessionUuid,
        ),
      isStartupLeased: (id) => this.host.services.devicePool().isDeviceLeasedForAndroidStartup(id),
      isShutdownReserved: (id) => this.host.services.devicePool().isShutdownReservationHeld(id),
      discover,
      getOfflineDeviceIds: (ids) =>
        getAndroidOfflineCanonicalIds(this.host.services.devicePool(), deviceManager, ids),
      isAdbReset: (ids, discovery) =>
        isProcessWideAdbServerReset(
          ids,
          discovery.succeededPlatforms,
          // The plan path has independently observed absence, so a raw ADB error
          // is not required to protect a wholly vanished owned emulator cohort.
          new Set(
            this.host.services
              .devicePool()
              .getAllDevices()
              .filter((device) => !ids.has(device.id))
              .map((device) => device.id),
          ),
          this.host.services.devicePool().getAllDevices(),
        ),
      recordLoss: (id) =>
        this.host.services
          .devicePool()
          .recordEmulatorLossIncident(
            id,
            this.host.forceDisconnectedDeviceIds().has(id)
              ? "adb-transport-failure"
              : "device-discovery-miss",
            undefined,
            "absent",
          ),
      finishLoss: (incidentId) =>
        this.host.services.devicePool().finishEmulatorLossIncident(incidentId, "not-attempted"),
      cancelPlan: (id, sessionUuid, reason) =>
        new PlanDeviceActivity(this.host.services.sessionManager()).cancelPlanExecutions(
          id,
          sessionUuid,
          reason,
        ),
    });
    return async (result, bootedDeviceIds) => {
      await monitor.check(
        result.missed.map(({ deviceId }) => deviceId),
        bootedDeviceIds,
      );
      logger.debug("[DisconnectMonitor] Checked device-scoped plan loss evidence");
    };
  }

  private startDeferredSessionRecoverySweep(): void {
    this.host.trackDeferredSessionRecoverySweep(
      this.host.services
        .devicePool()
        .retryDueDeferredSessionRecoveries((id) => !this.hasPlanExecution(id))
        .catch((error) => {
          logger.warn(
            `[DisconnectMonitor] Deferred session recovery sweep failed: ${error}`,
            error,
          );
        }),
    );
  }

  private prepareOfflineRecovery(
    candidateDeviceIds: Set<string>,
    offlineDeviceIds: Set<string> | undefined,
    candidateIncarnations: ReturnType<typeof recordingCandidateIncarnations>,
  ) {
    this.host.setOfflineRecoveryAttemptedDeviceIds(
      pruneStaleOfflineRecoveryAttempts(
        this.host.offlineRecoveryAttemptedDeviceIds(),
        candidateDeviceIds,
        offlineDeviceIds,
        this.host.offlineRecoveryAttemptedIncarnations(),
        candidateIncarnations,
      ),
    );
    // A serial that is mid-provisionDevice/startDevice already has its
    // own bounded offline recovery: AndroidEmulatorClient's
    // fresh-provision readiness wait (maybeRecoverFreshOffline, #7054/
    // #7078) owns that serial's `adb -s <serial> reconnect` on its own 15s
    // threshold. Deferring to it here mirrors how the ADB-reset cohort
    // path (below) defers on the same in-flight-startup lease, so the
    // monitor never races a second reconnect against the readiness
    // wait's own dispatch.
    const inFlightStartupOfflineDeviceIds = new Set(
      [...(offlineDeviceIds ?? [])].filter(
        (deviceId) =>
          !this.hasPlanExecution(deviceId) &&
          this.host.services.devicePool().isDeviceLeasedForAndroidStartup(deviceId),
      ),
    );
    const offlineRecoveryTargets = selectOfflineRecoveryCandidates(
      offlineDeviceIds ?? new Set(),
      candidateDeviceIds,
      this.host.offlineRecoveryAttemptedDeviceIds(),
      new Set([
        ...inFlightStartupOfflineDeviceIds,
        ...[...(offlineDeviceIds ?? [])].filter((id) => this.hasPlanExecution(id)),
      ]),
    );
    const dispatchTargets = inFlightStartupOfflineDeviceIds.size > 0 ? [] : offlineRecoveryTargets;
    this.host.setOfflineRecoveryAttemptedDeviceIds(
      new Set([...this.host.offlineRecoveryAttemptedDeviceIds(), ...dispatchTargets]),
    );
    this.host.setOfflineRecoveryAttemptedIncarnations(
      new Map(
        [...candidateIncarnations].filter(([deviceId]) =>
          this.host.offlineRecoveryAttemptedDeviceIds().has(deviceId),
        ),
      ),
    );
    return { dispatchTargets, offlineRecoveryTargets };
  }

  private async recoverOfflineCandidates(
    deviceManager: Pick<MultiPlatformDeviceManager, "recoverAndroidOfflineDevices">,
    listed: Awaited<ReturnType<typeof probeListedAndroidStates>>,
    candidateDeviceIds: Set<string>,
    candidateIncarnations: ReturnType<typeof recordingCandidateIncarnations>,
  ): Promise<boolean> {
    if ([...candidateDeviceIds].every((id) => this.hasPlanExecution(id))) {
      return false;
    }
    // Unprobed plan devices retain their episode; they cannot dispatch reconnect.
    const offlineDeviceIds =
      listed.offlineDeviceIds &&
      new Set([
        ...listed.offlineDeviceIds,
        ...[...this.host.offlineRecoveryAttemptedDeviceIds()].filter((id) =>
          this.hasPlanExecution(id),
        ),
      ]);
    const { dispatchTargets } = this.prepareOfflineRecovery(
      candidateDeviceIds,
      offlineDeviceIds,
      candidateIncarnations,
    );
    if (dispatchTargets.length === 0) {
      return false;
    }
    logger.warn(
      `[DisconnectMonitor] In-session device(s) ADB-offline (${dispatchTargets.join(", ")}); attempting bounded 'adb -s <serial> reconnect' recovery before miss-counting`,
    );
    const transports = dispatchTargets.flatMap((id) => {
      const aliases = listed.offlineTransportIds?.get(id);
      return aliases?.size ? [...aliases] : [id];
    });
    // Recovery logs its own failures and is bounded per serial.
    await deviceManager.recoverAndroidOfflineDevices(transports);
    return true;
  }

  captureDisconnectCleanup(
    deviceId: string,
    adbServerResetCohortByDeviceId: Map<string, PooledDevice>,
  ): CapturedDisconnectCleanup {
    return this.host.captureDisconnectCleanup(deviceId, adbServerResetCohortByDeviceId);
  }

  private confirmDisconnectedDeviceCleanup(
    deviceId: string,
    forceGenerationAtDisconnect: number | undefined,
  ): void {
    this.host.confirmedDisconnectedDeviceIds().add(deviceId);
    this.host.lifecycle.deviceDisconnectMisses().reset(deviceId);
    this.host.deviceDisconnectMissIncarnations().delete(deviceId);
    this.host.offlineRecoveryAttemptedDeviceIds().delete(deviceId);
    this.host.offlineRecoveryAttemptedIncarnations().delete(deviceId);
    this.host.offlineEpisodes().delete(deviceId);
    if (
      this.host.forceDisconnectedDeviceGenerations().get(deviceId) === forceGenerationAtDisconnect
    ) {
      this.host.forceDisconnectedDeviceIds().delete(deviceId);
      this.host.forceDisconnectedDeviceGenerations().delete(deviceId);
    }
  }

  async cleanupDisconnectedDevice(
    deviceId: string,
    recordingIds: string[],
    adbServerResetCohortByDeviceId: Map<string, PooledDevice>,
  ): Promise<void> {
    const captured = this.captureDisconnectCleanup(deviceId, adbServerResetCohortByDeviceId);
    const { pooledDeviceAtDisconnect, forceGenerationAtDisconnect, adbServerResetTarget } =
      captured;
    if (
      !adbServerResetTarget &&
      (await this.host.shouldSkipStaleDisconnectCleanup(
        pooledDeviceAtDisconnect,
        deviceId,
        forceGenerationAtDisconnect,
      ))
    ) {
      return;
    }
    let deviceCleanupSucceeded = true;

    // Stop performance monitoring for this device
    getPerformanceMonitor().stopMonitoring(deviceId);

    for (const recordingId of recordingIds) {
      if (!(await this.host.stopRecordingAfterDeviceDisconnect(recordingId, deviceId))) {
        deviceCleanupSucceeded = false;
      }
    }

    if (
      !adbServerResetTarget &&
      (await this.host.shouldSkipStaleDisconnectCleanup(
        pooledDeviceAtDisconnect,
        deviceId,
        forceGenerationAtDisconnect,
      ))
    ) {
      return;
    }

    if (adbServerResetTarget) {
      if (
        await this.tryRecoverProcessWideAdbServerResetDevice(
          deviceId,
          adbServerResetTarget,
          forceGenerationAtDisconnect,
        )
      ) {
        return;
      }
    }

    return this.finishDisconnectedDeviceCleanup(deviceId, captured, deviceCleanupSucceeded);
  }

  private async finishDisconnectedDeviceCleanup(
    deviceId: string,
    captured: ReturnType<DaemonDisconnect["captureDisconnectCleanup"]>,
    deviceCleanupSucceeded: boolean,
  ): Promise<void> {
    const {
      pooledDeviceAtDisconnect,
      assignmentCountAtDisconnect,
      sessionIdAtDisconnect,
      sessionAtDisconnect,
      forceGenerationAtDisconnect,
    } = captured;
    // Cancel active executions and release the session so the test fails
    // fast instead of waiting for the full MCP request timeout.
    const { incidentId, handled } = await this.host.recordAndTryRecoverCapturedDisconnect(
      deviceId,
      {
        pooledDeviceAtDisconnect,
        assignmentCountAtDisconnect: assignmentCountAtDisconnect ?? 0,
        sessionIdAtDisconnect,
        sessionAtDisconnect,
        forceGenerationAtDisconnect,
      },
    );
    if (handled) {
      return;
    }
    if (
      !this.host.isCapturedDisconnectTargetCurrent(deviceId, {
        pooledDeviceAtDisconnect,
        assignmentCountAtDisconnect,
        sessionIdAtDisconnect,
        sessionAtDisconnect,
      })
    ) {
      await this.host.services.devicePool().finishEmulatorLossIncident(incidentId, "not-attempted");
      return;
    }
    if (sessionIdAtDisconnect && sessionAtDisconnect) {
      logger.warn(
        `[DisconnectMonitor] Device ${deviceId} confirmed disconnected — cancelling session ${sessionIdAtDisconnect}`,
      );
      await this.host.cancelAndReleaseSession(
        sessionIdAtDisconnect,
        deviceLossCancellationReason(deviceId, incidentId),
        { expectedSession: sessionAtDisconnect },
      );
    }

    if (
      !this.host.isCapturedDisconnectTargetCurrent(deviceId, {
        pooledDeviceAtDisconnect,
        assignmentCountAtDisconnect,
      })
    ) {
      await this.host.services.devicePool().finishEmulatorLossIncident(incidentId, "not-attempted");
      return;
    }
    await this.host.services
      .devicePool()
      .removeDisconnectedDevice(deviceId, true, incidentId, pooledDeviceAtDisconnect ?? undefined);
    // Drop any per-device input caches so a device replaced under the same
    // serial does not inherit the previous one's cached API-level capability
    // (issue #3351): an API 31+/pre-31 mismatch mis-handles SHIFT/uppercase.
    // This fires only on a CONFIRMED disappearance; a fast same-serial restart
    // that never confirms is handled by the device-ready callback; the 5-min
    // idle close remains a fallback.
    if (this.host.services.devicePool().getDevice(deviceId)) {
      // removeDisconnectedDevice can synchronously recover a same-serial
      // Android emulator (reboot → re-add), which mints a fresh epoch. The
      // device is live again, so retiring here would delete that just-minted
      // epoch; skip the retire and let cleanup fail so the monitor retries.
      deviceCleanupSucceeded = false;
    } else {
      this.host.lifecycle.socketServer()?.evictDeviceInputCache(deviceId);
    }
    if (deviceCleanupSucceeded) {
      this.confirmDisconnectedDeviceCleanup(deviceId, forceGenerationAtDisconnect);
    }
  }

  /** Track a deferred session-recovery sweep that shutdown must wait for. Public so tests can register a sweep without a recovery run. */
  trackDeferredSessionRecoverySweep(sweep: Promise<void>): void {
    this.host.lifecycle.deferredSessionRecoverySweeps().add(sweep);
    void sweep.then(
      () => this.host.lifecycle.deferredSessionRecoverySweeps().delete(sweep),
      () => this.host.lifecycle.deferredSessionRecoverySweeps().delete(sweep),
    );
  }

  private async tryRecoverProcessWideAdbServerResetDevice(
    deviceId: string,
    pooledDevice: PooledDevice,
    forceGenerationAtDisconnect: number | undefined,
  ): Promise<boolean> {
    try {
      return await this.recoverProcessWideAdbServerResetDevice(
        deviceId,
        pooledDevice,
        forceGenerationAtDisconnect,
      );
    } catch (error) {
      logger.warn(
        `[DisconnectMonitor] ADB-reset recovery failed for ${deviceId}; continuing cohort cleanup: ${error}`,
      );
      return false;
    }
  }

  private async recoverProcessWideAdbServerResetDevice(
    deviceId: string,
    pooledDevice: PooledDevice,
    forceGenerationAtDisconnect: number | undefined,
  ): Promise<boolean> {
    const recovered = await this.host.services
      .devicePool()
      .recoverSessionBoundAndroidDeviceAfterAdbServerReset(deviceId, pooledDevice);
    if (!recovered) {
      this.host.retireAdbServerResetDisconnectState(deviceId, forceGenerationAtDisconnect);
      return false;
    }

    this.host.retireAdbServerResetDisconnectState(deviceId, forceGenerationAtDisconnect);
    return true;
  }

  retireAdbServerResetDisconnectState(
    deviceId: string,
    forceGenerationAtDisconnect: number | undefined,
  ): void {
    this.host.lifecycle.socketServer()?.evictDeviceInputCache(deviceId);
    this.host.lifecycle.deviceDisconnectMisses().reset(deviceId);
    this.host.deviceDisconnectMissIncarnations().delete(deviceId);
    this.host.confirmedDisconnectedDeviceIds().delete(deviceId);
    if (
      this.host.forceDisconnectedDeviceGenerations().get(deviceId) === forceGenerationAtDisconnect
    ) {
      this.host.forceDisconnectedDeviceIds().delete(deviceId);
      this.host.forceDisconnectedDeviceGenerations().delete(deviceId);
    }
  }

  stopRecordingAfterDeviceDisconnect(recordingId: string, deviceId: string): Promise<boolean> {
    return stopRecordingAfterDeviceDisconnect(
      { timer: this.host.services.timer(), stoppingRecordings: this.host.stoppingRecordings() },
      recordingId,
      deviceId,
    );
  }

  async shouldSkipStaleDisconnectCleanup(
    pooledDeviceAtDisconnect: PooledDevice | null,
    deviceId: string,
    forceGenerationAtDisconnect: number | undefined = this.host
      .forceDisconnectedDeviceGenerations()
      .get(deviceId),
  ): Promise<boolean> {
    if (!pooledDeviceAtDisconnect) {
      if (!this.host.services.devicePool().getDevice(deviceId)) {
        return false;
      }
      this.host.lifecycle.deviceDisconnectMisses().reset(deviceId);
      this.host.deviceDisconnectMissIncarnations().delete(deviceId);
      this.host.confirmedDisconnectedDeviceIds().delete(deviceId);
      if (
        this.host.forceDisconnectedDeviceGenerations().get(deviceId) === forceGenerationAtDisconnect
      ) {
        this.host.forceDisconnectedDeviceIds().delete(deviceId);
        this.host.forceDisconnectedDeviceGenerations().delete(deviceId);
      }
      logger.info(
        `[DisconnectMonitor] Skipping stale disconnect cleanup for recovered device ${deviceId}`,
      );
      return true;
    }
    const disconnectStatus = await this.host.services
      .devicePool()
      .isCurrentDisconnectedDevice(pooledDeviceAtDisconnect);
    if (disconnectStatus === "current") {
      return false;
    }
    if (disconnectStatus === "unknown") {
      logger.warn(
        `[DisconnectMonitor] Retaining disconnect state for ${deviceId}: recovery verification was inconclusive`,
      );
      return true;
    }
    this.host.lifecycle.deviceDisconnectMisses().reset(deviceId);
    this.host.deviceDisconnectMissIncarnations().delete(deviceId);
    this.host.confirmedDisconnectedDeviceIds().delete(deviceId);
    if (
      this.host.forceDisconnectedDeviceGenerations().get(deviceId) === forceGenerationAtDisconnect
    ) {
      this.host.forceDisconnectedDeviceIds().delete(deviceId);
      this.host.forceDisconnectedDeviceGenerations().delete(deviceId);
    }
    logger.info(
      `[DisconnectMonitor] Skipping stale disconnect cleanup for recovered device ${deviceId}`,
    );
    return true;
  }

  isCapturedDisconnectTargetCurrent(deviceId: string, target: CapturedDisconnectTarget): boolean {
    return this.host.isCapturedDisconnectTargetCurrent(deviceId, target);
  }

  startAdbMissingDeviceListener(): void {
    if (this.host.lifecycle.unsubscribeAdbMissingDevice()) {
      return;
    }

    this.host.lifecycle.setUnsubscribeAdbMissingDevice(
      onAdbMissingDevice((event) => {
        if (
          !this.host.services.devicePool().getDevice(event.deviceId) &&
          !this.host.services.sessionManager().getSessionForDevice(event.deviceId)
        ) {
          return;
        }
        logger.warn(
          `[Daemon] ADB reported tracked device ${event.deviceId} missing: ${event.message}`,
        );
        this.host.forceDisconnectedDeviceIds().add(event.deviceId);
        this.host
          .forceDisconnectedDeviceGenerations()
          .set(
            event.deviceId,
            (this.host.forceDisconnectedDeviceGenerations().get(event.deviceId) ?? 0) + 1,
          );
      }),
    );
  }

  private async checkDisconnects(
    deviceManager: Pick<
      MultiPlatformDeviceManager,
      | "getBootedDevicesDetailed"
      | "getAndroidOfflineDeviceIds"
      | "getAndroidListedDeviceStates"
      | "recoverAndroidOfflineDevices"
    >,
    listRecordings: DaemonDisconnectHost["listActiveVideoRecordings"],
    transportRestarts: AdbTransportRestartLookup,
    {
      checkPlanDeviceLoss,
      sweep,
    }: {
      checkPlanDeviceLoss: ReturnType<DaemonDisconnect["createPlanDeviceLossCheck"]>;
      sweep: DisconnectSweep;
    },
  ): Promise<void> {
    this.startDeferredSessionRecoverySweep();
    const activeRecordings = await listRecordings();
    const heldDevices = activeRecordings.map(({ deviceId, platform }) => ({
      assignedDevice: deviceId,
      platform,
    }));
    const pooled = this.host.services.devicePool().getAllDevices();
    const sessions = this.host.services.sessionManager().getAllSessions();
    const planOnTracked = [
      ...pooled.map(({ id }) => id),
      ...sessions.flatMap(({ assignedDevice }) =>
        assignedDevice === undefined ? [] : [assignedDevice],
      ),
      ...activeRecordings.map(({ deviceId }) => deviceId),
    ].some((id) => this.hasPlanExecution(id));
    const platform = sweep.selectPlatform(
      [
        ...pooled
          .filter((device) =>
            isHeldDisconnectDevice(
              device,
              this.host.services.devicePool().isDeviceLeasedForAndroidStartup(device.id),
            ),
          )
          .map((device) => device.platform),
        ...sessions.map((session) => session.platform),
        ...activeRecordings.map((recording) => recording.platform),
      ],
      planOnTracked,
    );
    let discovery = await this.discoverAndReconcile(deviceManager, {
      iosDeviceListMaxAgeMs: MONITOR_IOS_LIST_MAX_AGE_MS,
      platform,
      heldDevices,
    });
    let succeededPlatforms = discovery.succeededPlatforms;
    let bootedDeviceIds = new Set(discovery.devices.map((device) => device.deviceId));
    const missingByDevice = new Map<string, string[]>();
    const { candidateDeviceIds, candidatePlatforms, candidateIncarnations } =
      this.collectDisconnectCandidates(activeRecordings);
    let planDeviceIds = new Set([...candidateDeviceIds].filter((id) => this.hasPlanExecution(id)));
    const ordinaryCandidateIds = new Set(
      [...candidateDeviceIds].filter((id) => !planDeviceIds.has(id)),
    );
    const listed =
      platform === "ios"
        ? {}
        : await probeListedAndroidStates(this.host.services.devicePool(), deviceManager, false, {
            candidateDeviceIds: ordinaryCandidateIds,
            bootedDeviceIds,
            candidatePlatforms,
          });
    if (
      await this.recoverOfflineCandidates(
        deviceManager,
        listed,
        candidateDeviceIds,
        candidateIncarnations,
      )
    ) {
      // Reconnect may restore a transport; discard the pre-recovery absence.
      discovery = await this.discoverAndReconcile(deviceManager, {
        heldDevices,
        platform,
        bypassAndroidDeviceListCache: true,
      });
      succeededPlatforms = discovery.succeededPlatforms;
      bootedDeviceIds = new Set(discovery.devices.map((device) => device.deviceId));
    }
    const disconnectResult = evaluateDeviceDisconnects({
      deviceDisconnectMisses: this.host.lifecycle.deviceDisconnectMisses(),
      confirmedDisconnectedDeviceIds: this.host.confirmedDisconnectedDeviceIds(),
      bootedDeviceIds,
      candidateDeviceIds,
      succeededPlatforms,
      succeededSources: discovery.succeededSources,
      candidatePlatforms,
      candidateIncarnations,
      deviceDisconnectMissIncarnations: this.host.deviceDisconnectMissIncarnations(),
      forceDisconnectedDeviceIds: this.host.forceDisconnectedDeviceIds(),
      transitionalDeviceIds: transitionalCandidateIds(
        this.host.services.devicePool(),
        discovery,
        listed,
      ),
      offlineEpisodes: this.host.offlineEpisodes(),
      nowMs: this.host.services.timer().monotonicNow?.() ?? this.host.services.timer().now(),
      immediateDisconnectDeviceIds: selectImmediateDisconnectCandidates(
        candidateDeviceIds,
        candidatePlatforms,
        bootedDeviceIds,
        listed.listedNonDeviceIds,
        transportRestarts,
      ),
    });
    if (disconnectResult.skippedAllDiscoveryFailed) {
      logger.warn(
        `[DisconnectMonitor] No platform discovery succeeded but ${candidateDeviceIds.size} tracked — skipping miss count`,
      );
      return;
    }
    // A lease or device switch can land during the listed-state/reconnect awaits.
    // Retain earlier protection for this sweep and include the current assignments.
    planDeviceIds = new Set([
      ...planDeviceIds,
      ...[...candidateDeviceIds].filter((id) => this.hasPlanExecution(id)),
    ]);
    this.logDisconnectMisses(disconnectResult, planDeviceIds, bootedDeviceIds);
    // Only this device's plan owns bounded confirmation and grace.
    await checkPlanDeviceLoss(disconnectResult, bootedDeviceIds);
    for (const deviceId of disconnectResult.disconnected.filter((id) => !planDeviceIds.has(id))) {
      missingByDevice.set(deviceId, []);
    }
    sweep.idleSignature = eligibleIdleSweepSignature(
      discovery.succeededPlatforms,
      this.host.lifecycle.deviceDisconnectMisses().size,
      candidateDeviceIds,
      bootedDeviceIds,
      this.host.services
        .devicePool()
        .getAllDevices()
        .map((device) => device.id),
    );
    await this.cleanupDisconnects(bootedDeviceIds, succeededPlatforms, missingByDevice, {
      activeRecordings,
      sweep,
    });
  }

  private async cleanupDisconnects(
    bootedDeviceIds: Set<string>,
    succeededPlatforms: Set<Platform>,
    missingByDevice: Map<string, string[]>,
    {
      activeRecordings,
      sweep,
    }: {
      activeRecordings: Awaited<ReturnType<DaemonDisconnectHost["listActiveVideoRecordings"]>>;
      sweep: { adbServerResetCohort: readonly PooledDevice[] };
    },
  ): Promise<void> {
    const resetCohort = getProcessWideAdbServerResetCohort(
      bootedDeviceIds,
      succeededPlatforms,
      this.host.forceDisconnectedDeviceIds(),
      this.host.services.devicePool().getAllDevices(),
    );
    // Detachment is atomic for the whole owned Android cohort. Defer if one
    // member has plan work, but an unrelated iOS plan cannot block Android recovery.
    const deferCohort = resetCohort.some((device) => this.hasPlanExecution(device.id));
    if (deferCohort) {
      for (const device of resetCohort) {
        missingByDevice.delete(device.id);
      }
    }
    const detectedAdbServerResetCohort = deferCohort ? [] : resetCohort;
    const adbServerResetDetachment =
      detectedAdbServerResetCohort.length > 0
        ? await this.host.services
            .devicePool()
            .detachAdbServerResetCohort(detectedAdbServerResetCohort)
        : { devices: [], deferred: false };
    if (adbServerResetDetachment.deferred) {
      logger.info(
        "[DisconnectMonitor] Deferring process-wide ADB reset recovery until matching Android startup completes",
      );
      return;
    }
    sweep.adbServerResetCohort = adbServerResetDetachment.devices;
    const adbServerResetCohortByDeviceId = collectDisconnectedRecordings(
      sweep.adbServerResetCohort,
      missingByDevice,
      activeRecordings,
    );
    for (const [deviceId, recordingIds] of missingByDevice) {
      if (!this.hasPlanExecution(deviceId)) {
        await this.host.cleanupDisconnectedDevice(
          deviceId,
          recordingIds,
          adbServerResetCohortByDeviceId,
        );
      }
    }
  }
}
