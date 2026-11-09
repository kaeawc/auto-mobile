import { toActionableError } from "../../models/ActionableError";
import { errorMessage } from "../../models/describeUnknownError";
import type { AdbCommandRunner } from "../../utils/android-cmdline-tools/interfaces/AdbExecutor";
import { logger } from "../../utils/logger";
import type { Timer } from "../../utils/SystemTimer";
import { DEBUG_SURFACE_ACTION, parseBroadcastOutput, type ParsedBroadcast } from "./WearSurface";
import {
  parseWatchFaces,
  readWearServiceDumpsys,
  type ComplicationSlot,
  type WatchFaceObservation,
  type WearServiceAdb,
} from "./wearServiceDumpsys";

/**
 * Watch face and complication changes over DEBUG_SURFACE (#17520 classic faces, #17545 WFF).
 * `result=1` only means the receiver accepted the request: a provider that does not support the
 * requested type leaves the slot empty with the same reply, so a change is reported as applied
 * only once `dumpsys wear_service` shows it.
 */
export const WATCH_FACE_ACTIONS = [
  "setWatchFace",
  "unsetWatchFace",
  "setComplication",
  "unsetComplication",
] as const;
export type WatchFaceAction = (typeof WATCH_FACE_ACTIONS)[number];

/**
 * A bare package (`watchFaceId`, resource-only WFF faces) or `<package>/<class>` (classic
 * faces). No trailing slash, no shell metacharacters.
 */
export const WATCH_FACE_PATTERN = /^[A-Za-z][\w.]*(?:\/\.?[A-Za-z_][\w.]*)?$/;
/** The class name Wear OS stores for resource-only faces; the receiver refuses it as input. */
export const PLACEHOLDER_CLASS = "_placeholder_";

export const WATCH_FACE_ERRORS = [
  "face_not_installed",
  "slot_out_of_range",
  "invalid_face_id",
  "unsupported_face",
  "debug_surface_disabled",
  "watch_face_not_switched",
  "missing_argument",
  "not_applied",
  "unknown_reply",
] as const;
export type WatchFaceError = (typeof WATCH_FACE_ERRORS)[number];

export interface FaceBroadcast extends ParsedBroadcast {
  /** `result=1` with a `Favorite Id=[n]` reply: accepted, not yet applied. */
  accepted: boolean;
  favoriteId?: number;
  error?: WatchFaceError;
}

/** Refusals by their reply text, whatever the result code. */
const REPLY_ERRORS: ReadonlyArray<{ error: WatchFaceError; text: string }> = [
  { error: "face_not_installed", text: "Watch face package is not installed." },
  { error: "slot_out_of_range", text: "Complication slot is out of range." },
  { error: "invalid_face_id", text: "Class name cannot be a placeholder." },
  { error: "unsupported_face", text: "Fallback watch face does not support complications." },
  { error: "debug_surface_disabled", text: "Debug broadcast receiver is disabled." },
  { error: "watch_face_not_switched", text: "Switched watch face is not set." },
  { error: "missing_argument", text: " is required." },
  { error: "missing_argument", text: " are required." },
  { error: "missing_argument", text: "Both component name and watchface id are specified." },
];

const FAVORITE_REPLY = /Favorite Id=\[(\d+)\]/;

export function classifyFaceBroadcast(parsed: ParsedBroadcast): FaceBroadcast {
  const { data } = parsed;
  const refusal = REPLY_ERRORS.find((rule) => data?.includes(rule.text) === true);
  if (refusal) {
    return { ...parsed, accepted: false, error: refusal.error };
  }
  const favorite = data === undefined ? null : FAVORITE_REPLY.exec(data);
  if (parsed.code === 1 && favorite) {
    return { ...parsed, accepted: true, favoriteId: Number(favorite[1]) };
  }
  return { ...parsed, accepted: false, error: "unknown_reply" };
}

