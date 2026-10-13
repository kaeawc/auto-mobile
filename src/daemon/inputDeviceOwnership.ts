import { ActionableError } from "../models/ActionableError";
import type { SessionAccess, SessionExecutionMetadata } from "./sessionManager";
import { SessionNoLongerOwnsDeviceError } from "./sessionNoLongerOwnsDevice";
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
    remedy = INPUT_REMEDY,
    /** Replaces the composed message where a caller's existing wording must stay stable. */
    message?: string,
    /** Set only when the refusal ends without the caller or a holder doing anything. */
    retryAfterMs?: number,
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

/** Retry hint for a device another request is preparing: a poll interval, not a bound. */
export const DEVICE_PREPARED_FOR_OTHER_REQUEST_RETRY_AFTER_MS = 2_000;

/**
 * The refusal for selecting a device another request booted or picked and is still preparing: it
 * holds a readiness reservation and has not bound a session yet (#11651, owner decision
 * 2026-10-11). No session holds the device, so the message names none. Unlike a held device this
 * ends by itself, when that request binds (the held-device rules apply from then on) or fails
 * (the device is free), so this one emission is retryable with a hint. The reservation lasts as
 * long as that request's preparation and its cleanup, which nothing else bounds.
 */
export function devicePreparedForOtherRequestError(deviceId: string): InputDeviceOwnedError {
  const retryAfterMs = DEVICE_PREPARED_FOR_OTHER_REQUEST_RETRY_AFTER_MS;
  return new InputDeviceOwnedError(
    "setActiveDevice",
    deviceId,
    undefined,
    undefined,
    `Device '${deviceId}' is being prepared for another request, which has not bound it to a ` +
      `session yet. Retry in about ${retryAfterMs}ms, once that request has bound the device or ` +
      "failed, or use another device.",
    retryAfterMs,
  );
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

/** The pool read is optional so older daemon-state and autolock fakes keep their contracts. */
interface HolderReleaseQuery {
  holderReleaseRemainingMs(sessionId: string): number | undefined;
}

function readsHolderRelease(pool: object): pool is HolderReleaseQuery {
  return typeof Reflect.get(pool, "holderReleaseRemainingMs") === "function";
}

/** Preserve each bind/select refusal's wording, adding a hint only for a hold ending by itself. */
export function heldDeviceBindRefusal(
  pool: object | undefined,
  deviceId: string,
  holderSessionUuid: string | undefined,
  requesterSessionUuid?: string,
  wording: "assigned" | "another" = "assigned",
): InputDeviceOwnedError {
  const original =
    wording === "another"
      ? deviceAlreadyAssignedToAnotherSessionError(deviceId)
      : deviceAssignedToOtherSessionError(deviceId, holderSessionUuid!, requesterSessionUuid);
  const retryAfterMs =
    pool && holderSessionUuid && readsHolderRelease(pool)
      ? pool.holderReleaseRemainingMs(holderSessionUuid)
      : undefined;
  if (retryAfterMs === undefined) {
    return original;
  }
  return new InputDeviceOwnedError(
    "acquire",
    deviceId,
    requesterSessionUuid,
    undefined,
    `${original.message}${original.message.endsWith(".") ? "" : "."} The holder is being released; retry in about ${retryAfterMs}ms.`,
    retryAfterMs,
  );
}

/** Keep held-device wording while explaining the bounded restart-recovery refusal. */
export function deviceReservedForRestartRecoveryError(
  deviceId: string,
  holderSessionUuid: string,
  retryAfterMs: number,
): InputDeviceOwnedError {
  return new InputDeviceOwnedError(
    "acquire",
    deviceId,
    undefined,
    undefined,
    `Device '${deviceId}' is already assigned to session ${holderSessionUuid}; ` +
      `it is reserved for that session's device-restart recovery. Retry in ${retryAfterMs}ms, ` +
      "or acquire another device.",
    retryAfterMs,
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

/** True when the requester is the holder, a derived `${base}:${label}` session counting as its base. */
export function isSameHolderSession(
  ownerSessionUuid: string,
  requesterSessionUuid: string | undefined,
  sessionManager: ToolSelectionSessionManager | undefined,
): boolean {
  if (!requesterSessionUuid) {
    return false;
  }
  const base = (uuid: string) => resolveToolSelectionBaseSessionUuid(uuid, sessionManager) ?? uuid;
  return base(requesterSessionUuid) === base(ownerSessionUuid);
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
  if (isSameHolderSession(ownerSessionUuid, requesterSessionUuid, sessionManager)) {
    return;
  }
  throw new InputDeviceOwnedError(input.action, input.deviceId, requesterSessionUuid, input.remedy);
}

/**
 * The session manager's control-call admission, the entry point the MCP tool path uses. Read
 * structurally so daemon-state fakes that model no session lifecycle keep working.
 */
interface InputSessionAdmission {
  admitIssuedSessionForAutomation(
    sessionId: string,
    execution?: SessionExecutionMetadata,
    options?: { access?: SessionAccess },
  ): Promise<{ assignedDevice: string } | undefined>;
}

function admitsIssuedSessions<T extends object>(manager: T): manager is T & InputSessionAdmission {
  return typeof Reflect.get(manager, "admitIssuedSessionForAutomation") === "function";
}

/**
 * `input/*` on a held device is a control call on the holder's session (#11417), so it passes the
 * admission an MCP control call passes before anything reaches the device: a suspect session
 * refuses it (retryable), and a session whose owner lease and grace ran out, or whose idle window
 * closed, is released and refuses it terminally (`session_ownership_lost`). `execution` is the
 * input's own tracked execution, so it is not mistaken for earlier work still in flight.
 *
 * The pane is not the session's owner, so admission is `non-owner-control`: it changes nothing on
 * the session. It does not reclaim a rehydrated session awaiting its owner (that session is still
 * released at the owner-reconnect timeout, which cuts an input in flight with the typed refusal),
 * and it stamps neither the owner lease nor the activity clocks. The input's END is tool use, as
 * it was before admission existed: the tracker reports it and the idle window restarts there.
 */
export async function admitInputOnHolderSession(input: {
  deviceId: string;
  holderSessionUuid: string;
  sessionManager: object | undefined;
  execution: SessionExecutionMetadata;
}): Promise<void> {
  const { sessionManager, holderSessionUuid, deviceId } = input;
  if (!sessionManager || !admitsIssuedSessions(sessionManager)) {
    return;
  }
  const admitted = await sessionManager.admitIssuedSessionForAutomation(
    holderSessionUuid,
    input.execution,
    { access: "non-owner-control" },
  );
  if (admitted?.assignedDevice !== deviceId) {
    // Typed session_no_longer_owns_device (#11351): clients branch on the code, not this wording.
    throw new SessionNoLongerOwnsDeviceError(
      holderSessionUuid,
      deviceId,
      `Session ${holderSessionUuid} no longer holds device '${deviceId}'; the input was not sent.`,
    );
  }
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

/** The pool's cross-daemon claim check, optional so older daemon-state fakes keep compiling. */
export interface ForeignDaemonClaimGate {
  assertNotClaimedByForeignDaemon?(
    deviceId: string,
    platform: "android" | "ios",
    remedy?: string,
    maxAgeMs?: number,
  ): Promise<void>;
}

/**
 * How stale the foreign-claim read may be for a sessionless control call. Like
 * {@link MANAGED_SLOT_INPUT_SNAPSHOT_MAX_AGE_MS}: such calls are frequent and each fresh read may
 * cost a status query and a relinquish round trip to a peer daemon, so calls share one per second.
 */
export const FOREIGN_DAEMON_CLAIM_SNAPSHOT_MAX_AGE_MS = 1_000;

/**
 * Control on a device no session of this daemon holds is refused with the typed
 * `device_owned_by_other_daemon` while another live daemon claims it (#11349): two daemons must
 * never drive the same device. The pool skips the check for a device a local session holds, whose
 * access the holder check governs. Reads are never passed here; watching stays open.
 */
export async function assertControlNotOnForeignDaemonDevice(input: {
  deviceId: string;
  platform: "android" | "ios";
  gate: ForeignDaemonClaimGate;
  remedy?: string;
}): Promise<void> {
  await input.gate.assertNotClaimedByForeignDaemon?.(
    input.deviceId,
    input.platform,
    input.remedy,
    FOREIGN_DAEMON_CLAIM_SNAPSHOT_MAX_AGE_MS,
  );
}
