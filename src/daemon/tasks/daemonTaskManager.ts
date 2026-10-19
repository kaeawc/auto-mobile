import { defaultDaemonContext } from "../daemonContext";
import { McpTaskRepository } from "../../db/mcpTaskRepository";
import { logger } from "../../utils/logger";
import { DefaultTaskManager, type TaskManager } from "./TaskManager";
import { HeartbeatTaskLeaseKeepalive } from "./taskLeaseKeepalive";

let instance: TaskManager | undefined;
let keepaliveInstance: HeartbeatTaskLeaseKeepalive | undefined;

/**
 * The daemon-scoped task manager (#4668): per-request servers come and go, tasks outlive
 * them. Construction touches no database; the repository resolves it on first use.
 */
export function daemonTaskManager(): TaskManager {
  instance ??= new DefaultTaskManager({ store: new McpTaskRepository() });
  return instance;
}

/**
 * The daemon-scoped lease keepalive (#4668): a task holding a device session renews it through
 * the session manager's heartbeat until the task settles. Resolves the session manager per
 * renewal, so it can be built before the daemon state is initialized.
 */
export function daemonTaskLeaseKeepalive(): HeartbeatTaskLeaseKeepalive {
  keepaliveInstance ??= new HeartbeatTaskLeaseKeepalive({
    sessions: () => defaultDaemonContext.sessionManager(),
  });
  return keepaliveInstance;
}

/**
 * Daemon shutdown: stop renewing the leases running tasks hold. The closed keeper is dropped,
 * so a daemon started later in the same process gets a fresh one rather than a keeper that
 * refuses every hold.
 */
export function releaseDaemonTaskLeases(): number {
  const released = keepaliveInstance?.releaseAll() ?? 0;
  keepaliveInstance = undefined;
  if (released > 0) {
    logger.info(`[TASKS] Released ${released} task-held session lease(s) for shutdown`);
  }
  return released;
}
