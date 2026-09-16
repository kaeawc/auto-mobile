/**
 * A completed one-shot CLI command can ask its executable owner to terminate.
 *
 * The CLI library never exits the process itself: its caller must first finish
 * any required lifecycle cleanup and flush the command's output. This keeps
 * command orchestration reusable while still letting the executable escape
 * abandoned read-only diagnostic handles after a bounded repair failure.
 */
export interface CliTerminationRequest {
  readonly exitCode: number;
}

/** Injectable process boundary for the executable and child-process tests. */
export interface CliProcessTerminator {
  terminate(exitCode: number): void;
}

/** End a CLI process only after its caller has completed output and cleanup. */
export function terminateCliProcess(
  request: CliTerminationRequest,
  terminator: CliProcessTerminator,
): void {
  terminator.terminate(request.exitCode);
}
