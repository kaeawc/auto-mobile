import { ActionableError, BootedDevice } from "../../models";
import { NavigationGraphManager } from "../../features/navigation/NavigationGraphManager";
import { RealObserveScreen } from "../../features/observe/ObserveScreen";
import { logger } from "../../utils/logger";
import { errorMessage } from "../../utils/describeUnknownError";
import { type SessionManager } from "../../daemon/sessionManager";
import { defaultDaemonContext, type DevicePoolWrites } from "../../daemon/daemonContext";
import { releasePlanSessionAndDevice } from "../../daemon/releaseSessionAndDevice";
import { ListChangedBroadcaster } from "../../daemon/listChangedBroadcast";
import {
  type AppCleanupConfig,
  type AppCleanupStep,
  AppCleanupService,
} from "../AppCleanupService";
import {
  failedPlanSessionHoldable,
  getDeviceLabelMap,
  releaseDeviceLabelSessions,
} from "../deviceLabelMapping";
import { deferHeldPlanAppCleanup, takeHeldPlanAppCleanup } from "../heldPlanAppCleanup";
import { defaultTimer, type Timer } from "../../utils/SystemTimer";
import type { SessionToolSelectionService } from "../../features/toolSelection/SessionToolSelectionService";
import { getToolSelectionContext } from "../../features/toolSelection/toolSelectionContext";
import { isDeviceLostError } from "../../utils/deviceLossOutcome";
import { deviceLostErrorFromAbortSignal } from "../../utils/deviceLossAbortRegistry";
import { getAbortSignal, runWithAbortSignal } from "../../utils/AbortContext";
import { raceWithDeadline } from "../../utils/raceWithDeadline";

/**
 * Server-side session-binding teardown seam (issue #4611 Gap D). A daemon
 * session release (e.g. an executePlan auto-release) frees the session in the
 * SessionManager/DevicePool but cannot, by itself, reach the per-transport
 * `SessionToolBinding` held in `createMcpServer` (index.ts) — that binding still
 * resolves the released session as the transport's effective session, so a later
 * sessionless `tools/list`/`tools/call` keeps enforcing the released (stale)
 * profile. `createMcpServer` registers a handler here (interface + fake per DI
 * convention) so the actual release path can clear its transport binding.
 */
export interface SessionBindingReleaseHandler {
  onSessionReleased(sessionUuid: string): void;
}

export interface PlanLifecycleInput {
  name: string;
  args: any;
  baseSessionUuid: string | undefined;
  cleanupService: AppCleanupService;
  device: BootedDevice | undefined;
  sessionUuid: string | undefined;
  shouldResolveDevice: boolean;
  /** An enclosing plan owns cleanup and release for this invocation. */
  nestedInPlan?: boolean;
  /** The tool call returned a successful response (false when it failed or threw). */
  succeeded?: boolean;
  // Injected teardown for the server-side per-transport SessionToolBinding
  // (issue #4611 Gap D). Invoked AFTER a real release for every session freed —
  // base and derived label sessions alike — never optimistically.
  sessionBindingReleaseHandler?: SessionBindingReleaseHandler;
  /** Removes persisted tool overrides for sessions actually released. */
  sessionToolSelectionService?: Partial<Pick<SessionToolSelectionService, "deleteSession">>;
}

export interface PlanLifecycleManager {
  afterExecution(input: PlanLifecycleInput): Promise<void>;
}

/**
 * Upper bound on one executePlan's whole app cleanup, which runs under a private
 * signal because the request signal may already have aborted. Sized above a normal
 * terminate / `pm clear` and far below ClearAppData's own 60s action bound.
 */
export const PLAN_APP_CLEANUP_CAP_MS = 20_000;

/**
 * Deadline for one background app-cleanup retry (device-health recovery). The retry is a
 * full cleanup, so it gets the cleanup's own cap plus a margin: the cap's clean failure
 * must win the race, and a slow-but-successful retry must be able to clear the marker.
 */
