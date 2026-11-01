import type { BindingRegistrySchemaProbe } from "./sessionBroker/registry/bindingRegistryMigrations";
import { registerDefaultForeignAndroidSerialSource } from "../devices/foreignAndroidSerialResolver";
import type { ManagedExecutionReowner } from "./sessionBroker/provisioning/executionReowner";
import { setDeviceAdmissionGate } from "../utils/deviceAdmissionGate";
import type { ObserverSessionStore } from "./observerSessionRegistry";
import { BrokerConnectionScopes } from "./sessionBroker/connectionScope";
import type { SessionBrokerService } from "./sessionBroker/service";
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
  private unregisterForeignAndroidSerialSource: (() => void) | null = null;
  private observerSessionRegistry: ObserverSessionStore | null = null;
  private sessionManager: SessionManager | null = null;
  private devicePool: DevicePool | null = null;
  private deviceSessionRegistry: DeviceSessionRegistry | null = null;
  private unregisterSessionReadinessListener: (() => void) | null = null;
  private readonly brokerConnectionScopes = new BrokerConnectionScopes();
  private sessionBrokerService: SessionBrokerService | undefined;
  private sessionBrokerMode = false;
  private bindingRegistrySchemaProbe: BindingRegistrySchemaProbe | undefined;

  setBindingRegistrySchemaProbe(probe: BindingRegistrySchemaProbe | undefined): void {
    this.bindingRegistrySchemaProbe = probe;
  }

  getBindingRegistrySchemaProbe(): BindingRegistrySchemaProbe | undefined {
    return this.bindingRegistrySchemaProbe;
  }
  private brokerExecutionReowner: ManagedExecutionReowner | null = null;
  setBrokerExecutionReowner(reowner: ManagedExecutionReowner | null): void {
    this.brokerExecutionReowner = reowner;
  }
  getBrokerExecutionReowner(): ManagedExecutionReowner | undefined {
    return this.brokerExecutionReowner ?? undefined;
  }

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
    this.unregisterForeignAndroidSerialSource?.();
    this.devicePool = devicePool;
    this.unregisterForeignAndroidSerialSource = registerDefaultForeignAndroidSerialSource({
      foreignSerials: (serials, signal) =>
        this.devicePool?.foreignSerials(serials, signal) ?? Promise.resolve(new Set<string>()),
    });
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

  /** Socket sessions bound to broker bindings, confined to their binding devices (#11178). */
  getBrokerConnectionScopes(): BrokerConnectionScopes {
    return this.brokerConnectionScopes;
  }

  setSessionBrokerMode(enabled: boolean): void {
    this.sessionBrokerMode = enabled;
  }

  isSessionBrokerMode(): boolean {
    return this.sessionBrokerMode;
  }

  setSessionBrokerService(service: SessionBrokerService | undefined): void {
    this.sessionBrokerService = service;
  }

  getSessionBrokerService(): SessionBrokerService | undefined {
    return this.sessionBrokerService;
  }

  getObserverSessionRegistry(): ObserverSessionStore | undefined {
    return this.observerSessionRegistry ?? undefined;
  }

  /**
   * Get the SessionManager
   */
  /**
   * Test-only: install a partial SessionManager fake without a full `initialize`, returning the
   * previous one so the caller can restore it. Pass null to clear.
   */
  setSessionManagerForTesting(manager: Partial<SessionManager> | null): SessionManager | null {
    const previous = this.sessionManager;
    this.sessionManager = manager as SessionManager | null;
    return previous;
  }

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

  /** Retire only this daemon's registration; another daemon may already have replaced it. */
  retireForeignAndroidSerialSource(devicePool: DevicePool): void {
    if (this.devicePool === devicePool) {
      this.unregisterForeignAndroidSerialSource?.();
      this.unregisterForeignAndroidSerialSource = null;
    }
  }

  /** Reset state for testing or shutdown. */
  reset(): void {
    this.unregisterForeignAndroidSerialSource?.();
    this.unregisterForeignAndroidSerialSource = null;
    this.observerSessionRegistry?.dispose();
    this.observerSessionRegistry = null;
    this.brokerExecutionReowner = null;
    this.brokerConnectionScopes.clear();
    this.sessionBrokerService = undefined;
    this.bindingRegistrySchemaProbe = undefined;
    this.sessionBrokerMode = false;
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
