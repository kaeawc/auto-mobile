import { defaultDaemonContext } from "../../../daemon/daemonContext";

/**
 * Whether `sessionUuid` is a live session of the plan `boundSessionUuid` belongs to (#11602). The
 * one answer for a connection's seeded binding ({@link SessionToolBinding}) and for the binding
 * its calls recorded, read without holding, extending or releasing either session.
 */
export function namesLiveSessionOfBoundPlan(
  sessionUuid: string,
  boundSessionUuid: string,
): boolean {
  return !!defaultDaemonContext
    .sessionManager()
    ?.isLiveSessionOfSamePlan(sessionUuid, boundSessionUuid);
}
