/**
 * Custom error thrown when daemon is unavailable
 */
export class DaemonUnavailableError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "DaemonUnavailableError";
  }
}

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
