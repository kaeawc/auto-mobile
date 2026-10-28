import { refreshAllocationBindingExclusion } from "../sessionBroker/provisioning/exclusion";
import { holderOf } from "../deviceBinding";
import { type ForeignDeviceOwnership } from "../foreignDeviceOwnership";
import { type Session, type SessionRecoveryTarget } from "../sessionManager";
import { ActionableError, Platform } from "../../models";
import {
  SessionRecoveryAssignmentError,
  formatSessionRecoveryIncidentContext,
} from "../../models/SessionRecoveryAssignmentError";
import { type BootedDeviceDiscovery } from "../../devices/deviceUtils";
import { BootedDeviceDiscoveryIncompleteError } from "../../devices/deviceBootService";
import { adbOfflineHeldDevices, transitionalHeldSimulators } from "../adbOfflineHeldDevices";
import {
  expectingPooledSources,
  incompleteDiscoverySources,
  isDeviceSourceIncomplete,
  type DiscoveryCompleteness,
} from "../../utils/discoverySource";
import { getAbortSignal } from "../../utils/AbortContext";
import { type EmulatorLossIncident } from "../emulatorLossIncident";
import type { DevicePoolOperations } from "./operations";
import type { DevicePoolState } from "./state";

export interface AssignmentOperations {
  assignDeviceToSession(
    sessionId: string,
    platform?: Platform,
    recoveryTarget?: SessionRecoveryTarget,
  ): Promise<string>;
  recoveryNow(): number;
  recoveryAssignmentError(
    sessionId: string,
    target: SessionRecoveryTarget,
    incident?: EmulatorLossIncident,
  ): ActionableError;
  tryAssignDevice(
    sessionId: string,
    platform?: Platform,
    recoveryTarget?: SessionRecoveryTarget,
    settledRecoveryLoss?: boolean,
  ): Promise<{
    success: boolean;
    deviceId?: string;
    session?: Session;
    shouldWait: boolean;
    totalDevices: number;
    livenessUnknown?: boolean;
    refreshCompleteness?: DiscoveryCompleteness;
    refreshFailure?: string;
    refreshCompleted?: boolean;
  }>;
  tryAssignUnownedDevice(
    sessionId: string,
    platform?: Platform,
  ): ReturnType<DevicePoolOperations["tryAssignDevice"]>;
  publishDeviceClaim(deviceId: string): Promise<boolean>;
  releaseDeviceClaim(deviceId: string): void;
  foreignOwnershipFor(platform: Platform | undefined): ForeignDeviceOwnership | undefined;
  tracksForeignOwnership(platform?: Platform): boolean;
  /**
   * An explicit bind (startDevice, setActiveDevice, getAndroid/getApple with a deviceId) of a
   * device this daemon does not already hold is refused while another live daemon claims it
   * (#10980, owner decision 2026-10-09): two daemons must never drive the same device. Lifecycle
   * tools that stop a device (killDevice, deleteDevice) apply the same check (#11200).
   *
   * Sessionless control (#11349) is frequent, so it passes `maxAgeMs`: calls within that window
   * share one read of the device's ownership, and so at most one relinquish request to its peer,
   * instead of a status query and a relinquish round trip each. A bind always reads afresh.
   */
  // Not `async`: wrapping the delegate's promise in an async function adds microtask hops that
  // fake-time settle helpers (readToolsExplicitDeviceIdRule) count; return it directly.
  assertNotClaimedByForeignDaemon(
    deviceId: string,
    platform: Platform,
    remedy?: string,
    maxAgeMs?: number,
  ): Promise<void>;
  readForeignClaim(
    ownership: ForeignDeviceOwnership,
    deviceId: string,
  ): Promise<{
    ownerPid: number | undefined;
    unreadable: boolean;
  }>;
  /**
   * Withdraw every allocation claim this daemon still holds. Daemon stop calls this after its
   * sessions are released; a crashed daemon's claims lapse through the owner-socket check.
   */
  releaseDeviceClaimsForShutdown(): void;
  refreshInventoryOwnership(): Promise<void>;
  getRefreshedStats(): Promise<ReturnType<DevicePoolOperations["getStats"]>>;
  getRefreshedInventory(): Promise<{
    stats: ReturnType<DevicePoolOperations["getStats"]>;
    deviceIds: ReadonlySet<string>;
  }>;
  readLiveInventoryDeviceIds(signal?: AbortSignal): Promise<Set<string>>;
  readInventoryDiscovery(platform: Platform, signal?: AbortSignal): Promise<BootedDeviceDiscovery>;
  assertEmptyInventoryIsKnown(
    read: ReadonlyMap<Platform, BootedDeviceDiscovery>,
    signal?: AbortSignal,
  ): Promise<void>;
  refreshForeignOwnership(requireCurrent?: boolean): Promise<void>;
  countForeignDrivenDevices(platform?: Platform): number;
}
type AssignmentState = Pick<
  DevicePoolState,
  | "deviceAllocation"
  | "sessionManager"
  | "connectionOwnership"
  | "foreignClaims"
  | "deviceReservations"
  | "deviceManager"
  | "foreignDeviceOwnership"
  | "iosForeignDeviceOwnership"
  | "bindingExclusion"
