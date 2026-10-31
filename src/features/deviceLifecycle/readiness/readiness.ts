import { type DeviceBootResult } from "../../../devices/deviceBootService";
import { SystemUiAnrRecoveryRequiredError } from "../../../ctrlProxy/RunnerReadinessService";
import { logger } from "../../../utils/logger";
import { type DevicePool, type DeviceReadinessReservation } from "../../../daemon/devicePool";
import type { DaemonStateLike } from "../../../daemon/daemonState";
import { errorMessage } from "../../../utils/describeUnknownError";
import type {
  StartDeviceRunnerReadinessInput,
  ReadinessDevicePool,
} from "../startDeviceReadinessTypes";
import { serverConfig } from "../../../utils/ServerConfig";
import { type SessionManager } from "../../../daemon/sessionManager";
import { type BindingFields, holderOf } from "../../../daemon/deviceBinding";
import { isSameHolderSession, heldDeviceBindRefusal } from "../../../daemon/inputDeviceOwnership";
import {
  releaseSessionAndDevice,
  releasePoolDevice,
} from "../../../daemon/releaseSessionAndDevice";
import { deviceLossCancellationReason as utilDeviceLossCancellationReason } from "../../../utils/deviceLossCancellationReason";
import { lifecycleRequester } from "../lifecycleRequester";
import { captureAutolockPolicy } from "../../../daemon/deviceAutolockPolicy";
import {
  type SystemUiAnrRecoveryResult,
  rebootAndroidAfterSystemUiAnr,
} from "../systemUiRecovery/systemUiRecovery";
import { type StartDeviceArgs } from "../core/contracts";
import { validateBootIdentity, validatePooledDeviceMapping } from "../boot/bootIdentity";
import {
  clearColdBootShutdownMarker,
  liveHolderOtherThanThisRequest,
  shouldClearIntentionalShutdownAfterFailure,
  stopUnownedColdBoot,
} from "../boot/bootSettlement";
import { type DeviceToolsDependencies, getDeviceToolsDependencies } from "../core/dependencies";
import { DEVICE_SHUTDOWN_TIMEOUT_MS, runWithinShutdownDeadline } from "../core/deadlines";
import { waitForDeviceShutdown } from "../teardown/shutdownDiscovery";
import { isUnknownAndroidRuntimeName } from "../identity/androidIdentity";

export async function ensureRunnerReadyWithSystemUiAnrRecovery(
  boot: DeviceBootResult,
  ensureRunnerReady: (candidate: DeviceBootResult) => Promise<void>,
  rebootAfterSystemUiAnr: (candidate: DeviceBootResult) => Promise<SystemUiAnrRecoveryResult>,
): Promise<SystemUiAnrRecoveryResult & { recovered: boolean }> {
  try {
    await ensureRunnerReady(boot);
    return { boot, recovered: false };
  } catch (error) {
    if (
      !(error instanceof SystemUiAnrRecoveryRequiredError) ||
      boot.device.platform !== "android"
    ) {
      throw error;
    }
    const recovery = await rebootAfterSystemUiAnr(boot);
    try {
      await ensureRunnerReady(recovery.boot);
    } catch (readinessError) {
      try {
        await recovery.retireReplacement?.();
      } catch (retireError) {
        logger.warn(
          `[DeviceTools] Failed to retire System UI recovery replacement: ${retireError}`,
          retireError,
        );
      }
      try {
        // rebootAfterSystemUiAnr retained the readiness reservation for the
        // replacement, but it only reaches the caller's ordered cleanup once this
        // returns. Release it here so a failed second readiness check does not
        // strand the recovered AVD out of general allocation forever.
        await recovery.releaseReadinessReservation?.();
      } catch (releaseError) {
        logger.warn(
          `[DeviceTools] Failed to release System UI recovery readiness reservation: ${releaseError}`,
          releaseError,
        );
      }
      recovery.releaseRecoveryRouteLease?.();
      throw readinessError;
    }
    return { ...recovery, recovered: true };
  }
}

export async function reserveRecoveredDeviceForReadiness(
  devicePool: Pick<DevicePool, "reserveDeviceForReadiness"> | undefined,
  boot: DeviceBootResult,
  args: StartDeviceArgs,
  {
    requestedIdentity,
    releaseReadinessReservations,
  }: { requestedIdentity: string; releaseReadinessReservations: DeviceReadinessReservation[] },
): Promise<void> {
  validateBootIdentity(args, boot.device, boot.source, boot.sourceImage);
  await validatePooledDeviceMapping(boot.device, requestedIdentity);
  if (devicePool) {
    releaseReadinessReservations.push(
      await devicePool.reserveDeviceForReadiness(
        boot.device.deviceId,
        boot.device,
        boot.sourceImage?.name ?? boot.device.name,
        undefined,
        { enforceAndroidRecoveryExclusion: boot.device.platform === "android" },
      ),
    );
  }
  clearColdBootShutdownMarker(boot.source, boot.device.deviceId);
}

