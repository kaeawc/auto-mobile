import { logger } from "../../utils/logger";
import type { H264CaptureSource, H264CaptureSourceOptions } from "./H264CaptureSource";
import { CaptureEntry } from "./CaptureEntry";
import { CaptureHandle } from "./CaptureHandle";
import type { CaptureHintField } from "./captureHints";
import type { DeviceCaptureHandle, DeviceCaptureRequest } from "./deviceCaptureTypes";

export { captureHintsCompatible, type CaptureHintField } from "./captureHints";
export type { DeviceCaptureHandle, DeviceCaptureRequest } from "./deviceCaptureTypes";

/** A shared relay may retain a satisfying source; a sole holder must recreate as on main. */
export function canRetainSharedCapture(
  source: H264CaptureSource,
  requested: H264CaptureSourceOptions,
  flexible: readonly CaptureHintField[] = [],
): boolean {
  return (
    source instanceof CaptureHandle &&
    source.entry.handles.size > 1 &&
    source.entry.conflicts(requested, flexible, false).length === 0
  );
}
/** Preserve optional source capabilities while letting the relay retire a stale shared entry
 * even when the physical source implements only stop(). */
export function stopStaleCapture(
  source: H264CaptureSource,
  producerStale?: boolean,
): Promise<void> {
  return source instanceof CaptureHandle
    ? source.entry.release(source, { producerStale })
    : source.stopStale
      ? source.stopStale(producerStale)
      : source.stop();
}
/** Reference-counted compatible capture; incompatible requests get independent private entries.
 * Callback buffers are shared without copying: sinks MUST NOT mutate them.
 */
export interface DeviceCaptureRegistry {
  acquire(request: DeviceCaptureRequest): DeviceCaptureHandle;
}

class SharedDeviceCaptureRegistry implements DeviceCaptureRegistry {
  private readonly entries = new Map<string, CaptureEntry>();
  private readonly stopping = new Map<string, Set<CaptureEntry>>();
  acquire(request: DeviceCaptureRequest): DeviceCaptureHandle {
    const deviceId = request.device.deviceId;
    const existing = this.entries.get(deviceId);
    const privateEntry = existing ? !existing.canShare(request) : false;
    if (existing && !privateEntry) {
      return existing.add(request);
    }
    const entry = new CaptureEntry(request, (retired) => {
      if (this.entries.get(deviceId) === retired) {
        this.entries.delete(deviceId);
      }
      const stop = retired.stopPromise!;
      const pending = this.stopping.get(deviceId) ?? new Set<CaptureEntry>();
      pending.add(retired);
      this.stopping.set(deviceId, pending);
      const clear = () => {
        if (retired.stopPromise === stop) {
          pending.delete(retired);
          if (pending.size === 0) {
            this.stopping.delete(deviceId);
          }
        }
      };
      // The released handle retains failed-stop ownership; only in-flight attempts fence creation.
      void stop.then(clear, clear);
    });
    const handle = entry.add(request);
    if (!privateEntry) {
      this.entries.set(deviceId, entry);
    }
    const previousStop = this.stopping.get(deviceId);
    if (previousStop?.size) {
      const createAfterStop = () => {
        // A handle released while queued must not construct another encoder.
        if (entry.retired) {
          throw new Error("Capture released before creation");
        }
        entry.initialize();
        return entry.creation!;
      };
      const waitForStop = (retiring: CaptureEntry): Promise<void> => {
        const stop = retiring.stopPromise!;
        const afterStop = (): void | Promise<void> =>
          retiring.stopPromise !== stop ? waitForStop(retiring) : undefined;
        return stop.then(afterStop, afterStop);
      };
      entry.creation = Promise.all([...previousStop].map(waitForStop)).then(createAfterStop);
      void entry.creation.then(undefined, () => entry.creationFailed());
    } else {
      try {
        entry.initialize();
      } catch (error) {
        logger.warn(`[DeviceCapture] ${deviceId}: source creation failed`, error);
        if (this.entries.get(deviceId) === entry) {
          this.entries.delete(deviceId);
        }
        entry.retired = true;
        handle.active = false;
        entry.handles.clear();
        throw error;
      }
    }
    return handle;
  }
}
export function createDeviceCaptureRegistry(): DeviceCaptureRegistry {
  return new SharedDeviceCaptureRegistry();
}
let defaultRegistry: DeviceCaptureRegistry | undefined;
export function getDefaultDeviceCaptureRegistry(): DeviceCaptureRegistry {
  return (defaultRegistry ??= createDeviceCaptureRegistry());
}
