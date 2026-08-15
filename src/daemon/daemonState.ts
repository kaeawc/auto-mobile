import { SessionManager } from "./sessionManager";
import { DevicePool } from "./devicePool";
import { DeviceSessionRegistry } from "./deviceSessionRegistry";

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
  private sessionManager: SessionManager | null = null;
  private devicePool: DevicePool | null = null;
  private deviceSessionRegistry: DeviceSessionRegistry | null = null;

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
    deviceSessionRegistry: DeviceSessionRegistry = new DeviceSessionRegistry()
  ): void {
    this.sessionManager = sessionManager;
    this.devicePool = devicePool;
    this.deviceSessionRegistry = deviceSessionRegistry;
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
    this.sessionManager = null;
    this.devicePool = null;
    this.deviceSessionRegistry = null;
  }
}
