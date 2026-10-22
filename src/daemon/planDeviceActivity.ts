import { resolveOwnershipSessionUuid } from "../features/toolSelection/selectionSessionResolver";
import { serverConfig } from "../utils/ServerConfig";
import { executionTracker } from "./executionTracker";
import type { SessionManager } from "./sessionManager";

/** Lease registration precedes allocation/adb on both platforms. Resolve its
 * sessions on every read so label allocation and mid-step device switches count.
 * A lease's sessions are its own and the labels it allocates (#14444), never every
 * sibling published under the same base.
 * Keep adb bindings too: they fence work still draining on an earlier device.
 */
export class PlanDeviceActivity {
  constructor(
    private readonly sessions: Pick<SessionManager, "getAllSessions" | "getDeviceLabels">,
    private readonly plans: Pick<typeof serverConfig, "getActivePlanExecutions"> = serverConfig,
    private readonly executions: Pick<
      typeof executionTracker,
      "hasActiveDeviceExecutions" | "bindDeviceExecution"
    > = executionTracker,
  ) {}

  hasPlanExecution(deviceId: string, sessionUuid?: string): boolean {
    if (
      this.executions.hasActiveDeviceExecutions(deviceId, {
        onlyToolName: "executePlan",
        onlySessionUuid: sessionUuid,
      })
    ) {
      return true;
    }
    return this.leasesForDevice(deviceId, sessionUuid).length > 0;
  }

  getPlanExecutionIds(deviceId: string, sessionUuid: string): readonly string[] {
    return this.leasesForDevice(deviceId, sessionUuid).flatMap((plan) =>
      plan.executionId ? [plan.executionId] : [],
    );
  }

  /** Bind only the registered invocations before the existing scoped cancel.
   * This includes iOS/pre-adb work and plans that switched devices mid-step,
   * while another plan merely sharing a session or earlier device is spared.
   */
  bindPlanExecutions(deviceId: string, sessionUuid: string): void {
    for (const plan of this.leasesForDevice(deviceId, sessionUuid)) {
      if (plan.executionId) {
        this.executions.bindDeviceExecution(plan.executionId, deviceId, { skipRevoked: true });
      }
    }
  }

  private leasesForDevice(deviceId: string, sessionUuid?: string) {
    const holders = new Set(
      this.sessions
        .getAllSessions()
        .filter((session) => session.assignedDevice === deviceId)
        .map((session) => session.sessionId),
    );
    return this.plans.getActivePlanExecutions().filter((plan) => {
      if (!plan.sessionUuid) {
        return sessionUuid === undefined && plan.deviceId === deviceId;
      }
      const uses = [plan.sessionUuid, ...(plan.labelSessionUuids ?? [])];
      return (
        (sessionUuid === undefined ||
          this.ownerSession(plan.sessionUuid) === this.ownerSession(sessionUuid)) &&
        uses.some((member) => holders.has(member))
      );
    });
  }

  /** Outermost owner (#14445): a plan on base:B and its nested label base:B:C share one. */
  private ownerSession(sessionUuid: string): string {
    return resolveOwnershipSessionUuid(sessionUuid, this.sessions);
  }
}
