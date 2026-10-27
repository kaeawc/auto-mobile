import { ActionableError } from "../models/ActionableError";
import { DEVICE_OUTSIDE_BOUND_SESSION_CODE } from "./DeviceOutsideBoundSessionError";

/** A pinned connection cannot control a different session until its binding is released. */
export class SessionOutsideBoundSessionError extends ActionableError {
  readonly code = DEVICE_OUTSIDE_BOUND_SESSION_CODE;
  readonly retryable = false;

  constructor(
    readonly boundSessionUuid: string,
    readonly requestedSessionUuid: string,
    message?: string,
  ) {
    super(
      message ??
        `MCP connection is bound to device session ${boundSessionUuid}; ` +
          `cannot route this call to ${requestedSessionUuid} until the binding is released.`,
    );
    this.name = "SessionOutsideBoundSessionError";
  }

  toPayload(): Record<string, unknown> {
    return {
      code: this.code,
      boundSessionUuid: this.boundSessionUuid,
      requestedSessionUuid: this.requestedSessionUuid,
      retryable: false,
    };
  }
}
