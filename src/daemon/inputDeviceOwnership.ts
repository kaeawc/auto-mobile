import { ActionableError } from "../models/ActionableError";
import {
  resolveToolSelectionBaseSessionUuid,
  type ToolSelectionSessionManager,
} from "../features/toolSelection/selectionSessionResolver";

/**
 * Typed response `code` for an `input/*` frame refused because another live session holds the
 * target device (#10698). Clients match the code, never the message.
 */
export const DEVICE_OWNED_BY_OTHER_SESSION_CODE = "device_owned_by_other_session";

const INPUT_REMEDY =
  "acquire the device (setActiveDevice) and send input with that session's sessionUuid.";

/** Remedy text for a refused device-mutating `tools/call` (see toolRegistry.ts). */
export const TOOL_CALL_REMEDY =
  "acquire the device (setActiveDevice) and call the tool with that session's sessionUuid, or wait for the holder to release it.";

/**
 * `input/*` drives a device directly, so it follows device ownership (#10698): a device a session
 * holds takes input only from that session. A frame names its session with the optional
 * `sessionUuid` param; a derived `${base}:${label}` session counts as its base, as it does for
 * stream authentication. Devices no session holds stay open to any local client, so a passive
 * viewer (or a desktop whose session was idle-released) can still drive an unowned device.
 */
export class InputDeviceOwnedError extends ActionableError {
  readonly code = DEVICE_OWNED_BY_OTHER_SESSION_CODE;

  constructor(
    action: string,
    readonly deviceId: string,
    requesterSessionUuid: string | undefined,
    remedy = INPUT_REMEDY,
    /** Replaces the composed message where a caller's existing wording must stay stable. */
    message?: string,
  ) {
    super(
      message ??
        `${action} refused: device '${deviceId}' is held by another session. ` +
          (requesterSessionUuid
            ? `Session ${requesterSessionUuid} does not hold it; `
            : "The request carried no sessionUuid; ") +
          remedy,
    );
    this.name = "InputDeviceOwnedError";
  }
}

/**
 * The `setActiveDevice`/pool-bind refusal for a device another live session holds, typed with
 * {@link DEVICE_OWNED_BY_OTHER_SESSION_CODE} (#10832). The message keeps its long-standing wording
 * so clients that still match the text keep working; new clients match the code.
 */
export function deviceAssignedToOtherSessionError(
  deviceId: string,
  holderSessionUuid: string,
  requesterSessionUuid: string | undefined,
): InputDeviceOwnedError {
  return new InputDeviceOwnedError(
    "setActiveDevice",
    deviceId,
    requesterSessionUuid,
    undefined,
    `Device '${deviceId}' is already assigned to session ${holderSessionUuid}`,
  );
}

/** Throws {@link InputDeviceOwnedError} unless the requester may drive the device. */
export function assertInputRequesterHoldsDevice(input: {
  action: string;
  deviceId: string;
  /** The session holding the device, or undefined when none does. */
  ownerSessionUuid: string | undefined;
  /** The `sessionUuid` the frame carried. */
  requesterSessionUuid: string | undefined;
  sessionManager: ToolSelectionSessionManager | undefined;
  /** How the refused caller can proceed; defaults to the `input/*` remedy. */
  remedy?: string;
}): void {
  const { ownerSessionUuid, requesterSessionUuid, sessionManager } = input;
  if (!ownerSessionUuid) {
    return;
  }
  const base = (uuid: string) => resolveToolSelectionBaseSessionUuid(uuid, sessionManager) ?? uuid;
  if (requesterSessionUuid && base(requesterSessionUuid) === base(ownerSessionUuid)) {
    return;
  }
  throw new InputDeviceOwnedError(input.action, input.deviceId, requesterSessionUuid, input.remedy);
}

/**
 * Read the optional `sessionUuid` an `input/*` frame names itself with. Absent means a sessionless
 * frame; anything but a non-empty string is a malformed request.
 */
export function parseInputRequesterSessionUuid(
  method: string,
  params: unknown,
): string | undefined {
  if (!params || typeof params !== "object" || Array.isArray(params)) {
    return undefined;
  }
  const value = (params as Record<string, unknown>).sessionUuid;
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${method} sessionUuid must be a non-empty string when provided`);
  }
  return value.trim();
}
