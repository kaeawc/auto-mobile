import { DaemonUnavailableError } from "./DaemonUnavailableError";
import {
  DAEMON_LIVENESS_OWNER_CONFLICT_CODE,
  DaemonRequest,
  DaemonResponse,
  daemonInstanceFromError,
  releasedSessionNotFoundFields,
  sanitizeBoundSessionLoss,
  sanitizeDaemonRequestFailureCause,
} from "./types";
import { isDaemonHandshakeFailure } from "./daemonHandshake";
import { DaemonHandshakeMismatchError } from "./DaemonHandshakeMismatchError";
import { isDaemonShuttingDownFailure } from "./daemonShutdownOutcome";
import { DaemonShuttingDownError } from "./DaemonShuttingDownError";
import { sanitizeMcpOverloadFailure } from "./McpTimeoutError";
import { McpOverloadError } from "./McpOverloadError";
import { DaemonBoundSessionLostError } from "./DaemonBoundSessionLostError";
import {
  DeviceControlTransportError,
  sanitizeDeviceControlTransportFailure,
} from "./deviceControlTransportFailure";
import { ActionableError } from "../models";
import { z } from "zod";
import type { LivenessOwnerHold } from "./livenessOwnerLease";
import { isRelayedJsonRpcError, type TaskRelayFrame } from "../server/tasks/taskRelay";

/**
 * Normalize a socket-level transport failure into a `DaemonUnavailableError`.
 *
 * When a daemon restart/crash tears down the connection, an in-flight request's
 * socket emits a raw transport error (`ECONNRESET` / `EPIPE` / "socket hang up")
 * with no daemon-level meaning. Surfacing that raw error verbatim wedges every
 * other connected session (#2599): the proxy only treats `DaemonUnavailableError`
 * and the daemon's own `Session not found` as recoverable, so a raw `ECONNRESET`
 * is not retried (#2737). Typing it here — at the layer that knows it is a socket
 * failure — keeps the recoverability signal in one place: the proxy reconnects via
 * its existing `instanceof DaemonUnavailableError` branch, and a *daemon-returned*
 * application error that merely mentions a transport code (e.g. a tool reporting a
 * downstream `connect ECONNREFUSED`) stays an `ActionableError` and is correctly
 * not retried. Already-typed `DaemonUnavailableError`s pass through unchanged.
 */
export function toDaemonTransportError(error: Error): DaemonUnavailableError {
  if (error instanceof DaemonUnavailableError) {
    return error;
  }
  return new DaemonUnavailableError(`Daemon socket connection lost: ${error.message}`, {
    cause: error,
  });
}

function daemonLifecycleResponseError(response: DaemonResponse): Error | undefined {
  if (isDaemonHandshakeFailure(response.handshakeFailure)) {
    return new DaemonHandshakeMismatchError(
      response.handshakeFailure,
      response.error || "Daemon identity mismatch",
    );
  }
  if (isDaemonShuttingDownFailure(response.daemonShuttingDown)) {
    return new DaemonShuttingDownError(
      response.daemonShuttingDown.requestMayHaveDispatched === true,
    );
  }
  const overloadFailure = sanitizeMcpOverloadFailure(response.overloadFailure);
  if (overloadFailure) {
    return new McpOverloadError(
      response.error || "Daemon rejected overloaded MCP work",
      overloadFailure,
    );
  }
  return undefined;
}

function daemonSessionResponseError(response: DaemonResponse): Error | undefined {
  const boundSessionLoss = sanitizeBoundSessionLoss(response.boundSessionLoss);
  if (boundSessionLoss) {
    return new DaemonBoundSessionLostError(boundSessionLoss);
  }
  const transportFailure = sanitizeDeviceControlTransportFailure(response.transportFailure);
  if (transportFailure) {
    return new DeviceControlTransportError(
      response.error || "Device-control transport failure",
      transportFailure,
    );
  }
  return undefined;
}