export const PLAN_APP_CLEANUP_RETRY_DEADLINE_MS = PLAN_APP_CLEANUP_CAP_MS + 1_000;

/** One device whose app cleanup did not complete; `step` is absent when the service rejected. */
export interface PlanCleanupFailure {
  deviceId: string;
  step?: AppCleanupStep;
  reason: string;
}

/** What an executePlan app cleanup visibly did not do (the service logs its own soft failures). */
export interface PlanCleanupOutcome {
  /** Devices whose cleanup reported `failed` or rejected. */
  failures: PlanCleanupFailure[];
  /** Devices still running when {@link PLAN_APP_CLEANUP_CAP_MS} cut the cleanup short. */
  unfinishedDeviceIds: string[];
  /** The cleanup hit {@link PLAN_APP_CLEANUP_CAP_MS} and was cut short. */
  capExceeded: boolean;
}

// Exported for focused unit coverage (issue #3208). Production wires this via
// the ToolRegistry constructor; tests instantiate it directly to exercise
// executePlan cleanup and the auto-release guard without a live daemon session.
export class DefaultPlanLifecycleManager implements PlanLifecycleManager {
  /** The plan's base session and every device-label session derived from it. */
  private planSessionFamily(baseSessionUuid: string): ReadonlySet<string> {
    return new Set([baseSessionUuid, ...Object.values(getDeviceLabelMap(baseSessionUuid) ?? {})]);
  }

  /** Drop captured devices that a session outside `planSessions` now owns. */
  private devicesNotOwnedByOtherSessions(
    devices: BootedDevice[],
    planSessions: ReadonlySet<string>,
  ): BootedDevice[] {
    const sessionManager = defaultDaemonContext.requireSessionManager();
    return devices.filter((device) => {
      const owner = sessionManager.getSessionForDevice(device.deviceId);
      if (owner !== null && !planSessions.has(owner)) {
        logger.info(
          `[PlanLifecycle] Skipping deferred cleanup on ${device.deviceId}: now owned by ` +
            `session ${owner}`,
        );
        return false;
      }
      return true;
    });
  }

  private getCleanupDevices(
    primaryDevice: BootedDevice,
    baseSessionUuid: string | undefined,
  ): BootedDevice[] {
    const signal = getAbortSignal();
    const lostDeviceId = signal?.aborted
      ? deviceLostErrorFromAbortSignal(signal)?.deviceId
      : undefined;
    const isNotLost = (device: BootedDevice): boolean => {
      if (device.deviceId === lostDeviceId) {
        logger.debug(`[PlanLifecycle] Skipping cleanup for lost device ${device.deviceId}`);
        return false;
      }
      return true;
    };
    const sessionManager = baseSessionUuid ? defaultDaemonContext.sessionManager() : undefined;
    const devicePool = sessionManager ? defaultDaemonContext.devicePool() : undefined;
    if (!baseSessionUuid || !sessionManager || !devicePool) {
      return [primaryDevice].filter(isNotLost);
    }

    const sessions = this.planSessionFamily(baseSessionUuid);
    const devices = [...sessions].flatMap((sessionUuid): BootedDevice[] => {
      const session = sessionManager.getSession(sessionUuid);
      const pooledDevice = session ? devicePool.getDevice(session.assignedDevice) : null;
      if (!session || !pooledDevice || !sessionManager.isAdmittedForAutomation(session)) {
        logger.debug(
          `[PlanLifecycle] Skipping cleanup for unavailable session ${sessionUuid} / device ${session?.assignedDevice ?? "unknown"}`,
        );
        return [];
      }
      try {
        // Reuse the admission gate for device loss, recovery, shutdown and
        // identity quarantine; cleanup must not act on a retired runtime.
        devicePool.assertSessionReadyForAutomation(sessionUuid);
      } catch (error) {
        if (isDeviceLostError(error) || error instanceof ActionableError) {
          logger.debug(`[PlanLifecycle] Skipping cleanup for fenced session ${sessionUuid}`, error);
        } else {
          logger.warn(`[PlanLifecycle] Cleanup admission failed for session ${sessionUuid}`, error);
        }
        return [];
      }
      return [
        pooledDevice.id === primaryDevice.deviceId
          ? primaryDevice
          : {
              deviceId: pooledDevice.id,
              name: pooledDevice.name,
              platform: pooledDevice.platform,
              iosVersion: pooledDevice.iosVersion,
            },
      ];
    });
    return [...new Map(devices.map((device) => [device.deviceId, device])).values()].filter(
      isNotLost,
    );
  }

