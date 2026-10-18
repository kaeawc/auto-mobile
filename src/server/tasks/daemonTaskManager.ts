import { McpTaskRepository } from "../../db/mcpTaskRepository";
import { DefaultTaskManager, type TaskManager } from "./TaskManager";

let instance: TaskManager | undefined;

/**
 * The daemon-scoped task manager (#4668): per-request servers come and go, tasks outlive
 * them. Construction touches no database; the repository resolves it on first use.
 */
export function daemonTaskManager(): TaskManager {
  instance ??= new DefaultTaskManager({ store: new McpTaskRepository() });
  return instance;
}