function daemonFallbackResponseError(response: DaemonResponse): Error {
  const requestFailureCause = sanitizeDaemonRequestFailureCause(response.requestFailureCause);
  const cause = requestFailureCause ? new Error(requestFailureCause.message) : undefined;
  if (cause && requestFailureCause) {
    cause.name = requestFailureCause.name;
  }
  return new ActionableError(response.error || "Unknown error from daemon", { cause });
}

const livenessOwnerHoldSchema = z.object({
  state: z.enum(["live", "suspect", "lapsed"]),
  remainingMs: z.number().finite().nonnegative(),
  holdRemainingMs: z.number().finite().nonnegative(),
});

/**
 * The owner's hold a `liveness_owner_conflict` refusal reports (#10701), when well-formed. A
 * challenger waits it out instead of guessing the daemon's lease from its own configuration.
 */
function livenessOwnerHoldFromResponse(response: DaemonResponse): LivenessOwnerHold | undefined {
  const parsed = livenessOwnerHoldSchema.safeParse(response.result?.liveness);
  return parsed.success ? parsed.data : undefined;
}

/**
 * The daemon's `releaseReason` on a session-not-found answer (#10730), as an error field, with its
 * `idle: true` for an idle-window release (#10832, #10972).
 */
function releaseReasonField(response: DaemonResponse): { releaseReason?: string; idle?: true } {
  if (typeof response.releaseReason !== "string" || response.releaseReason.length === 0) {
    return {};
  }
  // Daemon and proxy versions always match, so the shared reason table reproduces daemon idle.
  return releasedSessionNotFoundFields(response.releaseReason);
}

/** A typed refusal's retry intent from a failed response (#11244), as error fields. */
function typedRefusalResponseFields(
  response: DaemonResponse,
): Pick<DaemonResponse, "retryable" | "retryAfterMs" | "nextAction" | "details"> {
  return {
    ...(typeof response.retryable === "boolean" ? { retryable: response.retryable } : {}),
    ...(typeof response.retryAfterMs === "number" ? { retryAfterMs: response.retryAfterMs } : {}),
    ...(typeof response.nextAction === "string" ? { nextAction: response.nextAction } : {}),
    ...(response.details && typeof response.details === "object"
      ? { details: response.details }
      : {}),
  };
}

/** A request frame's Tasks relay (#4668): present only when the proxy relays the extension. */
export function taskRelayField(tasks: TaskRelayFrame | undefined): Pick<DaemonRequest, "tasks"> {
  return tasks === undefined ? {} : { tasks };
}

/** A relayed `tasks/*` request's JSON-RPC error (#4668), when the frame carried a well-formed one. */
function relayedJsonRpcErrorField(response: DaemonResponse): Pick<DaemonResponse, "jsonRpcError"> {
  return isRelayedJsonRpcError(response.jsonRpcError)
    ? { jsonRpcError: response.jsonRpcError }
    : {};
}

/** The error a failed daemon response rejects with, carrying its structured code and details. */
export function daemonResponseError(response: DaemonResponse): Error {
  const error =
    daemonLifecycleResponseError(response) ??
    daemonSessionResponseError(response) ??
    daemonFallbackResponseError(response);
  // Preserve both top-level codes and the existing typed failure envelopes.
  const code = [
    response.code,
    response.handshakeFailure?.code,
    response.daemonShuttingDown?.code,
    response.overloadFailure?.code,
    response.boundSessionLoss?.code,
    response.transportFailure?.code,
  ].find((value) => value !== undefined);
  const daemonInstance = daemonInstanceFromError(response);
  if (daemonInstance !== undefined) {
    Object.assign(error, { daemonInstance });
  }
  if (code === undefined) {
    return error;
  }
  const livenessOwnerHold =
    code === DAEMON_LIVENESS_OWNER_CONFLICT_CODE
      ? livenessOwnerHoldFromResponse(response)
      : undefined;
  return Object.assign(error, {
    code,
    ...relayedJsonRpcErrorField(response),
    ...typedRefusalResponseFields(response),
    ...(livenessOwnerHold ? { livenessOwnerHold } : {}),
    ...releaseReasonField(response),
  });
}