>;
export type AssignmentCallbacks = Pick<
  DevicePoolOperations,
  | "getRefreshedInventory"
  | "refreshInventoryOwnership"
  | "getStats"
  | "getDevicesByPlatform"
  | "mapAndroidDiscovery"
  | "getAssignedDevices"
  | "getAllDevices"
>;

/** Assignment responsibilities of DevicePool. */
export class DevicePoolAssignment {
  constructor(
    private readonly state: AssignmentState,
    private readonly callbacks: AssignmentCallbacks,
  ) {}
  assignDeviceToSession(
    sessionId: string,
    platform?: Platform,
    recoveryTarget?: SessionRecoveryTarget,
  ): Promise<string> {
    return this.state.deviceAllocation.assignDeviceToSession(
      sessionId,
      platform,
      recoveryTarget,
      getAbortSignal(),
    );
  }

  /**
   * "Now" for comparing against a recovery target's restart deadline, which derives from session
   * stamps (`released_at_ms`, `expires_at_ms`) on the session clock (#11105).
   */
  recoveryNow(): number {
    return this.state.sessionManager.sessionNow();
  }

  recoveryAssignmentError(
    sessionId: string,
    target: SessionRecoveryTarget,
    incident?: EmulatorLossIncident,
  ): ActionableError {
    const now = this.recoveryNow();
    if (target.restartRecoveryDeadlineMs !== undefined && now < target.restartRecoveryDeadlineMs) {
      return new SessionRecoveryAssignmentError({
        sessionUuid: sessionId,
        platform: target.platform,
        deviceId: target.deviceId,
        stableDeviceId: target.stableDeviceId,
        ...(incident
          ? {
              incidentId: incident.id,
              detectionPath: incident.detectionPath,
              ...(incident.processExit ? { processExit: { ...incident.processExit } } : {}),
              recoveryOutcome: incident.recovery.outcome,
            }
          : {}),
        recoveryWindowRemainingMs: target.restartRecoveryDeadlineMs - now,
      });
    }
    const context = formatSessionRecoveryIncidentContext(
      incident
        ? {
            incidentId: incident.id,
            detectionPath: incident.detectionPath,
            processExit: incident.processExit,
            recoveryOutcome: incident.recovery.outcome,
          }
        : {},
    );
    return new ActionableError(
      `Cannot safely recover session ${sessionId}: ${target.platform} device ` +
        `'${target.stableDeviceId}' is unavailable or already in use. ` +
        "Acquire a new device with getAndroid or getApple. " +
        context,
    );
  }

