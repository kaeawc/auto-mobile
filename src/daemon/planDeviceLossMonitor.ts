import { isBusy, holderOf } from "./deviceBinding";
import type { BootedDeviceDiscovery } from "../devices/deviceUtils";
import type { PooledDevice } from "./devicePool";
import { classifyMissingDeviceObservation } from "./missingDeviceLiveness";
import { didSourceSucceedForDevice, discoverySourceFor } from "../utils/discoverySource";
import { isPhysicalAndroidUsbSerial } from "../utils/androidSerial";
import { deviceLossCancellationReason } from "../utils/deviceLossCancellationReason";
import type { Timer } from "../utils/SystemTimer";
import { logger } from "../utils/logger";

/** Confirm on a later plan tick, beyond the 1–3s adb root/unroot restart window. */
export const PLAN_DEVICE_LOSS_CONFIRMATION_WINDOW_MS = 5_000;

interface PlanLossTarget {
  device: PooledDevice;
  incarnation: number;
  assignmentCount: number;
  sessionId: string;
  planSessionUuid: string;
  executionIds: readonly string[];
}

export interface PlanDeviceLossPort {
  timer: Pick<Timer, "now">;
  /** AutoMobile is restarting this serial's adbd; keep the confirmation window (#10493). */
  isTransportRestarting?(deviceId: string): boolean;
  getDevice(deviceId: string): PooledDevice | null;
  getPlanSessionUuid(sessionId: string): string;
  hasPlanExecution(deviceId: string, planSessionUuid: string): boolean;
  getPlanExecutionIds(deviceId: string, planSessionUuid: string): readonly string[];
  isStartupLeased(deviceId: string): boolean;
  isShutdownReserved(deviceId: string): Promise<boolean>;
  discover(platform: "android" | "ios" | "either"): Promise<BootedDeviceDiscovery>;
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
    await this.confirmTargets(targets);
  }

  private async confirmTargets(targets: readonly PlanLossTarget[]): Promise<void> {
    const androidIds = targets
      .filter(({ device }) => device.platform === "android")
      .map(({ device }) => device.id);
    const platform =
      androidIds.length === targets.length ? "android" : androidIds.length === 0 ? "ios" : "either";
    // Booted discovery omits ADB-offline rows. The independent Android probe
    // distinguishes an absent serial from an attached but offline transport.
    let discovery: BootedDeviceDiscovery;
    let offlineDeviceIds: ReadonlySet<string> | undefined;
    try {
      [discovery, offlineDeviceIds] = await Promise.all([
        this.port.discover(platform),
        this.readOfflineEvidence(androidIds),
      ]);
    } catch (error) {
      this.pending.clear();
      throw error;
    }
    const confirmedBootedIds = new Set(discovery.devices.map((device) => device.deviceId));
    const adbReset = androidIds.length > 0 && this.port.isAdbReset(confirmedBootedIds, discovery);
    for (const target of targets) {
      if (target.device.platform === "android" && (adbReset || !offlineDeviceIds)) {
        this.pending.delete(target.device.id);
        continue;
      }
      await this.confirmTarget(
        target,
        confirmedBootedIds,
        discovery,
        offlineDeviceIds ?? new Set(),
      );
    }
  }

  private async readOfflineEvidence(
    androidIds: readonly string[],
  ): Promise<ReadonlySet<string> | undefined> {
    if (androidIds.length === 0) {
      return new Set();
    }
    try {
      return await this.port.getOfflineDeviceIds(androidIds);
    } catch (error) {
      // Failed ADB evidence breaks Android confirmation, not simctl evidence.
      logger.warn("[DisconnectMonitor] Plan-time Android offline probe failed", error);
      return undefined;
    }
  }

  private captureTarget(deviceId: string): PlanLossTarget | undefined {
    const device = this.port.getDevice(deviceId);
    // Allocation/restart owns startup-leased and shutdown-reserved devices. The global
    // plan lease alone is not evidence that a plan has begun using this device.
    if (
      !device ||
      discoverySourceFor(device.platform, device.id) === "ios-physical" ||
      !isBusy(device) ||
      !holderOf(device)
    ) {
      return undefined;
    }
    const planSessionUuid = this.port.getPlanSessionUuid(holderOf(device)!);
    const target: PlanLossTarget = {
      device,
      incarnation: device.incarnation,
      assignmentCount: device.assignmentCount,
      sessionId: holderOf(device)!,
      planSessionUuid,
      executionIds: this.port.getPlanExecutionIds(deviceId, planSessionUuid),
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
    if (!this.isImmediateLoss(target.device) && !this.isWindowElapsed(target)) {
      return;
    }
    const reserved = await this.port.isShutdownReserved(target.device.id);
    if (reserved || !this.isCurrent(target) || !this.hasPlanWork(target)) {
      this.pending.delete(target.device.id);
      return;
    }
    await this.reportLoss(target);
  }

  private isImmediateLoss(device: PooledDevice): boolean {
    return (
      device.platform === "android" &&
      isPhysicalAndroidUsbSerial(device.id) &&
      this.port.isTransportRestarting?.(device.id) !== true
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
    const executionIds = this.port.getPlanExecutionIds(target.device.id, target.planSessionUuid);
    return (
      device === target.device &&
      device.incarnation === target.incarnation &&
      device.assignmentCount === target.assignmentCount &&
      holderOf(device) === target.sessionId &&
      this.port.getPlanSessionUuid(target.sessionId) === target.planSessionUuid &&
      executionIds.length === target.executionIds.length &&
      target.executionIds.every((id) => executionIds.includes(id))
    );
  }

  private hasPlanWork(target: PlanLossTarget): boolean {
    return (
      isBusy(target.device) &&
      !this.port.isStartupLeased(target.device.id) &&
      this.port.hasPlanExecution(target.device.id, target.planSessionUuid)
    );
  }

  private async reportLoss(target: PlanLossTarget): Promise<void> {
    const incidentId = await this.port.recordLoss(target.device.id);
    try {
      if (!this.isCurrent(target) || !this.hasPlanWork(target)) {
        return;
      }
      const reserved = await this.port.isShutdownReserved(target.device.id);
      if (reserved || !this.isCurrent(target) || !this.hasPlanWork(target)) {
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
    } finally {
      // Settlement belongs to the captured incident even if cancellation throws
      // or replaces the device; no stale pool/session action follows the await.
      if (!this.isCurrent(target)) {
        this.reported.delete(target.device.id);
      }
      await this.port.finishLoss(incidentId);
    }
  }
}
