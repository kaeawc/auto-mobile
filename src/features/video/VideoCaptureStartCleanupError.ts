import type { RecordingHandle } from "./VideoRecorderService";

/**
 * A backend rejected startup but still owns a process that cleanup could not
 * reap. Retaining this handle lets shutdown or rollback retry force-stop.
 */
export class VideoCaptureStartCleanupError extends Error {
  constructor(
    message: string,
    readonly handle: RecordingHandle,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "VideoCaptureStartCleanupError";
  }
}
