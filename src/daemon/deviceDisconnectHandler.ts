import { logger } from "../utils/logger";
import { resetAdbDeviceListCache } from "../utils/android-cmdline-tools/AdbClient";
import { resetBootedDevicesResourceCache } from "../server/bootedDeviceResources";
import { resetAndroidDeviceImageResourceCache } from "../server/deviceImageResources";
import type { BootedDeviceDiscovery, PlatformDeviceManager } from "../devices/deviceUtils";
import type { BootedDevice, DeviceInfo } from "../models";
import type { DeviceRecoveryPolicy } from "./poolConfig";
import type { PooledDevice } from "./devicePool";
import type { EmulatorLossDetectionPath } from "./emulatorLossIncident";
import { classifyMissingDeviceObservation } from "./missingDeviceLiveness";
import { didSourceSucceedForDevice } from "../utils/discoverySource";
import { isPhysicalAndroidUsbSerial } from "../utils/androidSerial";
import { deviceLossCancellationReason } from "../utils/deviceLossCancellationReason";
import type { Timer } from "../utils/SystemTimer";

/** Confirm on a later plan tick, beyond the 1–3s adb root/unroot restart window. */
export const PLAN_DEVICE_LOSS_CONFIRMATION_WINDOW_MS = 5_000;

interface PlanLossTarget {
  device: PooledDevice;
  incarnation: number;
  assignmentCount: number;
  sessionId: string;
  planSessionUuid: string;
}

export interface PlanDeviceLossPort {
  timer: Pick<Timer, "now">;
  /** AutoMobile is restarting this serial's adbd; keep the confirmation window (#10493). */
  isTransportRestarting?(deviceId: string): boolean;
  getDevice(deviceId: string): PooledDevice | null;
  getPlanSessionUuid(sessionId: string): string;
  hasPlanExecution(deviceId: string, planSessionUuid: string): boolean;
  isStartupLeased(deviceId: string): boolean;
  isShutdownReserved(deviceId: string): Promise<boolean>;
  discover(): Promise<BootedDeviceDiscovery>;
  getOfflineDeviceIds(deviceIds: Iterable<string>): Promise<Set<string>>;
  isAdbReset(bootedDeviceIds: ReadonlySet<string>, discovery: BootedDeviceDiscovery): boolean;
  recordLoss(deviceId: string): Promise<string | undefined>;
  finishLoss(incidentId: string | undefined): Promise<void>;
  cancelPlan(deviceId: string, planSessionUuid: string, reason: string): Promise<number>;
}

/** Confirm plan losses without consuming debounce grace or mutating pool/session ownership. */
export class PlanDeviceLossMonitor {
  private readonly reported = new Map<string, PlanLossTarget>();
  private readonly pending = new Map<string, { target: PlanLossTarget; absentSince: number }>();

  constructor(private readonly port: PlanDeviceLossPort) {}

  async check(
    missingDeviceIds: readonly string[],
    bootedDeviceIds: ReadonlySet<string>,
  ): Promise<void> {
    const missing = new Set(missingDeviceIds);
    for (const [deviceId, { target }] of this.pending) {
      if (!missing.has(deviceId) || bootedDeviceIds.has(deviceId) || !this.isCurrent(target)) {
        this.pending.delete(deviceId);
      }
    }
    for (const [deviceId, target] of this.reported) {
      if (bootedDeviceIds.has(deviceId) || !this.isCurrent(target)) {
        this.reported.delete(deviceId);
      }
    }
    const targets = await this.collectTargets(missingDeviceIds);
    if (targets.length === 0) {
      return;
    }
    // Booted discovery omits ADB-offline rows. They cannot establish loss,
    // even when they persist beyond the confirmation window. One cache-bypassing
    // discovery and an independent offline probe supply this sweep's evidence.
    // Rejected probes break the evidence before the daemon's tick catch logs them.
    let discovery: BootedDeviceDiscovery;
    let offlineDeviceIds: Set<string>;
    try {
      [discovery, offlineDeviceIds] = await Promise.all([
        this.port.discover(),
        this.port.getOfflineDeviceIds(targets.map(({ device }) => device.id)),
      ]);
    } catch (error) {
      this.pending.clear();
      throw error;
    }
    const confirmedBootedIds = new Set(discovery.devices.map((device) => device.deviceId));
    if (this.port.isAdbReset(confirmedBootedIds, discovery)) {
      this.pending.clear();
      return;
    }
    for (const target of targets) {
      await this.confirmTarget(target, confirmedBootedIds, discovery, offlineDeviceIds);
    }
  }