  constructor(private readonly timer: Timer = defaultTimer) {}

  /**
   * Cleans independent devices concurrently and drains them all before any session is
   * released. The request signal is often already aborted here (request deadline,
   * client cancel, a sibling device lost), so every adb call under it would fail at
   * once and leave the app running on a device about to return to the pool. Cleanup
   * therefore runs under its own signal, bounded by {@link PLAN_APP_CLEANUP_CAP_MS} so
   * a dead device cannot hang the release; reaching the cap aborts that private signal,
   * which fails the remaining adb calls. Every failure is logged at warn and returned
   * as a {@link PlanCleanupOutcome} so the caller can say what the cleanup did not do.
   */
  private async cleanupDevicesShielded(
    devices: BootedDevice[],
    cleanupService: AppCleanupService,
    config: AppCleanupConfig,
  ): Promise<PlanCleanupOutcome> {
    const shield = new AbortController();
    const failures: PlanCleanupFailure[] = [];
    const finished = new Set<string>();
    const cleanOne = async (cleanupDevice: BootedDevice): Promise<void> => {
      const { deviceId } = cleanupDevice;
      try {
        const result = await cleanupService.cleanup(cleanupDevice, config);
        if (result.status === "failed") {
          failures.push({ deviceId, step: result.step, reason: result.reason });
        }
      } catch (error) {
        failures.push({ deviceId, reason: errorMessage(error) });
        logger.warn(`[PlanLifecycle] App cleanup failed for device ${deviceId}`, error);
      }
      finished.add(deviceId);
    };
    try {
      await runWithAbortSignal(shield.signal, () =>
        raceWithDeadline(() => Promise.allSettled(devices.map(cleanOne)), {
          timer: this.timer,
          timeoutMs: PLAN_APP_CLEANUP_CAP_MS,
          label: "Plan app cleanup",
          onTimeout: () => shield.abort(new ActionableError("Plan app cleanup exceeded its cap")),
        }),
      );
      return { failures, unfinishedDeviceIds: [], capExceeded: false };
    } catch (error) {
      logger.warn(
        `[PlanLifecycle] App cleanup did not finish for ${devices.map((d) => d.deviceId).join(", ")}; releasing anyway`,
        error,
      );
      const unfinishedDeviceIds = devices
        .map((d) => d.deviceId)
        .filter((deviceId) => !finished.has(deviceId));
      return { failures, unfinishedDeviceIds, capExceeded: true };
    }
  }

  /**
   * The plan's response was finalized (envelope, spill, structuredContent) and the plan's
   * outcome decided before this runs, so an incomplete cleanup cannot be added to it. State
   * that once, at warn, so the daemon log shows that the reported outcome does not cover it.
   */
  private reportIncompleteCleanup(
    outcome: PlanCleanupOutcome,
    appId: string,
    sessionUuid: string | undefined,
  ): void {
    if (outcome.failures.length === 0 && !outcome.capExceeded) {
      return;
    }
    const failed = outcome.failures.map(
      ({ deviceId, step, reason }) => `${deviceId} (${step ?? "cleanup"}: ${reason})`,
    );
    const problems = [
      failed.length > 0 ? `failed on ${failed.join(", ")}` : "",
      outcome.unfinishedDeviceIds.length > 0
        ? `unfinished on ${outcome.unfinishedDeviceIds.join(", ")}`
        : "",
      outcome.capExceeded ? `did not finish within ${PLAN_APP_CLEANUP_CAP_MS}ms` : "",
    ].filter(Boolean);
    logger.warn(
      `[PlanLifecycle] executePlan app cleanup for ${appId} was incomplete (${problems.join("; ")}); ` +
        `the plan result was already finalized and does not report this (session ${sessionUuid ?? "none"})`,
    );
  }

