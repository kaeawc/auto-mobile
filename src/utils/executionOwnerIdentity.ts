import { logger } from "./logger";
import { errorMessage } from "../models/describeUnknownError";
import type { LockOwnerGenerationProbe } from "./fileLock";

export type ExecutionOwnerIdentityVerdict = ReturnType<LockOwnerGenerationProbe["compare"]>;

/** Compares an optional recorded owner identity, trusting PID-only liveness when unavailable. */
export function compareExecutionOwnerIdentity(
  pid: number,
  recorded: string | undefined,
  compare: LockOwnerGenerationProbe["compare"],
): ExecutionOwnerIdentityVerdict | undefined {
  if (recorded === undefined) {
    return undefined;
  }
  let verdict: ExecutionOwnerIdentityVerdict;
  try {
    verdict = compare(pid, recorded);
  } catch (error) {
    logger.warn(
      `executionOwnerPid ${pid} start identity could not be compared; trusting the PID alone: ${errorMessage(error)}`,
      error,
    );
    return "unknown";
  }
  if (verdict === "unknown") {
    logger.warn(
      `executionOwnerPid ${pid} start identity could not be compared; trusting the PID alone`,
    );
  }
  return verdict;
}