  private captureTarget(deviceId: string): PlanLossTarget | undefined {
    const device = this.port.getDevice(deviceId);
    // Allocation/restart owns startup-leased and shutdown-reserved devices. The global
    // plan lease alone is not evidence that a plan has begun using this device.
    if (!device || device.platform !== "android" || device.status !== "busy" || !device.sessionId) {
      return undefined;
    }
    const target: PlanLossTarget = {
      device,
      incarnation: device.incarnation,
      assignmentCount: device.assignmentCount,
      sessionId: device.sessionId,
      planSessionUuid: this.port.getPlanSessionUuid(device.sessionId),
    };
    return this.reported.has(deviceId) || !this.hasPlanWork(target) ? undefined : target;
  }

  private async collectTargets(missingDeviceIds: readonly string[]): Promise<PlanLossTarget[]> {
    const targets: PlanLossTarget[] = [];
    for (const deviceId of missingDeviceIds) {
      const target = this.captureTarget(deviceId);
      if (!target) {
        this.pending.delete(deviceId);
        continue;
      }
      const reserved = await this.port.isShutdownReserved(deviceId);
      if (!reserved && this.isCurrent(target) && this.hasPlanWork(target)) {
        targets.push(target);
      } else {
        this.pending.delete(deviceId);
      }
    }
    return targets;
  }

  private async confirmTarget(
    target: PlanLossTarget,
    bootedDeviceIds: ReadonlySet<string>,
    discovery: BootedDeviceDiscovery,
    offlineDeviceIds: ReadonlySet<string>,
  ): Promise<void> {
    if (!this.isCurrent(target) || !this.hasPlanWork(target)) {
      this.pending.delete(target.device.id);
      return;
    }
    // Use the same missing-device observation classifier as non-plan liveness.
    // This base has no transport-alias presence contract yet (#10364).
    const observation = classifyMissingDeviceObservation(
      didSourceSucceedForDevice(discovery, target.device.platform, target.device.id),
      bootedDeviceIds.has(target.device.id),
    );
    if (observation !== "missing" || offlineDeviceIds.has(target.device.id)) {
      this.pending.delete(target.device.id);
      if (observation === "present") {
        this.reported.delete(target.device.id);
      }
      return;
    }
    // A physical USB phone does not leave a successful listing transiently,
    // so this sweep's cache-bypassing absence confirms it at once (#10493).
    if (!this.isImmediateLoss(target.device.id) && !this.isWindowElapsed(target)) {
      return;
    }
    const reserved = await this.port.isShutdownReserved(target.device.id);
    if (reserved || !this.isCurrent(target) || !this.hasPlanWork(target)) {
      this.pending.delete(target.device.id);
      return;
    }
    await this.reportLoss(target);
  }

  private isImmediateLoss(deviceId: string): boolean {
    return (
      isPhysicalAndroidUsbSerial(deviceId) && this.port.isTransportRestarting?.(deviceId) !== true
    );
  }

  private isWindowElapsed(target: PlanLossTarget): boolean {
    const pending = this.pending.get(target.device.id);
    if (!pending || !this.isCurrent(pending.target)) {
      this.pending.set(target.device.id, { target, absentSince: this.port.timer.now() });
      return false;
    }
    return this.port.timer.now() - pending.absentSince >= PLAN_DEVICE_LOSS_CONFIRMATION_WINDOW_MS;
  }

  private isCurrent(target: PlanLossTarget): boolean {
    const device = this.port.getDevice(target.device.id);
    return (
      device === target.device &&
      device.incarnation === target.incarnation &&
      device.assignmentCount === target.assignmentCount &&
      device.sessionId === target.sessionId &&
      this.port.getPlanSessionUuid(target.sessionId) === target.planSessionUuid
    );
  }

  private hasPlanWork(target: PlanLossTarget): boolean {
    return (
      target.device.status === "busy" &&
      !this.port.isStartupLeased(target.device.id) &&
      this.port.hasPlanExecution(target.device.id, target.planSessionUuid)
    );
  }

  private async reportLoss(target: PlanLossTarget): Promise<void> {
    const incidentId = await this.port.recordLoss(target.device.id);
    if (!this.isCurrent(target) || !this.hasPlanWork(target)) {
      await this.port.finishLoss(incidentId);
      return;
    }
    const reserved = await this.port.isShutdownReserved(target.device.id);
    if (reserved || !this.isCurrent(target) || !this.hasPlanWork(target)) {
      await this.port.finishLoss(incidentId);
      return;
    }
    // Mark before abort dispatch: listeners may synchronously end the plan.
    this.reported.set(target.device.id, target);
    this.pending.delete(target.device.id);
    await this.port.cancelPlan(
      target.device.id,
      target.planSessionUuid,
      deviceLossCancellationReason(target.device.id, incidentId),
    );
    // Settlement belongs to the captured incident even if cancellation replaced
    // the device. No pool/session action may follow this await on a stale target.
    if (!this.isCurrent(target)) {
      this.reported.delete(target.device.id);
    }
    await this.port.finishLoss(incidentId);
  }
}

