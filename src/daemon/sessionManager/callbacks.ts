import { isDeviceRestartReleaseReason } from "../../db/deviceSessionRepository";
import type { DeviceSession } from "../../db/types";
import { SessionReleasedDuringCreationError } from "../../models/deviceAcquisitionRefusals";
import { MANAGED_EXECUTION_LIVENESS_POLICY } from "../../models/managedExecutionLiveness";
import { logger } from "../../utils/logger";
import {} from "../deviceStateRestoreQueue";
import {
  DeviceAcquisitionExecutionCanceller,
  Session,
  SessionCreatedCallback,
  SessionDeviceUnboundCallback,
  SessionReleaseCallback,
  SessionReleaseOptions,
  SessionReleaseSnapshot,
} from "../sessionManager";

export interface SessionCallbacksHost {
  readonly releaseCallbacks: SessionReleaseCallback[];
  readonly deviceOwnershipCallbacks: Set<
    (deviceId: string, frameInvalidation: "generation-only" | "full") => void
  >;
  armPendingDeviceCleanupCaps(deviceId: string): void;
  readonly createdCallbacks: SessionCreatedCallback[];
  readonly deviceUnboundCallbacks: SessionDeviceUnboundCallback[];
  readonly managedExecutionRecoveryListener:
    | ((sessionId: string, recovered: Promise<unknown>) => void)
    | undefined;
  readonly managedExecutionRecoveries: Map<string, PromiseWithResolvers<void>>;
  readonly restartReleasePersistence: WeakMap<SessionReleaseSnapshot, PromiseWithResolvers<void>>;
  readonly deferredAcquisitionCancellations: Map<string, string | undefined>;
  readonly deviceAcquisitionExecutionCanceller: DeviceAcquisitionExecutionCanceller;
}

export class SessionCallbacks {
  constructor(private readonly host: SessionCallbacksHost) {}

  /**
   * Register a callback to be invoked when a session is released.
   * Used for centralized cleanup of session-scoped state (e.g., NavigationGraphManager).
   */

  onSessionRelease(callback: SessionReleaseCallback): void {
    this.host.releaseCallbacks.push(callback);
  }

  /** Observe changes to the live device-owner map; returns a listener removal function. */

  onDeviceOwnershipChange(
    callback: (deviceId: string, frameInvalidation: "generation-only" | "full") => void,
  ): () => void {
    this.host.deviceOwnershipCallbacks.add(callback);
    return () => this.host.deviceOwnershipCallbacks.delete(callback);
  }

  notifyDeviceOwnershipChange(
    deviceId: string,
    frameInvalidation: "generation-only" | "full" = "generation-only",
  ): void {
    this.host.armPendingDeviceCleanupCaps(deviceId);
    for (const callback of this.host.deviceOwnershipCallbacks) {
      try {
        callback(deviceId, frameInvalidation);
      } catch (error) {
        logger.warn(`Device ownership callback failed for ${deviceId}: ${error}`);
      }
    }
  }

  /**
   * Register a callback invoked after a newly-created session is published.
   */

  onSessionCreated(callback: SessionCreatedCallback): void {
    this.host.createdCallbacks.push(callback);
  }

  /**
   * Register cleanup for a device a session stopped using without ending that
   * session. This intentionally excludes session-wide cleanup and transport
   * unbinding, which must remain attached to a real session release.
   */

  onSessionDeviceUnbound(callback: SessionDeviceUnboundCallback): void {
    this.host.deviceUnboundCallbacks.push(callback);
  }

  /** Recovery alone has a completion signal; ordinary creation adds no promise turn. */

