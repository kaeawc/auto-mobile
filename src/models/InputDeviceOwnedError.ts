import { ActionableError } from "./ActionableError";

/**
 * Typed response `code` for an `input/*` frame refused because another live session holds the
 * target device (#10698). Clients match the code, never the message.
 */
export const DEVICE_OWNED_BY_OTHER_SESSION_CODE = "device_owned_by_other_session";

export const INPUT_REMEDY =
  "acquire the device (setActiveDevice) and send input with that session's sessionUuid.";

/** Remedy text for a refused device-mutating `tools/call` (see toolRegistry.ts). */
export const TOOL_CALL_REMEDY =
  "acquire the device (setActiveDevice) and call the tool with that session's sessionUuid, or wait for the holder to release it.";

/** Trailing options for `InputDeviceOwnedError`. */
export interface InputDeviceOwnedErrorOptions {
  /** Remedy appended to the composed message; defaults to `INPUT_REMEDY`. */
  remedy?: string;
  /** Replaces the composed message where a caller's existing wording must stay stable. */
  message?: string;
  /** Set only when the refusal ends without the caller or a holder doing anything. */
  retryAfterMs?: number;
}

/**
 * `input/*` drives a device directly, so it follows device ownership (#10698): a device a session
 * holds takes input only from that session. A frame names its session with the optional
 * `sessionUuid` param; a derived `${base}:${label}` session counts as its base, as it does for
 * stream authentication. Devices no session holds stay open to any local client, so a passive
 * viewer (or a desktop whose session was idle-released) can still drive an unowned device.
 */
export class InputDeviceOwnedError extends ActionableError {
  readonly code = DEVICE_OWNED_BY_OTHER_SESSION_CODE;
  /**
   * False when a session holds the device: the holder keeps it until it releases it, so the same
   * call cannot succeed as-is. True, with `retryAfterMs`, only for a device another request is
   * still preparing (#11651), held for bounded restart recovery (#11902), or whose
   * holder is already on its way out (#11920).
   */
  readonly retryable: boolean;
  declare readonly retryAfterMs?: number;

  constructor(
    action: string,
    readonly deviceId: string,
    requesterSessionUuid: string | undefined,
    options: InputDeviceOwnedErrorOptions = {},
  ) {
    const { remedy = INPUT_REMEDY, message, retryAfterMs } = options;
    super(
      message ??
        `${action} refused: device '${deviceId}' is held by another session. ` +
          (requesterSessionUuid
            ? `Session ${requesterSessionUuid} does not hold it; `
            : "The request carried no sessionUuid; ") +
          remedy,
    );
    this.name = "InputDeviceOwnedError";
    this.retryable = retryAfterMs !== undefined;
    if (retryAfterMs !== undefined) {
      this.retryAfterMs = retryAfterMs;
    }
  }

  /** The wire evidence: the held device, never the holder's session. */
  toPayload(): Record<string, unknown> {
    return {
      code: this.code,
      deviceId: this.deviceId,
      retryable: this.retryable,
      ...(this.retryAfterMs === undefined ? {} : { retryAfterMs: this.retryAfterMs }),
    };
  }
}
