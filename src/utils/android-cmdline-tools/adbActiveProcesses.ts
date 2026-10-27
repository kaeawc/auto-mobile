import { errorMessage } from "../describeUnknownError";
import { type HostChildProcess as ChildProcess } from "../HostCommandExecutor";
import { logger } from "../logger";
import { Timer, defaultTimer } from "../SystemTimer";

// Shared across instances: daemon shutdown must cover request-scoped clients too.
export const activeProcesses = new Set<ChildProcess>();

export function isActiveAdbChild(child: ChildProcess): boolean {
  return (
    (child.exitCode === null || child.exitCode === undefined) &&
    (child.signalCode === null || child.signalCode === undefined)
  );
}

export async function terminateActiveAdbProcesses(
  options: { timer?: Timer; graceMs?: number } = {},
): Promise<{ terminated: number; failed: number }> {
  const timer = options.timer ?? defaultTimer;
  const graceMs = Math.max(0, options.graceMs ?? 500);
  const summary = { terminated: 0, failed: 0 };
  const pending = new Set<ChildProcess>();
  for (const child of [...activeProcesses]) {
    const result = terminateAdbChild(child);
    if (result === "pending") {
      pending.add(child);
    } else if (result === "failed") {
      summary.failed++;
    }
  }
  try {
    await waitForActiveAdbChildren(pending, timer, graceMs);
    for (const child of pending) {
      killActiveAdbChild(child);
    }
    await waitForActiveAdbChildren(pending, timer, graceMs);
    for (const child of pending) {
      if (!isPendingAdbChild(child)) {
        activeProcesses.delete(child);
        summary.terminated++;
      } else {
        summary.failed++;
        logger.warn(`[ADB] Host child ${child.pid ?? "unknown"} still alive after bounded cleanup`);
      }
    }
  } catch (error) {
    logger.warn(`[ADB] Failed to wait for host children: ${errorMessage(error)}`, error);
    summary.failed += pending.size;
  }
  return summary;
}

export async function waitForActiveAdbChildren(
  children: Set<ChildProcess>,
  timer: Timer,
  graceMs: number,
): Promise<void> {
  const now = () => timer.monotonicNow?.() ?? timer.now();
  const deadline = now() + graceMs;
  while ([...children].some((child) => isPendingAdbChild(child)) && now() < deadline) {
    await timer.sleep(Math.min(25, deadline - now()));
  }
}

export function trackActiveAdbChild(child: ChildProcess): void {
  activeProcesses.add(child);
  child.once("exit", () => activeProcesses.delete(child));
}

export function removeFinishedAdbChild(child: ChildProcess): void {
  if (!isActiveAdbChild(child)) {
    activeProcesses.delete(child);
  }
}

export function terminateAdbChild(child: ChildProcess): "pending" | "skipped" | "failed" {
  if (!isActiveAdbChild(child)) {
    activeProcesses.delete(child);
    return "skipped";
  }
  if (child.pid !== undefined && (child.pid <= 1 || child.pid === process.pid)) {
    return "skipped";
  }
  try {
    child.kill("SIGTERM");
    return "pending";
  } catch (error) {
    logger.warn(`[ADB] Failed to terminate host child: ${errorMessage(error)}`, error);
    return "failed";
  }
}

export function killActiveAdbChild(child: ChildProcess): void {
  if (!isPendingAdbChild(child)) {
    return;
  }
  try {
    child.kill("SIGKILL");
  } catch (error) {
    logger.warn(`[ADB] Failed to kill host child: ${errorMessage(error)}`, error);
  }
}

export function isPendingAdbChild(child: ChildProcess): boolean {
  return activeProcesses.has(child) && isActiveAdbChild(child);
}