export type CurrentDisconnectStatus = "current" | "recovered" | "unknown";
/**
 * Marker incarnation used when an intentional shutdown is recorded while no
 * pooled device is present (only an in-flight recovery). Such a marker applies
 * to whatever incarnation the recovery produces, matching the pre-existing
 * serial-scoped recovery-cancellation behavior (issue #4915).
 */
export const INCARNATION_ANY = -1;

type AndroidRediscoveryVerification = "rediscovered" | "not-rediscovered" | "unknown";

export interface DeviceDisconnectPoolPort {
  getPooledDevice(deviceId: string): PooledDevice | undefined;
  getIntentionalShutdownMarker(deviceId: string): number | undefined;
  deleteIntentionalShutdownMarker(deviceId: string): void;
  isReservedForShutdown(device: PooledDevice): boolean;
  removeDevice(
    deviceId: string,
    awaitCacheCleanup: boolean,
    expectedDevice?: PooledDevice,
  ): Promise<void>;
  finishEmulatorLossIncident(
    incidentId: string | undefined,
    outcome: "not-attempted",
  ): Promise<void>;
  recordEmulatorLossIncident(
    deviceId: string,
    detectionPath: EmulatorLossDetectionPath,
    processExit?: { code: number | null; signal: NodeJS.Signals | null },
    lastAdbState?: string,
  ): Promise<string | undefined>;
  shouldRebootDisconnectedAndroidDevice(device: PooledDevice): boolean;
  rebootDisconnectedAndroidDevice(device: PooledDevice, incidentId?: string): Promise<boolean>;
  settleEmulatorLossIncident(incidentId: string | undefined): void;
  suppressAutoStartForDevice(device: PooledDevice): void;
  completeEmulatorLossRecovery(
    incidentId: string | undefined,
    outcome: "not-attempted" | "exhausted",
  ): Promise<void>;
  refreshEmulatorLossRecoverySettlement(
    incidentId: string | undefined,
    fallbackOutcome: "exhausted" | "not-attempted",
  ): Promise<void>;
  getRecoveryPolicy(): DeviceRecoveryPolicy;
  isAndroidEmulatorActiveRelaunchEligible(
    device: PooledDevice,
  ): device is PooledDevice & { avdName: string; androidImage: DeviceInfo };
  getDeviceManager(): Pick<PlatformDeviceManager, "getBootedDevicesDetailed">;
  androidRediscoveryMatches(candidate: BootedDevice, deviceId: string, avdName: string): boolean;
}

/** Handles disconnect signals against live pool state and captured device incarnations. */
export class DeviceDisconnectHandler {
  constructor(private readonly pool: DeviceDisconnectPoolPort) {}

  /**
   * Apply any intentional-shutdown marker to a disconnect, gated on the device
   * incarnation. Returns `true` when the disconnect is fully handled here — the
   * marked device was removed, or the signal was stale and the live device kept —
   * and `false` when no marker applied and the caller should handle the
   * disconnect normally.
   */
  private async applyIntentionalShutdownOnDisconnect(
    deviceId: string,
    device: PooledDevice | undefined,
    mayBeStaleSignal: boolean,
    onRemovalAttempt: () => void,
  ): Promise<boolean> {
    const markerIncarnation = this.pool.getIntentionalShutdownMarker(deviceId);
    if (markerIncarnation === undefined) {
      return false;
    }
    const appliesToCurrent =
      !device || markerIncarnation === INCARNATION_ANY || markerIncarnation === device.incarnation;
    if (!appliesToCurrent) {
      // A different incarnation now holds this serial, so the mark belonged to a
      // device that is already gone. Drop the stale marker instead of removing
      // the live replacement (or suppressing its recovery), and let the caller
      // handle this disconnect on its own merits.
      this.pool.deleteIntentionalShutdownMarker(deviceId);
      return false;
    }
    if (
      mayBeStaleSignal &&
      device &&
      (await this.wasRebootedAndroidDeviceRediscovered(device)) !== "not-rediscovered"
    ) {
      // The intentionally-stopped serial is still (or again) booted, so this
      // disconnect is stale — keep the live device and the marker until a real
      // disconnect for this incarnation arrives.
      return true;
    }
    // Re-validate identity after the discovery await: a same-serial incarnation
    // may have replaced `device` while we awaited (removeDisconnectedDevice does
    // not hold assignmentMutex, cf. the sibling check below). Only the captured
    // incarnation — or an already-empty slot — may be consumed here; a fresh
    // replacement carries its own marker and disconnect lifecycle.
    const current = this.pool.getPooledDevice(deviceId);
    if (device && current && current !== device) {
      return true;
    }
    await this.consumeIntentionalShutdownAndRemove(deviceId, device, onRemovalAttempt);
    return true;
  }

