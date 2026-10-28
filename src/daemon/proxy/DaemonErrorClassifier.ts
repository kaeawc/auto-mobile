import { errorMessage } from "../../utils/describeUnknownError";
import { DaemonHandshakeMismatchError } from "../DaemonHandshakeMismatchError";
import { DaemonRequestNotDeliveredError } from "../DaemonRequestNotDeliveredError";
import { DaemonShuttingDownError } from "../DaemonShuttingDownError";
import { DaemonUnavailableError } from "../client/client";
import { isMcpQueueTimeoutError } from "../wire/McpTimeoutError";
import {
  DAEMON_SESSION_NOT_ACTIVE_CODE,
  DAEMON_SESSION_NOT_FOUND_CODE,
  DAEMON_UNKNOWN_TOOL_CODE,
  errorCodeOf,
  isGatedToolErrorCode,
} from "../types";
import { DaemonAssetVersionMismatchError } from "./DaemonAssetVersionMismatchError";
import { DaemonBuildMismatchError } from "./DaemonBuildMismatchError";
import { DaemonVersionMismatchError } from "./DaemonVersionMismatchError";
import { DaemonPreflightConnectionError } from "./DaemonPreflightConnectionError";
import { DaemonRestartOptionsUnknownError } from "./DaemonRestartOptionsUnknownError";

/**
 * Connection facts the classifier reads:
 * - structuredSessionNotFound and structuredToolErrorCodes are the connected daemon's advertised
 *   capabilities; they are connection-scoped, so they are read live, never cached.
 * - frontendRegistersTool says whether this frontend advertises a tool name.
 */
export interface DaemonErrorClassifierPort {
  structuredSessionNotFound(): boolean;
  structuredToolErrorCodes(): boolean;
  frontendRegistersTool(name: string): boolean;
}

/**
 * Decides what a daemon rejection proves about a forwarded call: whether the session is gone,
 * whether the tool name was refused, whether the call provably never dispatched, and whether a
 * reconnect can heal it. Pure over the error and the port's connection facts.
 */
export class DaemonErrorClassifier {
  constructor(private readonly port: DaemonErrorClassifierPort) {}

  isRecoverableDaemonSessionError(error: unknown, established = true): boolean {
    if (!established) {
      return error instanceof DaemonPreflightConnectionError;
    }
    // Compatibility policy failures cannot be healed by another connection
    // attempt (and repeating a failed reconciliation could restart twice).
    if (
      error instanceof DaemonVersionMismatchError ||
      error instanceof DaemonBuildMismatchError ||
      error instanceof DaemonAssetVersionMismatchError ||
      error instanceof DaemonRestartOptionsUnknownError
    ) {
      return false;
    }
    // Structured server evidence proves rejection happened before dispatch.
    // Legacy message-only errors remain non-retryable rather than guessing.
    if (error instanceof DaemonHandshakeMismatchError) {
      return true;
    }
    if (error instanceof DaemonUnavailableError) {
      return true;
    }

    // "Unknown tool" is recoverable only when the frontend advertises that tool.
    // A reconnect cannot make a frontend-unregistered name exist in the daemon.
    return this.isDaemonSessionNotFoundError(error) || this.isRecoverableUnknownToolError(error);
  }

  /**
   * Structured evidence that the daemon never dispatched the request: the frame
   * was never written, or the daemon rejected it before admission. Message
   * substrings (e.g. "Session not found") are deliberately not evidence here.
   */
  isProvablyUndispatchedError(error: unknown): boolean {
    return (
      error instanceof DaemonRequestNotDeliveredError ||
      (error instanceof DaemonShuttingDownError && !error.requestMayHaveDispatched) ||
      error instanceof DaemonHandshakeMismatchError ||
      isMcpQueueTimeoutError(error) ||
      this.isRecoverableUnknownToolError(error)
    );
  }

  isDaemonSessionNotFoundError(error: unknown): boolean {
    if (
      error !== null &&
      typeof error === "object" &&
      "code" in error &&
      error.code !== undefined
    ) {
      return error.code === DAEMON_SESSION_NOT_FOUND_CODE;
    }
    if (this.port.structuredSessionNotFound()) {
      return false;
    }
    // Older daemons return only the bare message, without a structured error code.
    return errorMessage(error).includes("Session not found");
  }

  isPreDispatchDaemonSessionError(error: unknown): boolean {
    return (
      this.isUnknownToolError(error) ||
      errorCodeOf(error) === DAEMON_SESSION_NOT_ACTIVE_CODE ||
      this.matchesLegacyMessage(error, "is not an active daemon session")
    );
  }

  isUnknownToolError(error: unknown): boolean {
    return (
      this.isGatedToolError(error) ||
      errorCodeOf(error) === DAEMON_UNKNOWN_TOOL_CODE ||
      this.matchesLegacyMessage(error, "Unknown tool:")
    );
  }

  /**
   * Message-text classification, kept only for daemons that predate the structured codes: a daemon
   * advertising `structuredToolErrorCodes` always sends the code, so its prose is never evidence.
   */
  matchesLegacyMessage(error: unknown, text: string): boolean {
    return !this.port.structuredToolErrorCodes() && errorMessage(error).includes(text);
  }

  /** The tool an unknown-tool refusal names, from the frame's evidence or (old daemons) its prose. */
  unknownToolName(error: unknown): string | undefined {
    if (errorCodeOf(error) === DAEMON_UNKNOWN_TOOL_CODE) {
      const details: unknown = error instanceof Error ? Reflect.get(error, "details") : undefined;
      const toolName: unknown =
        details !== null && typeof details === "object"
          ? Reflect.get(details, "toolName")
          : undefined;
      return typeof toolName === "string" ? toolName : "";
    }
    if (this.port.structuredToolErrorCodes()) {
      return undefined;
    }
    return errorMessage(error).match(/Unknown tool:\s*(\S+)/)?.[1];
  }

  /**
   * The daemon registers the tool but its availability gate (debug-only,
   * embedded-SDK-only, plan-only) rejected the call (issue #10177). Structured
   * code only: the gate-reason prose is never parsed. A daemon that predates the
   * code sends none, so it falls through to the stale-daemon recovery below —
   * that daemon is necessarily a different build than this proxy, so the
   * reconnect re-runs the build-identity reconciliation and replaces it.
   */
  isGatedToolError(error: unknown): boolean {
    return isGatedToolErrorCode(error);
  }

  isRecoverableUnknownToolError(error: unknown): boolean {
    // A gate is daemon configuration, not skew: a reconnect cannot lift it, and
    // resetting would abort every sibling call in flight on the shared client.
    if (this.isGatedToolError(error)) {
      return false;
    }
    const rawName = this.unknownToolName(error);
    if (rawName === undefined) {
      return this.isUnknownToolError(error);
    }
    const name = rawName.replace(/[.,;:!?]+$/, "");
    return name.length === 0 || this.port.frontendRegistersTool(name);
  }
}
