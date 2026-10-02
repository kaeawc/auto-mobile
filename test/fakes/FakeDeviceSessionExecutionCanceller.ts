import type { DeviceSessionExecutionCanceller } from "../../src/daemon/devicePool";
import type { ExecutionTracker } from "../../src/server/executionTracker";

type DeviceSessionExecutionCancellerContract = {
  readonly cancel: DeviceSessionExecutionCanceller;
};

/** Records both scopes and delegates cancellation to an injected in-memory tracker. */
export class FakeDeviceSessionExecutionCanceller implements DeviceSessionExecutionCancellerContract {
  readonly sessions: string[] = [];
  readonly devices: string[] = [];
  readonly cancel: DeviceSessionExecutionCanceller;

  readonly drains: boolean[] = [];

  constructor({ tracker, drain = false }: { tracker: ExecutionTracker; drain?: boolean }) {
    this.cancel = Object.assign(
      async (sessionId: string, reason: string, options?: { excludeExecutionId?: string }) => {
        this.sessions.push(sessionId);
        const cancelled = await tracker.cancelDeviceSessionExecutions(sessionId, reason, options);
        if (drain && cancelled > 0) {
          this.drains.push(
            await tracker.waitForDeviceSessionExecutionsToEnd(sessionId, 1000, options),
          );
        }
        return cancelled;
      },
      {
        cancelDeviceExecutions: async (
          deviceId: string,
          reason: string,
          options?: { excludeExecutionId?: string },
        ) => {
          this.devices.push(deviceId);
          const cancelled = await tracker.cancelDeviceExecutions(deviceId, reason, options);
          if (drain && cancelled > 0) {
            this.drains.push(await tracker.waitForDeviceExecutionsToEnd(deviceId, 1000, options));
          }
          return cancelled;
        },
      },
    );
  }
}