  tryAssignDevice(
    sessionId: string,
    platform?: Platform,
    recoveryTarget?: SessionRecoveryTarget,
    settledRecoveryLoss = false,
  ): Promise<{
    success: boolean;
    deviceId?: string;
    session?: Session;
    shouldWait: boolean;
    totalDevices: number;
    livenessUnknown?: boolean;
    refreshCompleteness?: DiscoveryCompleteness;
    refreshFailure?: string;
    refreshCompleted?: boolean;
  }> {
    return this.state.deviceAllocation.tryAssignDevice(
      sessionId,
      platform,
      recoveryTarget,
      settledRecoveryLoss,
      getAbortSignal(),
    );
  }

  tryAssignUnownedDevice(
    sessionId: string,
    platform?: Platform,
  ): ReturnType<DevicePoolOperations["tryAssignDevice"]> {
    return this.state.deviceAllocation.tryAssignUnownedDevice(
      sessionId,
      platform,
      getAbortSignal(),
    );
  }

  /**
   * Publish this daemon's claim on an Android device a session holds. False only when another
   * live daemon's claim on it is still in use. A claim that lands after the session already let
   * the device go, with no other session holding it, is withdrawn again, so it never outlives the
   * assignment.
   */
  async publishDeviceClaim(deviceId: string): Promise<boolean> {
    return this.state.connectionOwnership.publishDeviceClaim(deviceId);
  }

  /** Withdraw this daemon's claim once no session of this daemon holds the device. */
  releaseDeviceClaim(deviceId: string): void {
    this.state.connectionOwnership.releaseDeviceClaim(deviceId);
  }

  /** Who else drives devices of `platform`: Android by adb server, iOS by UDID (#10980). */
  foreignOwnershipFor(platform: Platform | undefined): ForeignDeviceOwnership | undefined {
    return this.state.foreignClaims.foreignOwnershipFor(platform);
  }

  /** Whether allocation for `platform` (either, when unset) must honour other daemons' claims. */
  tracksForeignOwnership(platform?: Platform): boolean {
    return this.state.foreignClaims.tracksForeignOwnership(platform);
  }

  /**
   * An explicit bind (startDevice, setActiveDevice, getAndroid/getApple with a deviceId) of a
   * device this daemon does not already hold is refused while another live daemon claims it
   * (#10980, owner decision 2026-10-09): two daemons must never drive the same device. Lifecycle
   * tools that stop a device (killDevice, deleteDevice) apply the same check (#11200).
   *
   * Sessionless control (#11349) is frequent, so it passes `maxAgeMs`: calls within that window
   * share one read of the device's ownership, and so at most one relinquish request to its peer,
   * instead of a status query and a relinquish round trip each. A bind always reads afresh.
   */
  // Not `async`: wrapping the delegate's promise in an async function adds microtask hops that
  // fake-time settle helpers (readToolsExplicitDeviceIdRule) count; return it directly.
  assertNotClaimedByForeignDaemon(
    deviceId: string,
    platform: Platform,
    remedy?: string,
    maxAgeMs = 0,
  ): Promise<void> {
    return this.state.foreignClaims.assertNotClaimedByForeignDaemon(
      deviceId,
      platform,
      remedy,
      maxAgeMs,
    );
  }

  /** Who else holds `deviceId` right now, after asking an idle lease-only peer to let go. */
  async readForeignClaim(
    ownership: ForeignDeviceOwnership,
    deviceId: string,
  ): Promise<{
    ownerPid: number | undefined;
    unreadable: boolean;
  }> {
    return this.state.foreignClaims.readForeignClaim(ownership, deviceId);
  }

  /**
   * Withdraw every allocation claim this daemon still holds. Daemon stop calls this after its
   * sessions are released; a crashed daemon's claims lapse through the owner-socket check.
   */
  releaseDeviceClaimsForShutdown(): void {
    this.state.deviceReservations.releaseForShutdown();
    this.state.connectionOwnership.releaseAll();
  }

  /**
   * Re-read the ownership facts {@link genericAvailability} and {@link getStats} depend on: the
   * broker binding snapshot and which idle devices other daemons drive. Every inventory surface calls
   * this before reading availability so none answers from a stale or never-loaded snapshot. Throws
   * {@link BindingDiscoveryIncompleteError} when the binding registry is unreadable and no snapshot
   * was ever loaded: callers must not report such devices as free.
   */
  async refreshInventoryOwnership(): Promise<void> {
    await this.refreshForeignOwnership(false);
  }

