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
  /** The holder keeps the device until it releases it; the same call cannot succeed as-is. */
  readonly retryable = false;

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

  /** The wire evidence: the held device, never the holder's session. */
  toPayload(): Record<string, unknown> {
    return { code: this.code, deviceId: this.deviceId, retryable: this.retryable };
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

/**
 * The autolock/pool-bind refusal for a device another session holds, typed so callers (e.g.
 * `provisionDevice`) can report a retryable `device_owned_by_other_session` rather than a generic
 * failure. The message keeps its long-standing wording.
 */
export function deviceAlreadyAssignedToAnotherSessionError(
  deviceId: string,
): InputDeviceOwnedError {
  return new InputDeviceOwnedError(
    "acquire",
    deviceId,
    undefined,
    undefined,
    `Device '${deviceId}' is already assigned to another session. ` +
      "Acquire a different device or wait for its owner to release it.",
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

/** The pool's managed-slot gate, optional so older daemon-state fakes keep compiling. */
export interface ManagedSlotInputGate {
  assertNotAssignedToManagedSlot?(input: {
    action: string;
    deviceId: string;
    platform: "android" | "ios";
    requesterSessionUuid?: string;
    maxAgeMs?: number;
  }): Promise<void>;
}

/**
 * How stale the managed-slot snapshot may be for a device-driving frame. Input is frequent, and a
 * slot assignment is a rare host-wide event, so frames share one registry read per second.
 */
export const MANAGED_SLOT_INPUT_SNAPSHOT_MAX_AGE_MS = 1_000;

/**
 * A device a managed slot holds takes input only from that slot's live execution (#11178), even
 * while idle: no session holds it, so the holder check above would otherwise let any local client
 * drive it. Refuses with `device_assigned_to_managed_slot`; `force` never overrides it.
 */
export async function assertInputNotOnForeignManagedSlotDevice(input: {
  action: string;
  deviceId: string;
  platform: "android" | "ios";
  requesterSessionUuid: string | undefined;
  sessionManager: ToolSelectionSessionManager | undefined;
  gate: ManagedSlotInputGate;
}): Promise<void> {
  const { requesterSessionUuid, sessionManager } = input;
  await input.gate.assertNotAssignedToManagedSlot?.({
    action: input.action,
    deviceId: input.deviceId,
    platform: input.platform,
    requesterSessionUuid: requesterSessionUuid
      ? (resolveToolSelectionBaseSessionUuid(requesterSessionUuid, sessionManager) ??
        requesterSessionUuid)
      : undefined,
    maxAgeMs: MANAGED_SLOT_INPUT_SNAPSHOT_MAX_AGE_MS,
  });
}