export interface ComplicationRequest {
  watchFace: string;
  slot: number;
  provider: string;
}

export interface SetComplicationRequest extends ComplicationRequest {
  /** androidx complication type int (SHORT_TEXT=3, RANGED_VALUE=5). */
  type: number;
}

export interface WatchFaceChangeResult {
  success: boolean;
  action: WatchFaceAction;
  requested: { watchFace?: string; slot?: number; type?: number; provider?: string };
  broadcastResult: FaceBroadcast;
  /** True only when a `dumpsys wear_service` readback showed the change. */
  applied: boolean;
  /** Mirrors `applied`: the readback is the verification. */
  verified: boolean;
  favoriteId?: number;
  /** The last readback, when one was taken. */
  readback?: WatchFaceObservation;
  error?: WatchFaceError;
  message: string;
  reason?: string;
}

export interface WatchFaceSurface {
  setWatchFace(watchFace: string, signal?: AbortSignal): Promise<WatchFaceChangeResult>;
  unsetWatchFace(signal?: AbortSignal): Promise<WatchFaceChangeResult>;
  setComplication(
    request: SetComplicationRequest,
    signal?: AbortSignal,
  ): Promise<WatchFaceChangeResult>;
  unsetComplication(
    request: ComplicationRequest,
    signal?: AbortSignal,
  ): Promise<WatchFaceChangeResult>;
}

export interface WatchFaceSurfaceDeps {
  adb: AdbCommandRunner & WearServiceAdb;
  timer: Timer;
}

/** A single readback took 0.4 s typically and 2.8 s at worst over 20 measured runs. */
export const READBACK_INTERVAL_MS = 500;
export const READBACK_ATTEMPTS = 10;
const COMMAND_TIMEOUT_MS = 10_000;

const ERROR_REASONS: Record<WatchFaceError, string> = {
  face_not_installed:
    "The watch face package is not installed. A resource-only (WFF) face takes its bare package; a classic face takes <package>/<class>.",
  slot_out_of_range:
    "The watch face has no complication slot with that id, or it is not the active face. Set the face first and read its slots from dumpsys wear_service.",
  invalid_face_id:
    "The watch face id was refused: pass a resource-only face as its bare package, never <package>/_placeholder_.",
  unsupported_face: "The fallback watch face has no complication slots; set another face first.",
  debug_surface_disabled:
    "The Wear OS debug broadcast receiver is disabled on this build; enable developer options (development_settings_enabled=1) and retry.",
  watch_face_not_switched:
    "No watch face was switched by setWatchFace, so there is nothing to unset.",
  missing_argument: "The broadcast was missing a required argument or had conflicting ones.",
  not_applied:
    "The broadcast was accepted but dumpsys wear_service did not show the change. For a complication, the provider may not support the requested type.",
  unknown_reply: "The broadcast reply was not recognized.",
};

type Check = (reading: WatchFaceObservation, reply: FaceBroadcast) => boolean;

interface Attempt {
  action: WatchFaceAction;
  requested: WatchFaceChangeResult["requested"];
  extras: string;
  check: Check;
  applied: string;
}

export class AdbWatchFaceSurface implements WatchFaceSurface {
  constructor(private readonly deps: WatchFaceSurfaceDeps) {}

  setWatchFace(watchFace: string, signal?: AbortSignal): Promise<WatchFaceChangeResult> {
    const face = splitFace(watchFace);
    return this.attempt(
      {
        action: "setWatchFace",
        requested: { watchFace },
        // set-watchface reads a classic face from `component`, a WFF face from `watchFaceId`.
        extras: face.className === undefined ? faceExtra(face) : `--ecn component ${watchFace}`,
        check: (reading, reply) => faceActive(reading, face) && favoriteActive(reading, reply),
        applied: `${watchFace} is the active watch face.`,
      },
      signal,
    );
  }

