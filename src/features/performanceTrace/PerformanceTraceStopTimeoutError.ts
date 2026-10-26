import { ActionableError } from "../../models/ActionableError";

/** Finalisation exhausted its inactivity window or total wait budget. */
export class PerformanceTraceStopTimeoutError extends ActionableError {
  constructor(
    readonly artifactPath: string,
    readonly waitedMs: number,
    /** Timer timestamp of the last observed output or artifact growth, if any. */
    readonly lastActivityMs?: number,
  ) {
    super(
      `xctrace did not finish finalising the trace within ${waitedMs} ms after SIGINT (host busy?); ` +
        `the trace at ${artifactPath} is incomplete and cannot be summarised. ` +
        "Retry with a shorter timeLimitMs or on a quieter host.",
    );
    this.name = "PerformanceTraceStopTimeoutError";
  }
}
