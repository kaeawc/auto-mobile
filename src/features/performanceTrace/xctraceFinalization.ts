import { lstat } from "node:fs/promises";
import { join } from "node:path";
import { toActionableError } from "../../models/ActionableError";
import { errorMessage } from "../../utils/describeUnknownError";
import type { HostChildProcess } from "../../utils/HostCommandExecutor";
import { sortedReaddir } from "../../utils/io";
import { logger } from "../../utils/logger";
import type { Timer } from "../../utils/SystemTimer";
import { PerformanceTraceStopTimeoutError } from "./PerformanceTraceStopTimeoutError";

/** Sum regular files without following symlinks outside the trace bundle. */
export async function traceArtifactBytes(path: string): Promise<number> {
  try {
    const stat = await lstat(path);
    if (stat.isDirectory()) {
      let bytes = 0;
      for (const name of await sortedReaddir(path)) {
        bytes += await traceArtifactBytes(join(path, name));
      }
      return bytes;
    }
    return stat.isFile() ? stat.size : 0;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      // xctrace may not have created the bundle yet, or may replace files while saving.
      logger.debug(`Trace artifact path is not present: ${path}`);
      return 0;
    }
    throw toActionableError(error, `Cannot measure trace artifact ${path}`);
  }
}

interface FinalizationOptions {
  timer: Timer;
  artifactPath: string;
  artifactBytes(path: string): Promise<number>;
  stopTimeoutMs: number;
  stopMaxMs: number;
}

/** Listen before SIGINT; output and size growth refresh only the inactivity deadline. */
export function waitForXctraceFinalization(
  child: HostChildProcess,
  exited: Promise<void>,
  options: FinalizationOptions,
): Promise<void> {
  const { timer, artifactPath, artifactBytes, stopTimeoutMs, stopMaxMs } = options;
  return new Promise((resolve, reject) => {
    const started = timer.now();
    let lastActivityMs: number | undefined;
    let finished = false;
    let previousBytes: number | undefined;
    let poll: NodeJS.Timeout | undefined;
    const cleanup = () => {
      finished = true;
      timer.clearTimeout(idle);
      timer.clearTimeout(hard);
      if (poll) {
        timer.clearTimeout(poll);
      }
      child.stdout?.off("data", activity);
      child.stderr?.off("data", activity);
    };
    const timeout = () => {
      cleanup();
      child.kill("SIGKILL");
      reject(
        new PerformanceTraceStopTimeoutError(artifactPath, timer.now() - started, lastActivityMs),
      );
    };
    let idle = timer.setTimeout(timeout, stopTimeoutMs);
    const hard = timer.setTimeout(timeout, stopMaxMs);
    const activity = () => {
      if (finished) {
        return;
      }
      lastActivityMs = timer.now();
      timer.clearTimeout(idle);
      idle = timer.setTimeout(timeout, stopTimeoutMs);
    };
    const measure = async () => {
      try {
        const bytes = await artifactBytes(artifactPath);
        if (finished) {
          return;
        }
        if (previousBytes !== undefined && bytes > previousBytes) {
          activity();
        }
        previousBytes = bytes;
      } catch (error) {
        // Size is best-effort progress evidence; output and both deadlines remain active.
        logger.warn(`Cannot measure xctrace progress: ${errorMessage(error)}`, error);
      }
      if (!finished) {
        poll = timer.setTimeout(() => void measure(), 2000);
      }
    };
    child.stdout?.on("data", activity);
    child.stderr?.on("data", activity);
    void exited.then(() => {
      if (finished) {
        return;
      }
      cleanup();
      resolve();
    });
    void measure();
  });
}