  unsetWatchFace(signal?: AbortSignal): Promise<WatchFaceChangeResult> {
    return this.attempt(
      {
        action: "unsetWatchFace",
        requested: {},
        extras: "",
        check: (reading, reply) =>
          reply.favoriteId !== undefined && reading.activeFace.favoriteId === reply.favoriteId,
        applied: "The watch face set before setWatchFace is active again.",
      },
      signal,
    );
  }

  setComplication(
    request: SetComplicationRequest,
    signal?: AbortSignal,
  ): Promise<WatchFaceChangeResult> {
    const { watchFace, slot, type, provider } = request;
    const expected = componentName(provider);
    return this.attempt(
      {
        action: "setComplication",
        requested: { watchFace, slot, type, provider },
        extras: `--ecn component ${provider} ${faceExtra(splitFace(watchFace))} --ei slot ${slot} --ei type ${type}`,
        check: slotCheck(slot, (line) => line.type === type && line.provider === expected),
        applied: `Slot ${slot} shows ${provider} with type ${type}.`,
      },
      signal,
    );
  }

  unsetComplication(
    request: ComplicationRequest,
    signal?: AbortSignal,
  ): Promise<WatchFaceChangeResult> {
    const { watchFace, slot, provider } = request;
    return this.attempt(
      {
        action: "unsetComplication",
        requested: { watchFace, slot, provider },
        extras: `--ecn component ${provider} ${faceExtra(splitFace(watchFace))} --ei slot ${slot}`,
        check: slotCheck(slot, (line) => line.provider === null),
        applied: `Slot ${slot} is empty.`,
      },
      signal,
    );
  }

  private async attempt(attempt: Attempt, signal?: AbortSignal): Promise<WatchFaceChangeResult> {
    const { action, requested } = attempt;
    const refused = refuseBeforeSend(requested.watchFace);
    if (refused) {
      return failure(attempt, refused, "The request was refused before sending.");
    }
    const reply = classifyFaceBroadcast(await this.broadcast(action, attempt.extras, signal));
    if (!reply.accepted) {
      return failure(attempt, reply, "The watch refused the change.");
    }
    const readback = await this.readBack(attempt.check, reply, signal);
    const applied = readback !== undefined && attempt.check(readback, reply);
    return {
      success: applied,
      action,
      requested,
      broadcastResult: reply,
      applied,
      verified: applied,
      ...(reply.favoriteId !== undefined ? { favoriteId: reply.favoriteId } : {}),
      ...(readback !== undefined ? { readback } : {}),
      ...(applied ? {} : { error: "not_applied" as const }),
      message: applied
        ? `${attempt.applied} Confirmed by dumpsys wear_service.`
        : "The broadcast was accepted, but dumpsys wear_service did not show the change.",
      ...(applied
        ? {}
        : {
            reason:
              readback === undefined
                ? "dumpsys wear_service could not be read to confirm the change."
                : ERROR_REASONS.not_applied,
          }),
    };
  }

  /** Polls until the check passes or the attempts run out; returns the last reading. */
  private async readBack(
    check: Check,
    reply: FaceBroadcast,
    signal?: AbortSignal,
  ): Promise<WatchFaceObservation | undefined> {
    let last: WatchFaceObservation | undefined;
    for (let attempt = 0; attempt < READBACK_ATTEMPTS; attempt++) {
      if (attempt > 0) {
        await this.deps.timer.sleep(READBACK_INTERVAL_MS);
      }
      signal?.throwIfAborted();
      last = (await this.read(signal)) ?? last;
      if (last !== undefined && check(last, reply)) {
        return last;
      }
    }
    return last;
  }

  /** An unreadable dumpsys, or one without an active face, cannot confirm a change. */
  private async read(signal?: AbortSignal): Promise<WatchFaceObservation | undefined> {
    try {
      return parseWatchFaces(await readWearServiceDumpsys(this.deps.adb, signal)) ?? undefined;
    } catch (error) {
      signal?.throwIfAborted();
      logger.warn(`dumpsys wear_service readback failed: ${errorMessage(error)}`, error);
      return undefined;
    }
  }

