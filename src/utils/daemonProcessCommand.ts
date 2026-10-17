import { execFileSync as nodeExecFileSync } from "node:child_process";

/** Injectable synchronous argv-first boundary for bounded daemon process probes. */
export type DaemonProcessCommandRunner = (
  command: string,
  args: readonly string[],
  options: { timeout: number; env: NodeJS.ProcessEnv },
) => string;

/**
 * Runs a bounded daemon process probe without a shell.
 *
 * Daemon execution belongs here so callers retain narrow test seams without
 * introducing direct child-process invocations elsewhere in `src/daemon`.
 */
export const runDaemonProcessCommand: DaemonProcessCommandRunner = (command, args, options) =>
  nodeExecFileSync(command, args, {
    encoding: "utf-8",
    timeout: options.timeout,
    env: options.env,
  });
