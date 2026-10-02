import { logger } from "../utils/logger";
import { errorMessage } from "../utils/describeUnknownError";

export interface StreamDeviceLifecycleEvents {
  onDeviceRemoved(callback: (deviceId: string) => void): () => void;
  /** Includes quarantine enter/lift and unrelated full frame invalidations; re-check admission. */
  onDeviceIdentityChanged(callback: (deviceId: string) => void): () => void;
}

/** Narrow process-local fanout; a failed consumer must not interrupt pool invalidation. */
export class StreamDeviceLifecycleEmitter implements StreamDeviceLifecycleEvents {
  private readonly removed = new Set<(deviceId: string) => void>();
  private readonly identityChanged = new Set<(deviceId: string) => void>();

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
  return (daemonEmitter ??= new StreamDeviceLifecycleEmitter());
}
