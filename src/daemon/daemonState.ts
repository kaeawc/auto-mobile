import { setDeviceAdmissionGate } from "../utils/deviceAdmissionGate";
import type { ObserverSessionStore } from "./observerSessionRegistry";
import type { ManagedExecutionRelease } from "./managedSlots/managedExecutionRelease";
import { ManagedConnectionScopes } from "./managedSlots/managedConnectionScope";
import type { SlotScopeReset } from "./managedSlots/slotScopeReset";
import type { ManagedSlotAcquisition } from "./managedSlots/managedSlotAcquisition";
import { SessionManager } from "./sessionManager";
import { DevicePool } from "./devicePool";
import { DeviceSessionRegistry } from "./deviceSessionRegistry";
import {
  registerDeviceIncarnationListener,
  setDeviceIncarnationBumper,
  setDeviceIncarnationResolver,
} from "../utils/deviceIncarnation";

export interface DaemonStateLike {
  isInitialized(): boolean;
  getSessionManager(): SessionManager;
  getDevicePool(): DevicePool;
  getDeviceSessionRegistry(): DeviceSessionRegistry;
}

/**
 * Singleton for accessing daemon state
 *
 * Provides access to SessionManager and DevicePool instances
 * for both the daemon process and internal command handlers.
 */
export class DaemonState implements DaemonStateLike {
  private static instance: DaemonState;
  private observerSessionRegistry: ObserverSessionStore | null = null;
  private sessionManager: SessionManager | null = null;
  private devicePool: DevicePool | null = null;
  private deviceSessionRegistry: DeviceSessionRegistry | null = null;
  private unregisterSessionReadinessListener: (() => void) | null = null;
  private managedExecutionRelease: ManagedExecutionRelease | null = null;
  private slotScopeReset: SlotScopeReset | null = null;
  private readonly managedConnectionScopes = new ManagedConnectionScopes();
  private managedSlotAcquisition: ManagedSlotAcquisition | null = null;

  private constructor() {}

  /**
   * Get the singleton instance
   */
  static getInstance(): DaemonState {
    if (!DaemonState.instance) {
      DaemonState.instance = new DaemonState();
    }
    return DaemonState.instance;
  }

  /**
   * Initialize daemon state
   * Called by Daemon after creating SessionManager and DevicePool
   */
  initialize(
    sessionManager: SessionManager,
    devicePool: DevicePool,
    // Production MUST pass the daemon's lifecycle-wired registry (the same
    // instance mint/retire mutate). The default exists only so the ~30 test
    // callers that don't exercise device sessions need not construct one; a
    // production caller relying on it would get an empty registry that no device
    // lifecycle ever populates.
    deviceSessionRegistry: DeviceSessionRegistry = new DeviceSessionRegistry(),
    observerSessionRegistry?: ObserverSessionStore,
  ): void {
    this.sessionManager = sessionManager;
    this.observerSessionRegistry = observerSessionRegistry ?? null;
    if (observerSessionRegistry) {
      sessionManager.setObserverSessionRegistry(observerSessionRegistry);
    }
    this.devicePool = devicePool;
    this.deviceSessionRegistry = deviceSessionRegistry;
    setDeviceAdmissionGate(devicePool);
    // The pool's incarnation counter is the only connection-epoch token in the
    // identity model, and feature code caching per-device state must be able to
    // read it without importing the daemon. Publish it here, where the live
    // pool is known.
    setDeviceIncarnationResolver((deviceId) => devicePool.getDeviceIncarnation(deviceId));
    this.unregisterSessionReadinessListener?.();
    this.unregisterSessionReadinessListener = registerDeviceIncarnationListener({
      name: "session-readiness",
      onDeviceIncarnationChanged: (deviceId) =>
        sessionManager.resetDeviceReadinessForDevice(deviceId),
    });
    setDeviceIncarnationBumper((deviceId) => {
      if (!devicePool.bumpDeviceIncarnation(deviceId)) {
        return false;
      }
      const device = devicePool.getDevice(deviceId);
      // Restore does not establish a connection that readiness never registered.
      if (!device || !deviceSessionRegistry.getByDeviceId(deviceId)) {
        return {};
      }
      const record = deviceSessionRegistry.onDeviceConnected({
        deviceId,
        platform: device.platform,
        incarnation: device.incarnation,
        retireReason: "superseded-by-restore",
      });
      return { deviceSessionUuid: record.deviceSessionUuid };
    });
  }

