import { logger } from "../../utils/logger";

export interface TaskLeaseHoldRequest {
  readonly taskId: string;
  /** The MCP session key that owns the task. */
  readonly ownerKey: string;
  /** The device session whose lease the task keeps alive. */
  readonly sessionUuid: string;
}

/**
 * Owner decision (2026-10-18, #4668): a task that holds a device keeps that session's device
 * lease alive while it is `working` or `input_required`, so the client need not heartbeat
 * for it. The task layer calls {@link hold} when the work names its device session and the
 * returned release once the task is terminal. The session broker implements it (#4668 T2).
 */
export interface TaskLeaseKeepalive {
  hold(request: TaskLeaseHoldRequest): () => void;
}

/** Holds nothing: the default until the broker-backed keepalive is wired. */
export const noopTaskLeaseKeepalive: TaskLeaseKeepalive = {
  hold(request) {
    logger.debug(
      `[TASKS] No lease keepalive wired; task ${request.taskId} does not hold session ${request.sessionUuid}`,
    );
    return () => {};
  },
};