  /**
   * A device whose cleanup did not complete must not return to the pool looking clean. Mark
   * it with the pool's existing device-health marker (it cannot be allocated while marked)
   * and let the session manager's bounded health recovery retry the cleanup once the device
   * is idle. The retry gets its own capped signal because recovery runs detached from this
   * call but inherits its ambient (often aborted) request signal.
   */
  private markIncompleteCleanupDevices(
    outcome: PlanCleanupOutcome,
    devices: BootedDevice[],
    cleanupService: AppCleanupService,
    config: AppCleanupConfig,
    cleanupSessionUuids: ReadonlyMap<string, string>,
  ): void {
    const dirty = new Set([
      ...outcome.failures.map((failure) => failure.deviceId),
      ...outcome.unfinishedDeviceIds,
    ]);
    const sessionManager = dirty.size === 0 ? undefined : defaultDaemonContext.sessionManager();
    if (!sessionManager) {
      return;
    }
    for (const cleanupDevice of devices.filter((d) => dirty.has(d.deviceId))) {
      sessionManager.markDeviceNeedsAppCleanup(
        cleanupDevice.deviceId,
        async () => {
          const retry = await this.cleanupDevicesShielded([cleanupDevice], cleanupService, config);
          if (retry.failures.length > 0 || retry.capExceeded) {
            throw new ActionableError(
              `App cleanup retry for ${config.appId} did not complete on ${cleanupDevice.deviceId}`,
            );
          }
        },
        PLAN_APP_CLEANUP_RETRY_DEADLINE_MS,
        `${config.appId}:${config.clearAppData ? "clearAppData" : "terminateApp"}`,
        cleanupSessionUuids.get(cleanupDevice.deviceId),
      );
    }
  }

  /**
   * A failed executePlan whose caller asked to keep its session (`holdSessionOnFailure`) keeps the
   * session and its device, so the caller's recovery and the resumed plan run on a device no other
   * session can take in between (#10834). The caller owns the session from here: the resumed plan
   * releases it, or the caller releases it (or stops heartbeating) when it gives up. A plan with
   * derived label sessions is released as before: they have no caller-side owner. A single-label
   * plan's only session is the base, so it is held like an unlabeled plan (#11091).
   */
  private holdsFailedPlanSessionForRecovery(
    input: PlanLifecycleInput,
    releaseSessionUuid: string,
  ): boolean {
    if (input.args?.holdSessionOnFailure !== true || input.succeeded !== false) {
      return false;
    }
    if (!failedPlanSessionHoldable(releaseSessionUuid)) {
      logger.info(
        `[PlanLifecycle] holdSessionOnFailure ignored for ${releaseSessionUuid}: a plan with ` +
          "derived label sessions is always released (reported as sessionHeld: false)",
      );
      return false;
    }
    logger.info(
      `[PlanLifecycle] Keeping session ${releaseSessionUuid} and its device after a failed ` +
        "executePlan (holdSessionOnFailure) for the caller's recovery",
    );
    return true;
  }

  async afterExecution(input: PlanLifecycleInput): Promise<void> {
    if (input.name === "executePlan" && input.nestedInPlan) {
      // The enclosing plan is still using these sessions and devices.
      return;
    }
    const { baseSessionUuid, sessionUuid } = input;
    const lifecycleSessionUuid = baseSessionUuid ?? sessionUuid;
    const { wantsPoolSession, poolSessionManager } = planPoolSession(input, lifecycleSessionUuid);
    const ownsPoolSession = wantsPoolSession && poolSessionManager !== undefined;
    const heldForRecovery =
      ownsPoolSession && this.holdsFailedPlanSessionForRecovery(input, lifecycleSessionUuid!);
    // A cleanup deferred by an earlier failed run on this session (#11139) is superseded once
    // this run's own lifecycle cleans and releases it.
    const deferredCleanup =
      ownsPoolSession && poolSessionManager && !heldForRecovery
        ? takeHeldPlanAppCleanup(poolSessionManager, lifecycleSessionUuid!)
        : undefined;

    await this.cleanupAfterPlan(input, {
      lifecycleSessionUuid,
      poolSessionManager,
      heldForRecovery,
      deferredCleanup,
    });

    if (ownsPoolSession && poolSessionManager && !heldForRecovery) {
      await this.releasePlanSessions(input, poolSessionManager, lifecycleSessionUuid!);
    }
  }

