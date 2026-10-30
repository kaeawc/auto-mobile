import { DaemonUnavailableError } from "./client/client";

/** A provision request lost the atomic admission race to an accepted restart. */
export class DaemonRestartPendingError extends DaemonUnavailableError {
  readonly code = "daemon_restart_pending";
  readonly retryable = true;

  constructor() {
    super("Daemon restart is pending; retry provisionDevice after the replacement becomes ready.");
    this.name = "DaemonRestartPendingError";
  }
}

/** The typed, retryable `daemon_restart_pending` envelope a refused call is answered with. */
export function daemonRestartPendingPayload(error: DaemonRestartPendingError): {
  error: { code: string; message: string; retryable: boolean };
} {
  return { error: { code: error.code, message: error.message, retryable: error.retryable } };
}

/**
 * The tool result a call gets when it starts during an accepted daemon restart: the typed,
 * retryable `daemon_restart_pending` envelope, in both text and structured content.
 */
export function daemonRestartPendingToolResult(error: DaemonRestartPendingError): {
  content: { type: "text"; text: string }[];
  structuredContent: Record<string, unknown>;
  isError: true;
} {
  const pending = daemonRestartPendingPayload(error);
  return {
    content: [{ type: "text", text: JSON.stringify(pending) }],
    structuredContent: pending,
    isError: true,
  };
}
