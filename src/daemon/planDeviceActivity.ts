import { resolveToolSelectionBaseSessionUuid } from "../features/toolSelection/selectionSessionResolver";
import { serverConfig } from "../utils/ServerConfig";
import { executionTracker } from "./executionTracker";
import type { SessionManager } from "./sessionManager";

/** Lease registration precedes allocation/adb on both platforms. Resolve its
 * sessions on every read so label allocation and mid-step device switches count.
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

  /** Bind only the registered invocations before the existing scoped cancel.
   * This includes iOS/pre-adb work and plans that switched devices mid-step,
   * while another plan merely sharing a session or earlier device is spared.
   */
  bindPlanExecutions(deviceId: string, sessionUuid: string): void {
    for (const plan of this.leasesForDevice(deviceId, sessionUuid)) {
      if (plan.executionId) {
        this.executions.bindDeviceExecution(plan.executionId, deviceId);
      }
    }
  }

  private leasesForDevice(deviceId: string, sessionUuid?: string) {
    const holders = this.sessions
      .getAllSessions()
      .filter((session) => session.assignedDevice === deviceId)
      .map((session) => this.baseSession(session.sessionId));
    return this.plans.getActivePlanExecutions().filter((plan) => {
      if (!plan.sessionUuid) {
        return sessionUuid === undefined && plan.deviceId === deviceId;
      }
      const base = this.baseSession(plan.sessionUuid);
      return (sessionUuid === undefined || base === sessionUuid) && holders.includes(base);
    });
  }

  private baseSession(sessionUuid: string): string {
    return resolveToolSelectionBaseSessionUuid(sessionUuid, this.sessions) ?? sessionUuid;
  }
}