  private async consumeIntentionalShutdownAndRemove(
    deviceId: string,
    device: PooledDevice | undefined,
    onRemovalAttempt: () => void,
  ): Promise<void> {
    if (device?.sessionId) {
      // removeDevice would refuse an assigned entry; keep the marker so it still
      // applies (and suppresses recovery) once the session releases (#6392).
      logger.warn(
        `[DevicePool] Retaining intentionally stopped device ${deviceId} until session ${device.sessionId} releases it`,
      );
      return;
    }
    this.pool.deleteIntentionalShutdownMarker(deviceId);
    onRemovalAttempt();
    await this.pool.removeDevice(deviceId, true, device);
  }

  private async shouldDeferDisconnectCleanup(
    deviceId: string,
    device: PooledDevice | undefined,
    mayBeStaleSignal: boolean,
    incidentId: string | undefined,
  ): Promise<boolean> {
    let fallbackOutcome: "exhausted" | "not-attempted" = "exhausted";
    try {
      if (device && this.pool.isReservedForShutdown(device)) {
        // killDevice owns this captured incarnation until its bounded disappearance
        // check retires it (or hands a replacement to the pool). A concurrent
        // monitor signal must not release its session or consume its marker.
        return true;
      }
      return await this.applyIntentionalShutdownOnDisconnect(
        deviceId,
        device,
        mayBeStaleSignal,
        () => {
          // Only intentional removal failures skip recovery; earlier pool checks may throw.
          fallbackOutcome = "not-attempted";
        },
      );
    } catch (error) {
      await this.refreshFailedDisconnectRecovery(deviceId, incidentId, error, fallbackOutcome);
      this.pool.settleEmulatorLossIncident(incidentId);
      throw error;
    }
  }

  async removeDisconnectedDevice(
    deviceId: string,
    mayBeStaleSignal: boolean = true,
    incidentId?: string,
    expectedDevice?: PooledDevice,
  ): Promise<void> {
    const device = this.pool.getPooledDevice(deviceId);
    if (!this.matchesExpectedDisconnectedDevice(device, expectedDevice)) {
      await this.pool.finishEmulatorLossIncident(incidentId, "not-attempted");
      return;
    }
    if (await this.shouldDeferDisconnectCleanup(deviceId, device, mayBeStaleSignal, incidentId)) {
      await this.pool.finishEmulatorLossIncident(incidentId, "not-attempted");
      return;
    }
    if (
      !this.matchesExpectedDisconnectedDevice(this.pool.getPooledDevice(deviceId), expectedDevice)
    ) {
      await this.pool.finishEmulatorLossIncident(incidentId, "not-attempted");
      return;
    }
    if (!device) {
      await this.pool.finishEmulatorLossIncident(incidentId, "not-attempted");
      return;
    }
    if (device.sessionId) {
      // removeDevice refuses assigned entries. A disconnect reaching here with
      // sessionId still set is a release deferred behind late session teardown
      // (releaseCapturedDevice); freeing the serial now could hand it out
      // mid-teardown. Retain it — the deferred release returns it to idle and
      // the next disconnect evaluation removes it (#6392).
      logger.warn(
        `[DevicePool] Retaining disconnected device ${deviceId} until session ${device.sessionId} teardown completes`,
      );
      await this.pool.finishEmulatorLossIncident(incidentId, "not-attempted");
      return;
    }
    const rediscovery = mayBeStaleSignal
      ? await this.wasRebootedAndroidDeviceRediscovered(device)
      : "not-rediscovered";
    if (!this.canContinueDisconnectCleanup(device, rediscovery)) {
      await this.pool.finishEmulatorLossIncident(incidentId, "not-attempted");
      return;
    }
    const recordedIncidentId =
      incidentId ??
      (await this.pool.recordEmulatorLossIncident(
        deviceId,
        "device-discovery-miss",
        undefined,
        "absent",
      ));
    await this.cleanUpDisconnectedDevice(device, recordedIncidentId);
  }

