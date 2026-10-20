import type { Readable } from "node:stream";
import type { HostChildProcess } from "./HostCommandExecutor";

/** A spawned child whose stdout and stderr pipes are open. */
export type PipedOutputChild = HostChildProcess & { stdout: Readable; stderr: Readable };

/** True when the child was spawned with piped stdout and stderr (they are null otherwise). */
export function hasPipedOutput(child: HostChildProcess): child is PipedOutputChild {
  return child.stdout !== null && child.stderr !== null;
}

/** The child with its stdout/stderr pipes proven open; a pipe-less child is killed and rejected. */
export function requirePipedOutput(child: HostChildProcess, label: string): PipedOutputChild {
  if (hasPipedOutput(child)) {
    return child;
  }
  child.kill();
  throw new Error(`Failed to open stdout/stderr pipes for ${label}`);
}

/**
 * True when a child started with piped stdin, stdout and stderr; narrows to the caller's
 * stricter process contract `P`.
 */
export function hasPipedStdio<
  T extends { stdin: unknown; stdout: unknown; stderr: unknown },
  P extends T,
>(child: T): child is P {
  return child.stdin !== null && child.stdout !== null && child.stderr !== null;
}
