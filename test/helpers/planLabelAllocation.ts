import type { SessionManager } from "../../src/daemon/sessionManager";

type LabelMinter = Pick<SessionManager, "openPlanLabelMints">;

/**
 * Run `allocate` as a plan run's device allocation runs: inside the window in which `base` may
 * mint the derived `${base}:${label}` sessions among `sessionIds` (#11602). A derived label
 * session is created only there, so a test that drives the pool's allocators or
 * `SessionManager.createSession` directly stands in for
 * `PlanExecutionOrchestrator.allocateDevices` with this. The window closes when `allocate`
 * settles, as the orchestrator's does.
 */
export async function asPlanAllocation<T>(
  manager: LabelMinter,
  base: string,
  sessionIds: readonly string[],
  allocate: () => Promise<T>,
): Promise<T> {
  const close = manager.openPlanLabelMints(
    base,
    Object.fromEntries(sessionIds.map((sessionId) => [sessionId, sessionId])),
  );
  try {
    return await allocate();
  } finally {
    close();
  }
}