  private async broadcast(
    action: WatchFaceAction,
    extras: string,
    signal?: AbortSignal,
  ): Promise<ParsedBroadcast> {
    const command =
      `shell am broadcast -a ${DEBUG_SURFACE_ACTION} --es operation ${OPERATIONS[action]} ${extras}`.trimEnd();
    try {
      signal?.throwIfAborted();
      const result = await this.deps.adb.executeCommand(command, {
        timeoutMs: COMMAND_TIMEOUT_MS,
        noRetry: true,
        signal,
      });
      return parseBroadcastOutput(result.stdout);
    } catch (error) {
      throw toActionableError(error, `Failed to run adb ${command}`);
    }
  }
}

const OPERATIONS: Record<WatchFaceAction, string> = {
  setWatchFace: "set-watchface",
  unsetWatchFace: "unset-watchface",
  setComplication: "set-complication",
  unsetComplication: "unset-complication",
};

interface FaceName {
  package: string;
  className?: string;
}

function splitFace(watchFace: string): FaceName {
  const slash = watchFace.indexOf("/");
  return slash < 0
    ? { package: watchFace }
    : { package: watchFace.slice(0, slash), className: watchFace.slice(slash + 1) };
}

/** WFF faces go through the `watchFaceId` string extra; `--ecn watchface` is classic-only. */
function faceExtra(face: FaceName): string {
  return face.className === undefined
    ? `--es watchFaceId ${face.package}`
    : `--ecn watchface ${face.package}/${face.className}`;
}

/** Expands the `.Name` shorthand so it compares with dumpsys's `ComponentInfo{pkg/cls}`. */
export function componentName(component: string): string {
  const { package: pkg, className = "" } = splitFace(component);
  return `${pkg}/${className.startsWith(".") ? pkg + className : className}`;
}

/**
 * dumpsys names the active face by package only; the reply's favorite id (checked by
 * `favoriteActive`) is what pins a classic face's class.
 */
function faceActive(reading: WatchFaceObservation, face: FaceName): boolean {
  return reading.activeFace.package === face.package;
}

/** A reply's favorite must be the active one; a readback without the line cannot refute it. */
function favoriteActive(reading: WatchFaceObservation, reply: FaceBroadcast): boolean {
  const active = reading.activeFace.favoriteId;
  return active === null || active === reply.favoriteId;
}

/** The reply favorite's slot; parseWatchFaces makes the active favorite's slots the live ones. */
function slotCheck(slot: number, matches: (line: ComplicationSlot) => boolean): Check {
  return (reading, reply) =>
    favoriteActive(reading, reply) &&
    reading.favorites.some(
      (favorite) =>
        favorite.favoriteId === reply.favoriteId &&
        favorite.slots.some((line) => line.slot === slot && matches(line)),
    );
}

function refuseBeforeSend(watchFace: string | undefined): FaceBroadcast | undefined {
  if (watchFace !== undefined && splitFace(watchFace).className === PLACEHOLDER_CLASS) {
    return { code: null, accepted: false, error: "invalid_face_id" };
  }
  return undefined;
}

function failure(attempt: Attempt, reply: FaceBroadcast, message: string): WatchFaceChangeResult {
  const error = reply.error ?? "unknown_reply";
  return {
    success: false,
    action: attempt.action,
    requested: attempt.requested,
    broadcastResult: reply,
    applied: false,
    verified: false,
    error,
    message,
    reason:
      error === "unknown_reply" && reply.code !== null
        ? `Unexpected broadcast reply result=${reply.code}${reply.data !== undefined ? `, data="${reply.data}"` : ""}.`
        : error === "unknown_reply"
          ? "The broadcast printed no result; the debug receiver may be missing on this build."
          : ERROR_REASONS[error],
  };
}