export function getStartDevicePool<Pool>(daemonState: {
  isInitialized(): boolean;
  getDevicePool(): Pool;
}): Pool | undefined {
  return daemonState.isInitialized() ? daemonState.getDevicePool() : undefined;
}

export async function reserveInitialDeviceForReadiness(
  daemonState: DaemonStateLike,
  boot: DeviceBootResult,
  releaseReadinessReservations: DeviceReadinessReservation[],
  { mcpSessionId, oneShotCli = false }: { mcpSessionId?: string; oneShotCli?: boolean } = {},
): Promise<void> {
  const devicePool = getStartDevicePool(daemonState);
  if (!devicePool) {
    return;
  }
  releaseReadinessReservations.push(
    await devicePool.reserveDeviceForReadiness(
      boot.device.deviceId,
      boot.device,
      boot.sourceImage?.name ?? boot.device.name,
      undefined,
      {
        autolockClient: oneShotCli ? { oneShotCli } : mcpSessionId ? { mcpSessionId } : undefined,
        enforceAndroidRecoveryExclusion: true,
      },
    ),
  );
}

export function deviceInventoryChangedAfterBoot(boot: DeviceBootResult): boolean {
  return boot.source === "cold-boot" || boot.provisioned;
}

export function refreshResourcesAfterCommittedBoot(
  boot: DeviceBootResult,
  dependencies: Pick<
    DeviceToolsDependencies,
    "notifyDeviceInventoryResourcesChanged" | "syncInstalledAppResourceRegistry"
  >,
): void {
  if (!deviceInventoryChangedAfterBoot(boot)) {
    return;
  }
  // Session ownership is already committed, so resource refresh and transport
  // delivery are advisory: neither may withhold the acquired session.
  void (async () => {
    let installedAppResourcesChanged = false;
    try {
      installedAppResourcesChanged = await dependencies.syncInstalledAppResourceRegistry();
    } catch (error) {
      logger.warn(
        `[DeviceTools] Installed-app resource sync after device boot failed: ${errorMessage(error)}`,
        error,
      );
    }
    try {
      await dependencies.notifyDeviceInventoryResourcesChanged(installedAppResourcesChanged);
    } catch (error) {
      logger.warn(
        `[DeviceTools] Resource notification after device boot failed: ${errorMessage(error)}`,
        error,
      );
    }
  })();
}

export function createRunnerReadinessAttempt(
  input: StartDeviceRunnerReadinessInput,
): (candidate: DeviceBootResult) => Promise<void> {
  return async (candidate) => {
    input.signal?.throwIfAborted();
    await input.ensureCtrlProxyReady({
      device: candidate.device,
      requestedIdentity: input.requestedIdentity,
      operationName: input.operationName,
      totalDeadlineMs: input.totalDeadlineMs,
      readinessTimeoutMs: input.readinessTimeoutMs,
      skipCtrlProxyDownload: serverConfig.isSkipCtrlProxyDownloadEnabled(),
      perf: input.perf,
      signal: input.signal,
    });
  };
}

export function captureSystemUiAnrInitialHolder(
  input: {
    boot: { device: { deviceId: string } };
    daemonState: { getSessionManager(): Pick<SessionManager, "findSession"> };
  },
  devicePool:
    | { getDevice(id: string): Pick<BindingFields, "sessionId"> | null | undefined }
    | undefined,
): string | undefined {
  const sessionId = holderOf(devicePool?.getDevice(input.boot.device.deviceId));
  return sessionId && input.daemonState.getSessionManager().findSession(sessionId)
    ? sessionId
    : undefined;
}