  private async cleanUpDisconnectedDevice(
    device: PooledDevice,
    incidentId: string | undefined,
  ): Promise<void> {
    try {
      const recoveryWasAttempted = this.pool.shouldRebootDisconnectedAndroidDevice(device);
      const recovered = await this.pool.rebootDisconnectedAndroidDevice(device, incidentId);
      if (recovered || this.hasReplacementDisconnectedDevice(device)) {
        await this.completeRecoveryIfNotAttempted(incidentId, recoveryWasAttempted);
        return;
      }
      this.pool.suppressAutoStartForDevice(device);
      await this.pool.removeDevice(device.id, true, device);
      await this.completeRecoveryIfNotAttempted(incidentId, recoveryWasAttempted);
    } catch (error) {
      // Plain reboot has no deferred incident owner; preserve any coordinator outcome.
      await this.refreshFailedDisconnectRecovery(device.id, incidentId, error, "exhausted");
      throw error;
    } finally {
      this.pool.settleEmulatorLossIncident(incidentId);
    }
  }

  private async refreshFailedDisconnectRecovery(
    deviceId: string,
    incidentId: string | undefined,
    error: unknown,
    fallbackOutcome: "exhausted" | "not-attempted",
  ): Promise<void> {
    try {
      await this.pool.refreshEmulatorLossRecoverySettlement(incidentId, fallbackOutcome);
    } catch (settlementError) {
      // Diagnostics persistence must not replace the original cleanup failure.
      logger.warn(
        `[DevicePool] Failed to refresh disconnect incident for ${deviceId}`,
        settlementError,
      );
    }
    logger.warn(`[DevicePool] Disconnect cleanup failed for ${deviceId}`, error);
  }

  private matchesExpectedDisconnectedDevice(
    device: PooledDevice | undefined,
    expectedDevice: PooledDevice | undefined,
  ): boolean {
    return expectedDevice === undefined || device === expectedDevice;
  }

  private canContinueDisconnectCleanup(
    device: PooledDevice,
    rediscovery: "rediscovered" | "not-rediscovered" | "unknown",
  ): boolean {
    return this.pool.getPooledDevice(device.id) === device && rediscovery === "not-rediscovered";
  }

  private hasReplacementDisconnectedDevice(device: PooledDevice): boolean {
    const current = this.pool.getPooledDevice(device.id);
    return current !== undefined && current !== device;
  }

  private async completeRecoveryIfNotAttempted(
    incidentId: string | undefined,
    recoveryWasAttempted: boolean,
  ): Promise<void> {
    if (!recoveryWasAttempted) {
      await this.pool.completeEmulatorLossRecovery(incidentId, "not-attempted");
    }
  }

  private async wasRebootedAndroidDeviceRediscovered(
    device: PooledDevice,
  ): Promise<AndroidRediscoveryVerification> {
    if (
      !this.pool.getRecoveryPolicy().onLoss ||
      !this.pool.isAndroidEmulatorActiveRelaunchEligible(device)
    ) {
      return "not-rediscovered";
    }
    const avdName = device.avdName;
    try {
      resetAdbDeviceListCache();
      resetBootedDevicesResourceCache();
      resetAndroidDeviceImageResourceCache();
      const discovery = await this.pool.getDeviceManager().getBootedDevicesDetailed("android");
      const observation = classifyMissingDeviceObservation(
        discovery.succeededPlatforms.has("android"),
        discovery.devices.some((candidate) =>
          this.pool.androidRediscoveryMatches(candidate, device.id, avdName),
        ),
      );
      if (observation === "source-unavailable") {
        logger.warn(
          `[DevicePool] Retained ${device.id}: Android discovery failed during stale-disconnect check`,
        );
        return "unknown";
      }
      // A stale-signal check is already downstream of the monitor's debounce.
      if (observation === "missing") {
        return "not-rediscovered";
      }
      logger.info(
        `[DevicePool] Retained ${device.id}: a rebooted Android emulator is present despite a stale disconnect signal`,
      );
      return "rediscovered";
    } catch (error) {
      logger.warn(
        `[DevicePool] Could not verify rebooted Android emulator ${device.id}: ${error}`,
        error,
      );
      return "unknown";
    }
  }

  async isCurrentDisconnectedDevice(device: PooledDevice): Promise<CurrentDisconnectStatus> {
    if (this.pool.getPooledDevice(device.id) !== device) {
      return "recovered";
    }
    const rediscovery = await this.wasRebootedAndroidDeviceRediscovered(device);
    if (this.pool.getPooledDevice(device.id) !== device) {
      return "recovered";
    }
    if (rediscovery === "unknown") {
      return "unknown";
    }
    return rediscovery === "rediscovered" ? "recovered" : "current";
  }
}
