import type { Socket } from "node:net";
import type { Duplex } from "node:stream";
import type { Timer } from "../../utils/SystemTimer";
import type { PendingDaemonRequest } from "./clientInboundFrames";

/**
 * What differs between the client's two request kinds once a frame is built (#11817):
 * `sendRequest` (MCP calls on a shared connection) and `callDaemonMethod` (control RPCs,
 * which by default own their connection). {@link sendDaemonFrame} does the rest.
 */
export interface DaemonSendPolicy {
  /** The pending entry's request-specific fields. */
  entry: Omit<PendingDaemonRequest, "resolve" | "reject" | "timeout" | "removeAbortListener">;
  signal?: AbortSignal;
  /** Arm the response backstop. `forgetAbort` removes this request's abort listener. */
  armTimeout(reject: (error: Error) => void, forgetAbort: () => void): NodeJS.Timeout;
  /** Runs once the request is registered, before the frame is written. */
  onRegistered?(): void;
  /** Rejection for a frame that never left this process because there was no socket. */
  socketLostError(): Error;
  /** Rejection for a frame whose synchronous socket write threw. */
  writeError(error: unknown): Error;
  /** Rejection for a caller abort. */
  abortError(): unknown;
  /** Destroy the socket after sending the cancel frame: safe only on a dedicated connection. */
  destroyOnAbort: boolean;
}

/** The `DaemonClient` state one send reads and updates. */
export interface DaemonSendContext {
  /** The client's socket, read when the frame is written and when an abort destroys it. */
  socket: () => Socket | Duplex | null;
  pendingRequests: Map<string, PendingDaemonRequest>;
  /** Abort listeners kept past a timeout for status recovery (#13800), by request id. */
  timedOutRequestAbortCleanups: Map<string, () => void>;
  timer: Timer;
  sendCancelFrame: (requestId: string) => void;
}

/**
 * Register, deliver and settle one request frame (#11817). The request settles exactly once:
 * by its response, its backstop, a failed delivery, a caller abort, or the socket closing.
 */
export function sendDaemonFrame(
  context: DaemonSendContext,
  requestId: string,
  frame: string,
  policy: DaemonSendPolicy,
): Promise<any> {
  const { signal } = policy;
  let removeListener = () => {};
  const forgetAbort = () => {
    removeListener();
    context.timedOutRequestAbortCleanups.delete(requestId);
  };
  return new Promise((resolve, reject) => {
    const timeout = policy.armTimeout(reject, forgetAbort);
    context.pendingRequests.set(requestId, {
      ...policy.entry,
      resolve: (response) => {
        resolve(response.result);
      },
      reject,
      timeout,
      removeAbortListener: forgetAbort,
    });
    policy.onRegistered?.();
    const undelivered = (error: unknown) => {
      context.timer.clearTimeout(timeout);
      forgetAbort();
      context.pendingRequests.delete(requestId);
      reject(error);
    };
    const socket = context.socket();
    if (!socket || signal?.aborted) {
      undelivered(signal?.aborted ? policy.abortError() : policy.socketLostError());
      return;
    }
    try {
      socket.write(frame);
    } catch (error) {
      undelivered(policy.writeError(error));
      return;
    }
    if (!signal) {
      return;
    }
    const onAbort = () => {
      const pending = context.pendingRequests.get(requestId);
      // Settled already: only a timed-out request kept for recovery still cancels on abort.
      if (!pending && !context.timedOutRequestAbortCleanups.has(requestId)) {
        return;
      }
      context.timer.clearTimeout(pending?.timeout ?? timeout);
      context.pendingRequests.delete(requestId);
      forgetAbort();
      context.sendCancelFrame(requestId);
      if (policy.destroyOnAbort) {
        context.socket()?.destroy();
      }
      if (pending) {
        reject(policy.abortError()); // After a timeout the caller already holds the McpTimeoutError.
      }
    };
    signal.addEventListener("abort", onAbort, { once: true });
    removeListener = () => signal.removeEventListener("abort", onAbort);
    if (signal.aborted) {
      onAbort();
    }
  });
}
