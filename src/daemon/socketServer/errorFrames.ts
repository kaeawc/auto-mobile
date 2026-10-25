import { ProtocolError } from "@modelcontextprotocol/server";
import { ACQUIRE_NEW_SESSION_NEXT_ACTION } from "../../models/deviceSessionRecovery";
import { typedRefusalFields } from "../../models/typedRefusalFields";
import { recoveryIdentityLoss, recoveryIdentityLossDetails } from "../deviceSessionResult";
import {
  isSessionNotActiveWireError,
  isToolUnavailableWireError,
  unknownToolWireName,
} from "../toolUnavailableError";
import { errorMessage } from "../../utils/describeUnknownError";
import {
  McpOverloadError,
  McpTimeoutError,
  MCP_QUEUE_TIMEOUT_ERROR_CODE,
} from "../wire/McpTimeoutError";
import { idleReleaseField } from "../releaseReasons";
import { SESSION_OWNERSHIP_LOST_CODE } from "../sessionReleasedDuringCall";
import {
  DAEMON_SESSION_NOT_ACTIVE_CODE,
  DAEMON_SESSION_SUSPECT_CODE,
  DAEMON_TOOL_UNAVAILABLE_CODE,
  DAEMON_UNKNOWN_TOOL_CODE,
  type DaemonRequestFailureCause,
  type DaemonResponse,
} from "../types";

/**
 * The failure frames the control socket writes (#11815): the typed refusal fields a failed request
 * puts on its response, read structurally from the error so the wire layer imports no session
 * manager. Pure functions of the error; no server state.
 */

export function requestFailureCause(
  error: unknown,
  requestSignal?: AbortSignal,
): DaemonRequestFailureCause | undefined {
  const cause = requestSignal?.aborted
    ? requestSignal.reason
    : error instanceof McpTimeoutError
      ? error
      : undefined;
  if (cause === undefined) {
    return undefined;
  }
  return {
    name: cause instanceof Error ? cause.name : "Error",
    message: errorMessage(cause),
  };
}

const JSONRPC_INVALID_PARAMS = -32602;

type RefusalFrameFields = Pick<
  DaemonResponse,
  "code" | "retryable" | "retryAfterMs" | "nextAction" | "details"
>;

/**
 * The payload a refusal builds for the MCP result (`toPayload()`), when it is a typed one. Read
 * structurally so a new self-describing refusal reaches the socket without a branch here.
 */
function selfDescribedRefusalPayload(error: unknown): Record<string, unknown> | undefined {
  if (!(error instanceof Error) || !("toPayload" in error)) {
    return undefined;
  }
  const { toPayload } = error;
  if (typeof toPayload !== "function") {
    return undefined;
  }
  const payload: unknown = toPayload.call(error);
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    return undefined;
  }
  const fields: Record<string, unknown> = Object.fromEntries(Object.entries(payload));
  return typeof fields.code === "string" && typeof fields.retryable === "boolean"
    ? fields
    : undefined;
}

/**
 * The frame fields of a control call refused at session admission (#11417): a suspect session is
 * the retryable `daemon_session_suspect`, a terminal one `session_ownership_lost` with
 * `acquire_new_session`, as in the MCP result for the same refusal. Matched on the error's name
 * and fields so the wire layer does not import the daemon's session manager.
 */
function sessionAdmissionRefusalFields(error: unknown): RefusalFrameFields | undefined {
  if (!(error instanceof Error)) {
    return undefined;
  }
  const field = (key: string): unknown => Reflect.get(error, key);
  const sessionUuid = field("sessionUuid");
  if (typeof sessionUuid !== "string") {
    return undefined;
  }
  const remainingMs = field("remainingMs");
  if (error.name === "SessionSuspectError" && typeof remainingMs === "number") {
    return {
      code: DAEMON_SESSION_SUSPECT_CODE,
      retryable: true,
      details: { sessionUuid, remainingMs },
    };
  }
  const release = field("release");
  if (error.name !== "TerminalSessionError" || release === null || typeof release !== "object") {
    return undefined;
  }
  const reason: unknown = Reflect.get(release, "releaseReason");
  const ownerPid: unknown = Reflect.get(release, "ownerPid");
  return {
    code: SESSION_OWNERSHIP_LOST_CODE,
    retryable: false,
    nextAction: ACQUIRE_NEW_SESSION_NEXT_ACTION,
    details: {
      sessionUuid,
      ...(typeof reason === "string" ? { reason } : {}),
      ...idleReleaseField(typeof reason === "string" ? reason : undefined),
      ...(typeof ownerPid === "number" ? { ownerPid } : {}),
    },
  };
}

