/**
 * Parses `cmd jobscheduler run [-f] [-u <user>] <pkg> <jobId>`. AOSP prints `Running job` (with
 * `[FORCED]` after `-f`) once the job is started, and a plain-English reason otherwise; those
 * reasons vary by release, so refusals are classified by keyword.
 */

export type RunJobErrorCode =
  | "package_not_found"
  | "job_not_found"
  | "job_not_ready"
  | "permission_denied"
  | "run_failed";

export type RunJobOutput =
  | { ran: true; forced: boolean }
  | { ran: false; errorCode: RunJobErrorCode; error: string };

export function parseRunJobOutput(output: string): RunJobOutput {
  const running = /\bRunning job(\s+\[FORCED\])?/i.exec(output);
  if (running) {
    return { ran: true, forced: running[1] !== undefined };
  }
  if (/SecurityException|Permission Denial/i.test(output)) {
    return {
      ran: false,
      errorCode: "permission_denied",
      error: "The shell may not run this job: cmd jobscheduler refused with a permission error.",
    };
  }
  if (/not ready|constraints|-f\b|force/i.test(output)) {
    return {
      ran: false,
      errorCode: "job_not_ready",
      error: "The job's constraints are not satisfied; run it with force: true to bypass them.",
    };
  }
  if (/package/i.test(output) && /not found|unknown|no such|doesn't exist/i.test(output)) {
    return {
      ran: false,
      errorCode: "package_not_found",
      error: "The package is not installed for that user.",
    };
  }
  if (/not found|unknown|no such|doesn't exist|does not exist|no job/i.test(output)) {
    return {
      ran: false,
      errorCode: "job_not_found",
      error: "The app has no job with that id; list the jobs first.",
    };
  }
  return {
    ran: false,
    errorCode: "run_failed",
    error: "cmd jobscheduler run did not start the job.",
  };
}