  private async cleanupAfterPlan(
    input: PlanLifecycleInput,
    state: {
      lifecycleSessionUuid: string | undefined;
      poolSessionManager: SessionManager | undefined;
      heldForRecovery: boolean;
      deferredCleanup: (() => Promise<unknown>) | undefined;
    },
  ): Promise<void> {
    const { device, name, args, cleanupService } = input;
    const { lifecycleSessionUuid, poolSessionManager, heldForRecovery, deferredCleanup } = state;
    if (device && name === "executePlan" && args?.cleanupAppId) {
      // Resolved under the request signal: a device-loss abort names the lost device
      // to skip. A deadline or client cancel aborts it too but names no device, so
      // those plans still clean every device they own (#10022).
      const devices = this.getCleanupDevices(device, lifecycleSessionUuid);
      const cleanupConfig = { appId: args.cleanupAppId, clearAppData: args.cleanupClearAppData };
      // Keep the originating family member even if cleanup outlives its binding.
      const sessionManager = poolSessionManager ?? defaultDaemonContext.sessionManager();
      const cleanupSessionUuids = new Map(
        [...(lifecycleSessionUuid ? this.planSessionFamily(lifecycleSessionUuid) : [])].flatMap(
          (uuid) => {
            const deviceId = sessionManager?.getDeviceForSession(uuid);
            return deviceId ? [[deviceId, uuid] as const] : [];
          },
        ),
      );
      const runCleanup = async (targets: BootedDevice[]): Promise<void> => {
        const outcome = await this.cleanupDevicesShielded(targets, cleanupService, cleanupConfig);
        this.reportIncompleteCleanup(outcome, cleanupConfig.appId, lifecycleSessionUuid);
        this.markIncompleteCleanupDevices(
          outcome,
          targets,
          cleanupService,
          cleanupConfig,
          cleanupSessionUuids,
        );
      };
      if (poolSessionManager && heldForRecovery) {
        // The caller's recovery and resumed plan need the app as the failure left it (#11139):
        // clean up only once the held session is finally released.
        logger.info(
          `[PlanLifecycle] Deferring app cleanup for ${cleanupConfig.appId} until held session ` +
            `${lifecycleSessionUuid} is released`,
        );
        // The held session may be rebound before its release and its old device acquired by
        // another session (#11164): skip, at run time, any device now owned outside this plan.
        const planSessions = this.planSessionFamily(lifecycleSessionUuid!);
        deferHeldPlanAppCleanup(
          poolSessionManager,
          lifecycleSessionUuid!,
          () => runCleanup(this.devicesNotOwnedByOtherSessions(devices, planSessions)),
          PLAN_APP_CLEANUP_CAP_MS,
        );
      } else {
        await runCleanup(devices);
      }
    } else if (deferredCleanup) {
      await deferredCleanup();
    }
  }