/** Whether a failure is a session refusal: the session is suspect, or gone for good. */
export function isSessionRefusal(error: unknown): boolean {
  const { code } = refusalFrameFields(error);
  return code === DAEMON_SESSION_SUSPECT_CODE || code === SESSION_OWNERSHIP_LOST_CODE;
}

/**
 * The typed fields a refusal puts on a failure frame: the same code, retry intent and evidence its
 * MCP result carries (#11244, #11391). A self-describing refusal's payload supplies the evidence
 * (`deviceId`, `boundSessionUuid`, ...) as `details`; a persisted session lost to recovery is the
 * terminal `session_ownership_lost`; any other typed refusal is read from the error's own fields.
 */
function refusalFrameFields(error: unknown): RefusalFrameFields {
  const sessionRefusal = sessionAdmissionRefusalFields(error);
  if (sessionRefusal) {
    return sessionRefusal;
  }
  const lostToRecovery = recoveryIdentityLoss(error);
  if (lostToRecovery) {
    return {
      code: SESSION_OWNERSHIP_LOST_CODE,
      retryable: false,
      nextAction: ACQUIRE_NEW_SESSION_NEXT_ACTION,
      details: recoveryIdentityLossDetails(lostToRecovery),
    };
  }
  const payload = selfDescribedRefusalPayload(error);
  if (!payload) {
    return typedRefusalFields(error) ?? {};
  }
  const { code, retryable, retryAfterMs, nextAction, ...details } = payload;
  return {
    ...(typeof code === "string" ? { code } : {}),
    ...(typeof retryable === "boolean" ? { retryable } : {}),
    ...(typeof retryAfterMs === "number" ? { retryAfterMs } : {}),
    ...(typeof nextAction === "string" ? { nextAction } : {}),
    ...(Object.keys(details).length > 0 ? { details } : {}),
  };
}

function unknownToolFrameFields(error: unknown): Pick<DaemonResponse, "code" | "details"> {
  const toolName = unknownToolWireName(error);
  return toolName === undefined ? {} : { code: DAEMON_UNKNOWN_TOOL_CODE, details: { toolName } };
}

export function mcpRequestFailureDetails(
  error: unknown,
  cause: DaemonRequestFailureCause | undefined,
): Pick<
  DaemonResponse,
  | "code"
  | "retryable"
  | "retryAfterMs"
  | "nextAction"
  | "details"
  | "overloadFailure"
  | "requestFailureCause"
> {
  return {
    // Any typed refusal (e.g. retryable discovery_incomplete from an ide/* device lookup) keeps
    // its code, retry intent and evidence on the socket wire, not just its message (#11244,
    // #11391). The class-specific codes below still win.
    ...refusalFrameFields(error),
    ...(error instanceof McpOverloadError ? { overloadFailure: error.failure } : {}),
    ...(error instanceof McpTimeoutError && error.code ? { code: error.code } : {}),
    // Nothing was dispatched while the request waited in the queue, so a retry is safe; the MCP
    // result already says so and the frame must agree for direct-socket clients.
    ...(error instanceof McpTimeoutError && error.code === MCP_QUEUE_TIMEOUT_ERROR_CODE
      ? { retryable: true }
      : {}),
    // Keep the daemon MCP server's invalid-params verdict (e.g. a malformed
    // resource URI) so the proxy can return -32602 instead of -32603.
    ...(error instanceof ProtocolError && "code" in error && error.code === JSONRPC_INVALID_PARAMS
      ? { code: JSONRPC_INVALID_PARAMS }
      : {}),
    ...(isToolUnavailableWireError(error) ? { code: DAEMON_TOOL_UNAVAILABLE_CODE } : {}),
    ...unknownToolFrameFields(error),
    ...(isSessionNotActiveWireError(error) ? { code: DAEMON_SESSION_NOT_ACTIVE_CODE } : {}),
    ...(cause ? { requestFailureCause: cause } : {}),
  };
}