export function createSystemUiAnrRebooter(
  input: StartDeviceRunnerReadinessInput,
  devicePool: ReadinessDevicePool | undefined,
  recoveryAutolockClient: { mcpSessionId?: string; expectedSessionId?: string } | undefined,
  entitlement: {
    initialHolder: string | undefined;
    requesterSessionUuid: string | undefined;
    autolockEnabled: boolean;
  },
): (candidate: DeviceBootResult) => Promise<SystemUiAnrRecoveryResult> {
  return async (candidate) => {
    const manager = devicePool ? input.daemonState.getSessionManager() : undefined;
    const hasOtherHolder = (deviceId: string) => {
      const holder = liveHolderOtherThanThisRequest(deviceId);
      return (
        holder !== undefined &&
        !(
          holder === entitlement.initialHolder &&
          (entitlement.autolockEnabled || entitlement.requesterSessionUuid === undefined)
        ) &&
        !isSameHolderSession(holder, entitlement.requesterSessionUuid, manager)
      );
    };
    const assertHolder = () => {
      if (hasOtherHolder(candidate.device.deviceId)) {
        throw heldDeviceBindRefusal(
          devicePool,
          candidate.device.deviceId,
          liveHolderOtherThanThisRequest(candidate.device.deviceId),
          { requesterSessionUuid: entitlement.requesterSessionUuid, wording: "another" },
        );
      }
    };
    const sessionId = holderOf(devicePool?.getDevice(candidate.device.deviceId));
    const session = sessionId ? manager?.getSession(sessionId) : undefined;
    return await rebootAndroidAfterSystemUiAnr({
      boot: candidate,
      args: input.args,
      bootService: input.bootService,
      deviceManager: input.deviceUtils,
      devicePool,
      totalDeadlineMs: input.totalDeadlineMs,
      timer: input.timer,
      signal: input.signal,
      progress: input.progress ? { report: input.progress } : undefined,
      recoveryAutolockClient,
      assertHolder,
      collectColdBootSettlement: input.collectColdBootSettlement,
      publishReplacementReadinessMarker: (replacement) =>
        input.publishRecoveredReadinessMarker?.(replacement),
      releasePreservedSession: async (replacement, preservedSessionId) => {
        if (
          !devicePool ||
          !manager ||
          !sessionId ||
          preservedSessionId !== sessionId ||
          devicePool.getDevice(replacement.id) !== replacement ||
          holderOf(replacement) !== sessionId
        ) {
          return;
        }
        if (session) {
          await releaseSessionAndDevice(manager, devicePool, replacement.id, sessionId, {
            reason: utilDeviceLossCancellationReason(replacement.id),
            release: async () =>
              await manager.releaseSession(
                sessionId,
                utilDeviceLossCancellationReason(replacement.id),
                { expectedOwner: { session: session, deviceId: replacement.id } },
              ),
          });
        } else {
          await releasePoolDevice(devicePool, replacement.id, sessionId);
        }
      },
      operations: {
        deviceShutdownTimeoutMs: DEVICE_SHUTDOWN_TIMEOUT_MS,
        runWithinShutdownDeadline,
        waitForDeviceShutdown,
        shouldClearIntentionalShutdownAfterFailure,
        cancelUnownedColdBoot: stopUnownedColdBoot,
        isUnknownAndroidRuntimeName,
      },
    });
  };
}

export async function prepareRecoveredDeviceForRunnerReadiness(
  input: StartDeviceRunnerReadinessInput,
  devicePool: Pick<DevicePool, "reserveDeviceForReadiness"> | undefined,
  recovery: SystemUiAnrRecoveryResult,
): Promise<void> {
  if (recovery.releaseReadinessReservation) {
    input.releaseReadinessReservations.push(recovery.releaseReadinessReservation);
  }
  await reserveRecoveredDeviceForReadiness(devicePool, recovery.boot, input.args, {
    requestedIdentity: input.requestedIdentity,
    releaseReadinessReservations: input.releaseReadinessReservations,
  });
}

export async function prepareStartDeviceRunnerReadiness(
  input: StartDeviceRunnerReadinessInput,
): Promise<SystemUiAnrRecoveryResult & { recovered: boolean }> {
  // Exact binds can arrive during readiness; capture identities before leaving request context.
  const devicePool = getStartDevicePool(input.daemonState);
  const initialHolder = captureSystemUiAnrInitialHolder(input, devicePool);
  // startDeviceSchema strips sessionUuid, so caller identity comes from admitted ambient routing.
  const requesterSessionUuid = lifecycleRequester(input.args).sessionUuid;
  const autolockEnabled =
    (input.autolockEnabled ?? captureAutolockPolicy(getDeviceToolsDependencies().env)) &&
    Boolean(devicePool);
  const recoveryAutolockClient =
    autolockEnabled && devicePool
      ? {
          mcpSessionId: input.args.__mcpSessionId,
          expectedSessionId: devicePool.captureAutolockSessionForMcpSession(
            input.args.__mcpSessionId,
          ),
        }
      : undefined;
  const readinessResult = await ensureRunnerReadyWithSystemUiAnrRecovery(
    input.boot,
    createRunnerReadinessAttempt(input),
    createSystemUiAnrRebooter(input, devicePool, recoveryAutolockClient, {
      initialHolder,
      requesterSessionUuid,
      autolockEnabled,
    }),
  );
  if (readinessResult.recovered) {
    try {
      await prepareRecoveredDeviceForRunnerReadiness(input, devicePool, readinessResult);
    } catch (error) {
      readinessResult.releaseRecoveryRouteLease?.();
      try {
        await readinessResult.retireReplacement?.();
      } catch (cleanupError) {
        logger.warn(
          `[DeviceTools] Failed to retire replacement after recovered readiness reservation failed: ${cleanupError}`,
          cleanupError,
        );
      }
      throw error;
    }
  }
  return readinessResult;
}