  /** {@link getStats} after {@link refreshInventoryOwnership}: what `availableDevices` surfaces report. */
  async getRefreshedStats(): Promise<ReturnType<DevicePoolOperations["getStats"]>> {
    return (await this.callbacks.getRefreshedInventory()).stats;
  }

  /**
   * {@link getRefreshedStats} plus the live pooled device ids it counted, so a surface that also
   * lists devices lists exactly the ones the counts cover.
   */
  async getRefreshedInventory(): Promise<{
    stats: ReturnType<DevicePoolOperations["getStats"]>;
    deviceIds: ReadonlySet<string>;
  }> {
    await this.callbacks.refreshInventoryOwnership();
    const deviceIds = await this.readLiveInventoryDeviceIds();
    return { stats: this.callbacks.getStats(deviceIds), deviceIds };
  }

  /**
   * The pooled device ids the booted-devices resource and listDevices would list: what discovery
   * reports now plus held Android devices adb still lists offline and held simulators `simctl` lists
   * Booting / Shutting Down (#11573). A pooled entry outside this set
   * is a phantom (shut down since the last refresh) and must not be counted (#11568). Only
   * platforms with pooled entries are read, through the manager's own discovery path (adb's
   * device-list cache applies), so a stats read adds one listing per such platform and no
   * unbounded per-device call. An incomplete
   * listing throws {@link BootedDeviceDiscoveryIncompleteError}: the count is unknown, never the
   * stale pool tally and never zero. A source whose tooling is not installed on this host is not
   * incomplete (#11605) -- unless a pooled device depends on it, which proves the tooling existed.
   */
  async readLiveInventoryDeviceIds(signal = getAbortSignal()): Promise<Set<string>> {
    const live = new Set<string>();
    const read = new Map<Platform, BootedDeviceDiscovery>();
    for (const platform of ["android", "ios"] as const) {
      if (this.callbacks.getDevicesByPlatform(platform).length === 0) {
        continue;
      }
      const discovery = await this.readInventoryDiscovery(platform, signal);
      read.set(platform, discovery);
      // Only a pooled device whose own discovery source failed is unknown; a failure of a source
      // none of them depends on (devicectl for a simulator-only pool) leaves the answer exact.
      const unknown = this.callbacks
        .getDevicesByPlatform(platform)
        .some((pooled) => isDeviceSourceIncomplete(discovery, platform, pooled.id));
      if (unknown) {
        throw new BootedDeviceDiscoveryIncompleteError(
          platform,
          discovery.discoveryErrors?.[platform],
        );
      }
      const devices =
        platform === "android"
          ? this.callbacks.mapAndroidDiscovery(discovery.devices)
          : discovery.devices;
      for (const device of devices) {
        live.add(device.deviceId);
      }
      const offlineHeld = await adbOfflineHeldDevices({
        platform,
        discovered: devices,
        devicePool: this.callbacks,
        deviceManager: this.state.deviceManager,
        signal,
        // A held device discovery misses and the probe cannot place is unknown, never zero.
        onProbeFailure: "throw",
      });
      for (const held of offlineHeld) {
        live.add(held.device.deviceId);
      }
      for (const held of transitionalHeldSimulators({
        transitional: discovery.transitionalSimulators,
        discovered: devices,
        devicePool: this.callbacks,
      })) {
        live.add(held.device.deviceId);
      }
    }
    if (live.size === 0) {
      await this.assertEmptyInventoryIsKnown(read, signal);
    }
    return live;
  }

  async readInventoryDiscovery(
    platform: Platform,
    signal = getAbortSignal(),
  ): Promise<BootedDeviceDiscovery> {
    return expectingPooledSources(
      await this.state.deviceManager.getBootedDevicesDetailed(platform, {
        signal,
      }),
      this.callbacks.getAllDevices(),
    );
  }

