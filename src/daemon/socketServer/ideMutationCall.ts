import type { ActiveExecution } from "../../server/executionTracker";
import { executionTracker } from "../../server/executionTracker";
import { runWithAbortSignal } from "../../utils/AbortContext";
import { sessionReleaseThatCancelledCall } from "../sessionReleasedDuringCall";

/** One device-mutating `ide/*` route in flight; its ownership gate hands it the execution. */
export interface IdeMutationCall {
  /**
   * Keep `execution` in flight until the route settles. The holder's own call (`asHolder`) is also
   * cut by a release of its session; a forced call acts for no session and runs to its end.
   */
  track(execution: ActiveExecution, asHolder: boolean): void;
  /** The holder's session admission passed for `execution`: its dispatch will be session use. */
  admit(execution: ActiveExecution): void;
  /**
   * The SDK write was sent successfully, or the direct-file fallback passed its abort check and
   * is about to act on the device: only now is the holder's call session use (#11596, #11750).
   * A route refused or cancelled while connecting ends unstamped.
   */
  dispatching(): void;
  /** The socket session that sent the frame: a managed connection mutates only its binding devices. */
  readonly socketSessionId: string | undefined;
}

/**
 * Run a device-mutating `ide/*` route as one tracked control call. The route's ownership gate
 * starts the execution once the device and its holder are known; it stays in flight until the
 * route settles, so the heartbeat and idle monitors see control in flight on the holder's
 * session. A release that still lands (owner disconnect, forced release) cancels the execution:
 * the holder's own route runs its device work under that signal, and the frame answers the
 * release's typed refusal whatever the interrupted work threw. A forced route is not the
 * holder's call, so the release neither cuts it nor names the holder's session to its caller.
 */
export async function runTrackedIdeMutation<T>(
  socketSessionId: string | undefined,
  run: (call: IdeMutationCall) => Promise<T>,
  ownerSignal?: AbortSignal,
): Promise<T> {
  const abort = new AbortController();
  let tracked: ActiveExecution | undefined;
  let cutByRelease: ActiveExecution | undefined;
  let admitted: ActiveExecution | undefined;
  const call: IdeMutationCall = {
    socketSessionId,
    admit: (execution) => {
      admitted = execution;
    },
    dispatching: () => {
      if (admitted) {
        // The holder's own mutation that reaches the device is use of its session (#10824).
        executionTracker.markSessionAdmitted(admitted.id);
      }
    },
    track: (execution, asHolder) => {
      tracked = execution;
      if (!asHolder) {
        return;
      }
      cutByRelease = execution;
      const signal = execution.abortController.signal;
      if (signal.aborted) {
        abort.abort(signal.reason);
        return;
      }
      signal.addEventListener("abort", () => abort.abort(signal.reason), { once: true });
    },
  };
  try {
    const signal = ownerSignal ? AbortSignal.any([ownerSignal, abort.signal]) : abort.signal;
    signal.throwIfAborted();
    return await runWithAbortSignal(signal, () => run(call));
  } catch (error) {
    throw sessionReleaseThatCancelledCall(cutByRelease?.cancelReason) ?? error;
  } finally {
    if (tracked) {
      executionTracker.endExecution(tracked.id);
    }
  }
}