  notifyManagedExecutionRecovery(
    session: Session,
    persistedRecovery: DeviceSession | undefined,
  ): (creation: Promise<Session>) => void {
    if (!persistedRecovery || session.livenessPolicy !== MANAGED_EXECUTION_LIVENESS_POLICY) {
      return () => {};
    }
    const { sessionId } = session;
    const recovered = Promise.withResolvers<void>();
    this.host.managedExecutionRecoveries.set(sessionId, recovered);
    // A listener may throw or be absent; creation failure must still be handled on this signal.
    void recovered.promise.catch((error: unknown) => {
      logger.debug(`[SessionManager] Managed recovery ${sessionId} did not complete`, error);
    });
    try {
      this.host.managedExecutionRecoveryListener?.(sessionId, recovered.promise);
    } catch (error) {
      logger.warn(`[SessionManager] Managed recovery hook failed for ${sessionId}`, error);
    }
    return (creation) => {
      void creation.then(undefined, recovered.reject);
    };
  }

  settleManagedExecutionRecovery(sessionId: string, completed: boolean): void {
    const recovered = this.host.managedExecutionRecoveries.get(sessionId);
    this.host.managedExecutionRecoveries.delete(sessionId);
    if (completed) {
      recovered?.resolve();
    } else {
      recovered?.reject(new SessionReleasedDuringCreationError(sessionId));
    }
  }

  notifySessionRelease(
    snapshot: SessionReleaseSnapshot,
    options: SessionReleaseOptions = {},
  ): void {
    if (isDeviceRestartReleaseReason(snapshot.releaseReason)) {
      const persistence =
        this.host.restartReleasePersistence.get(snapshot) ?? Promise.withResolvers<void>();
      this.host.restartReleasePersistence.set(snapshot, persistence);
      options = { ...options, releasePersisted: persistence.promise };
    }
    const notice = { ...options, snapshot };
    for (const callback of this.host.releaseCallbacks) {
      try {
        callback(snapshot.sessionId, snapshot.deviceId, snapshot.releaseReason, notice);
      } catch (error) {
        logger.warn(`Session release callback failed for ${snapshot.sessionId}: ${error}`);
      }
    }
  }

  notifySessionDeviceUnbound(
    sessionId: string,
    deviceId: string,
    options?: Pick<SessionReleaseOptions, "deviceIdentityReplaced">,
  ): void {
    for (const callback of this.host.deviceUnboundCallbacks) {
      try {
        callback(sessionId, deviceId, options);
      } catch (error) {
        logger.warn(`Session device-unbound callback failed for ${sessionId}: ${error}`);
      }
    }
  }

  notifySessionCreated(session: Session): void {
    for (const callback of this.host.createdCallbacks) {
      try {
        callback(session);
      } catch (error) {
        logger.warn(`Session creation callback failed for ${session.sessionId}: ${error}`);
      }
    }
  }

  /**
   * Hold the acquisition cancellation for `sessionId` until `settleDeviceAcquisitionCancellation`:
   * the pool publishes a session before deciding whether the create commits (#10905).
   */

  deferDeviceAcquisitionCancellation(sessionId: string): void {
    if (!this.host.deferredAcquisitionCancellations.has(sessionId)) {
      this.host.deferredAcquisitionCancellations.set(sessionId, undefined);
    }
  }

  /**
   * End a deferral: a committed create cancels the sessionless calls on the device it published; a
   * refused or rolled-back one cancels nothing, since the device ends up free (#10905).
   */

  settleDeviceAcquisitionCancellation(sessionId: string, committed: boolean): void {
    if (!this.host.deferredAcquisitionCancellations.has(sessionId)) {
      return;
    }
    const deviceId = this.host.deferredAcquisitionCancellations.get(sessionId);
    this.host.deferredAcquisitionCancellations.delete(sessionId);
    if (committed && deviceId !== undefined) {
      this.host.deviceAcquisitionExecutionCanceller(deviceId, sessionId);
    }
  }

  cancelSessionlessUseOnAcquisition(deviceId: string, sessionId: string): void {
    if (this.host.deferredAcquisitionCancellations.has(sessionId)) {
      this.host.deferredAcquisitionCancellations.set(sessionId, deviceId);
      return;
    }
    this.host.deviceAcquisitionExecutionCanceller(deviceId, sessionId);
  }
}