  /**
   * "No devices" is only an answer when every source that exists on this host completed, as on
   * the booted-devices resource. With nothing live to count, a platform the caller skipped (no
   * pooled entries) may be empty because its discovery failed, so read it: a failed source makes
   * the count unknown, a source that is not installed leaves it a true zero (#11605).
   */
  async assertEmptyInventoryIsKnown(
    read: ReadonlyMap<Platform, BootedDeviceDiscovery>,
    signal = getAbortSignal(),
  ): Promise<void> {
    for (const platform of ["android", "ios"] as const) {
      const discovery = read.get(platform) ?? (await this.readInventoryDiscovery(platform, signal));
      if (incompleteDiscoverySources(discovery, [platform]).length > 0) {
        throw new BootedDeviceDiscoveryIncompleteError(
          platform,
          discovery.discoveryErrors?.[platform] ?? discovery.sourceErrors?.["ios-physical"],
        );
      }
    }
  }

  /** Re-read which idle Android devices other daemons drive, for this allocation pass. */
  async refreshForeignOwnership(requireCurrent = true): Promise<void> {
    const idle = (platform: Platform) =>
      this.callbacks
        .getDevicesByPlatform(platform)
        .filter((device) => holderOf(device) === null)
        .map((device) => device.id);
    await Promise.all([
      this.state.foreignDeviceOwnership?.refresh(idle("android")),
      this.state.iosForeignDeviceOwnership?.refresh(idle("ios")),
      this.state.bindingExclusion
        ? requireCurrent
          ? refreshAllocationBindingExclusion(this.state.bindingExclusion)
          : this.state.bindingExclusion.refresh()
        : undefined,
    ]);
  }

  countForeignDrivenDevices(platform?: Platform): number {
    return this.state.foreignClaims.countForeignDrivenDevices(platform);
  }
}

export function connectAssignment(
  part: () => DevicePoolAssignment,
  seams: Pick<
    DevicePoolOperations,
    | "assignDeviceToSession"
    | "releaseDeviceClaim"
    | "assertNotClaimedByForeignDaemon"
    | "releaseDeviceClaimsForShutdown"
    | "refreshInventoryOwnership"
    | "getRefreshedStats"
    | "getRefreshedInventory"
  >,
): AssignmentOperations {
  return {
    assignDeviceToSession: (...args) => seams.assignDeviceToSession(...args),
    recoveryNow: (...args) => part().recoveryNow(...args),
    recoveryAssignmentError: (...args) => part().recoveryAssignmentError(...args),
    tryAssignDevice: (...args) => part().tryAssignDevice(...args),
    tryAssignUnownedDevice: (...args) => part().tryAssignUnownedDevice(...args),
    publishDeviceClaim: (...args) => part().publishDeviceClaim(...args),
    releaseDeviceClaim: (...args) => seams.releaseDeviceClaim(...args),
    foreignOwnershipFor: (...args) => part().foreignOwnershipFor(...args),
    tracksForeignOwnership: (...args) => part().tracksForeignOwnership(...args),
    assertNotClaimedByForeignDaemon: (...args) => seams.assertNotClaimedByForeignDaemon(...args),
    readForeignClaim: (...args) => part().readForeignClaim(...args),
    releaseDeviceClaimsForShutdown: (...args) => seams.releaseDeviceClaimsForShutdown(...args),
    refreshInventoryOwnership: (...args) => seams.refreshInventoryOwnership(...args),
    getRefreshedStats: (...args) => seams.getRefreshedStats(...args),
    getRefreshedInventory: (...args) => seams.getRefreshedInventory(...args),
    readLiveInventoryDeviceIds: (...args) => part().readLiveInventoryDeviceIds(...args),
    readInventoryDiscovery: (...args) => part().readInventoryDiscovery(...args),
    assertEmptyInventoryIsKnown: (...args) => part().assertEmptyInventoryIsKnown(...args),
    refreshForeignOwnership: (...args) => part().refreshForeignOwnership(...args),
    countForeignDrivenDevices: (...args) => part().countForeignDrivenDevices(...args),
  };
}