  /** Publish the managed-slot execution drain behind `daemon/releaseExecution` (#11177). */
  setManagedExecutionRelease(release: ManagedExecutionRelease | null): void {
    this.managedExecutionRelease = release;
  }

  getManagedExecutionRelease(): ManagedExecutionRelease | undefined {
    return this.managedExecutionRelease ?? undefined;
  }

  /** Publish the managed slot scope reset behind `daemon/resetSlotScope` (#11174). */
  setSlotScopeReset(reset: SlotScopeReset | null): void {
    this.slotScopeReset = reset;
  }

  getSlotScopeReset(): SlotScopeReset | undefined {
    return this.slotScopeReset ?? undefined;
  }

  /** Socket sessions bound to managed slots, confined to their slot devices (#11178). */
  getManagedConnectionScopes(): ManagedConnectionScopes {
    return this.managedConnectionScopes;
  }

  /** Publish the managed-slot acquisition behind `daemon/acquireManagedSlots` (#11173). */
  setManagedSlotAcquisition(acquisition: ManagedSlotAcquisition | null): void {
    this.managedSlotAcquisition = acquisition;
  }

  getManagedSlotAcquisition(): ManagedSlotAcquisition | undefined {
    return this.managedSlotAcquisition ?? undefined;
  }

  getObserverSessionRegistry(): ObserverSessionStore | undefined {
    return this.observerSessionRegistry ?? undefined;
  }

  /**
   * Get the SessionManager
   */
  getSessionManager(): SessionManager {
    if (!this.sessionManager) {
      throw new Error("DaemonState not initialized");
    }
    return this.sessionManager;
  }

  /**
   * Get the DevicePool
   */
  getDevicePool(): DevicePool {
    if (!this.devicePool) {
      throw new Error("DaemonState not initialized");
    }
    return this.devicePool;
  }

  /**
   * Get the DeviceSessionRegistry
   */
  getDeviceSessionRegistry(): DeviceSessionRegistry {
    if (!this.deviceSessionRegistry) {
      throw new Error("DaemonState not initialized");
    }
    return this.deviceSessionRegistry;
  }

  /**
   * Check if daemon state is initialized
   */
  isInitialized(): boolean {
    return (
      this.sessionManager !== null &&
      this.devicePool !== null &&
      this.deviceSessionRegistry !== null
    );
  }

  /**
   * Reset state (for testing or shutdown)
   */
  reset(): void {
    this.observerSessionRegistry?.dispose();
    this.observerSessionRegistry = null;
    this.managedExecutionRelease = null;
    this.slotScopeReset = null;
    this.managedConnectionScopes.clear();
    this.managedSlotAcquisition = null;
    this.sessionManager = null;
    this.devicePool = null;
    setDeviceAdmissionGate(undefined);
    this.deviceSessionRegistry = null;
    this.unregisterSessionReadinessListener?.();
    this.unregisterSessionReadinessListener = null;
    // The resolver {@link initialize} installed closes over the pool being
    // retired here. Leaving it registered would keep that pool alive and keep
    // answering direct-mode feature code with its epochs, so a per-device cache
    // could hold state across the reset. Clearing it restores the no-daemon
    // answer ("no epoch information") until the next initialize.
    setDeviceIncarnationResolver(undefined);
    setDeviceIncarnationBumper(undefined);
  }
}
