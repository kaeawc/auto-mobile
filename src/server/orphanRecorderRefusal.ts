import { ActionableError } from "../models/ActionableError";

export class OrphanRecorderActiveError extends ActionableError {
  readonly code = "orphan_recorder_active";
  readonly retryable = true;
  constructor(
    readonly deviceId: string,
    readonly recordingIds: readonly string[],
    cause?: unknown,
  ) {
    super(
      `A recorder from before the daemon restart is still running on device '${deviceId}' and could not be stopped. Retry or stop it by id (${recordingIds.join(", ")}).`,
      { cause },
    );
    this.name = "OrphanRecorderActiveError";
  }
  toPayload(): Record<string, unknown> {
    return {
      code: this.code,
      message: this.message,
      retryable: this.retryable,
      deviceId: this.deviceId,
      recordingIds: this.recordingIds,
    };
  }
}
