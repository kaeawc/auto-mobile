import type { ActiveExecution } from "../executionTracker";

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
  /** The route body's cancellation signal, read here rather than ambiently (#11817). */
  readonly signal: AbortSignal;
}