  private async releasePlanSessions(
    input: PlanLifecycleInput,
    poolSessionManager: SessionManager,
    lifecycleSessionUuid: string,
  ): Promise<void> {
    const { sessionBindingReleaseHandler, sessionToolSelectionService } = input;
    const sessionManager = poolSessionManager;
    const devicePool = defaultDaemonContext.requireDevicePoolWrites();
    const releaseSessionUuid = lifecycleSessionUuid;
    // Track exactly which sessions this release actually frees so the
    // server-side transport binding is torn down for each (issue #4611 Gap
    // D) — coupled to the REAL release, never cleared optimistically. Each
    // derived session and the base are released independently, so one failed
    // release cannot leave the others holding their devices (#11091).
    const releasedSessionUuids = await releaseDeviceLabelSessions(releaseSessionUuid);
    // A plan run owns the derived label sessions it created and its base session, with one
    // exception: a managed connection's binding session belongs to the connection for its
    // lifetime (#11421). Its broker grant is fixed and a `plan-auto-release` UUID is not reusable,
    // so releasing it would strand the connection. A generic connection's base session is
    // released whether or not it existed before the plan (docs: `holdSessionOnFailure`).
    if (defaultDaemonContext.brokerConnectionScopes()?.forGrantedSession(releaseSessionUuid)) {
      logger.info(
        `[PlanLifecycle] Keeping binding session ${releaseSessionUuid} and its device ` +
          "after executePlan: it belongs to its connection",
      );
    } else if (await this.releasePlanBaseSession(sessionManager, devicePool, releaseSessionUuid)) {
      releasedSessionUuids.push(releaseSessionUuid);
    }

    // Clear the per-transport SessionToolBinding for every freed session so a
    // later sessionless tools/list or tools/call stops enforcing a released
    // profile (issue #4611 Gap D). Best-effort: the handler swallows its own
    // failures, but the release itself has already succeeded regardless.
    for (const releasedUuid of releasedSessionUuids) {
      try {
        sessionBindingReleaseHandler?.onSessionReleased(releasedUuid);
        await sessionToolSelectionService?.deleteSession?.(releasedUuid);
        ListChangedBroadcaster.invalidate("tools");
      } catch (bindingError) {
        logger.warn(
          `[PlanLifecycle] Failed to clear the tool binding of released session ${releasedUuid}`,
          bindingError,
        );
      }
    }
  }

  /**
   * Release a finished plan's base session and free its device. `releaseSessionAndDevice` returns
   * the pool slot even when the session release rejects after the session was removed, so a gone
   * session never leaves its device assigned (#11091). Returns whether the session is gone.
   */
  private async releasePlanBaseSession(
    sessionManager: SessionManager,
    devicePool: DevicePoolWrites,
    releaseSessionUuid: string,
  ): Promise<boolean> {
    const session = sessionManager.getSession(releaseSessionUuid);
    if (!session) {
      return false;
    }
    const deviceId = session.assignedDevice;
    try {
      // Await the release so its onSessionRelease callbacks (CtrlProxy binding +
      // detector cleanup) complete before the device is freed (#4984).
      // Any other call still running under the session is cut before the device is freed; the
      // plan's own call, which is running under the session it releases, is spared (#11490).
      await releasePlanSessionAndDevice(sessionManager, devicePool, {
        sessionId: session.sessionId,
        deviceId,
        excludeExecutionId: getToolSelectionContext()?.execution?.executionId,
      });
      logger.info(
        `Auto-released session ${session.sessionId} and freed device ${deviceId} after executePlan`,
      );
    } catch (releaseError) {
      logger.warn(`Failed to auto-release session ${releaseSessionUuid}: ${releaseError}`);
      if (sessionManager.hasSession(releaseSessionUuid)) {
        return false;
      }
    }
    NavigationGraphManager.releaseSession(releaseSessionUuid);
    // CtrlProxy client binding + detector cleanup for the released session is
    // handled centrally in the daemon's onSessionRelease hook (#4984), which
    // covers every release path and each derived label session on its device.
    RealObserveScreen.clearCache(deviceId);
    return true;
  }
}

function planPoolSession(input: PlanLifecycleInput, lifecycleSessionUuid: string | undefined) {
  const { name, sessionUuid, shouldResolveDevice } = input;
  const wantsPoolSession =
    shouldResolveDevice &&
    sessionUuid !== undefined &&
    lifecycleSessionUuid !== undefined &&
    name === "executePlan";
  const poolSessionManager = wantsPoolSession ? defaultDaemonContext.sessionManager() : undefined;
  return { wantsPoolSession, poolSessionManager };
}
