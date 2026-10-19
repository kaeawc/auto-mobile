import { ActionableError } from "../../models";

/**
 * A backend can prove that its capture process exited while still failing to
 * finalize its artifact.  This is deliberately distinct from an ordinary
 * stop error: callers may release the capture owner only when that proof is
 * explicit.
 */
export class VideoCaptureFinalizationError extends ActionableError {
  /**
   * `true` means the backend left a recoverable device artifact behind. The
   * service must retain its handle so a later stop can retry finalization.
   */
  readonly retainOwnership: boolean;
  /** A recoverable raw file which terminal cleanup must preserve. */
  readonly retainedCapturePath?: string;

  constructor(
    message: string,
    options?: ErrorOptions & { retainOwnership?: boolean; retainedCapturePath?: string },
  ) {
    super(message, options);
    this.name = "VideoCaptureFinalizationError";
    this.retainOwnership = options?.retainOwnership ?? false;
    this.retainedCapturePath = options?.retainedCapturePath;
  }
}
