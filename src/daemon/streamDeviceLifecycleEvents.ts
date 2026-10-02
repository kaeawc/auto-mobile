import { registerDeviceIncarnationListener } from "../utils/deviceIncarnation";
import { logger } from "../utils/logger";
import { errorMessage } from "../utils/describeUnknownError";

export interface StreamDeviceLifecycleEvents {
  onDeviceRestored(callback: (deviceId: string) => void): () => void;
  onDeviceRemoved(callback: (deviceId: string) => void): () => void;
  /** Includes quarantine enter/lift and unrelated full frame invalidations; re-check admission. */
  onDeviceIdentityChanged(callback: (deviceId: string) => void): () => void;
}

/** Narrow process-local fanout; a failed consumer must not interrupt pool invalidation. */
export class StreamDeviceLifecycleEmitter implements StreamDeviceLifecycleEvents {
  private readonly restored = new Set<(deviceId: string) => void>();
  private readonly removed = new Set<(deviceId: string) => void>();
  private readonly identityChanged = new Set<(deviceId: string) => void>();

  onDeviceRestored(callback: (deviceId: string) => void): () => void {
    this.restored.add(callback);
    return () => {
      this.restored.delete(callback);
    };
  }
  onDeviceRemoved(callback: (deviceId: string) => void): () => void {
    this.removed.add(callback);
    return () => {
      this.removed.delete(callback);
    };
  }
  onDeviceIdentityChanged(callback: (deviceId: string) => void): () => void {
    this.identityChanged.add(callback);
    return () => {
      this.identityChanged.delete(callback);
    };
  }
  deviceRestored(deviceId: string): void {
    this.emit(this.restored, deviceId);
  }
  deviceRemoved(deviceId: string): void {
    this.emit(this.removed, deviceId);
  }
  deviceIdentityChanged(deviceId: string): void {
    this.emit(this.identityChanged, deviceId);
  }

  private emit(listeners: Set<(deviceId: string) => void>, deviceId: string): void {
    for (const listener of [...listeners]) {
      try {
        listener(deviceId);
      } catch (error) {
        logger.warn(
          `[StreamDeviceLifecycle] listener failed for ${deviceId}: ${errorMessage(error)}`,
          error,
        );
      }
    }
  }
}

let daemonEmitter: StreamDeviceLifecycleEmitter | null = null;
/** Resolve lazily, like daemonDeviceAdmissionGate; construction alone touches no daemon state. */
export function getDaemonStreamDeviceLifecycleEmitter(): StreamDeviceLifecycleEmitter {
  if (!daemonEmitter) {
    const emitter = new StreamDeviceLifecycleEmitter();
    daemonEmitter = emitter;
    // Relay start resolves this emitter before accepting subscribers. Retire the old
    // capture before load, then catch subscriptions attached during the restore.
    registerDeviceIncarnationListener({
      name: "stream-device-lifecycle",
      prepareForIncarnationChange: (deviceId) => emitter.deviceRestored(deviceId),
      onDeviceIncarnationChanged: (deviceId) => emitter.deviceRestored(deviceId),
    });
  }
  return daemonEmitter;
}
