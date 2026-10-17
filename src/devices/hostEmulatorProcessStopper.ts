import { ActionableError } from "../models/ActionableError";
import { defaultLockOwnerGenerationProbe } from "../utils/lockOwnerGeneration";
import { ProcessTableReader } from "../features/bootAdmission/processTableRetry";
import { nodeProcFs } from "../features/bootAdmission/procProcessTable";
import { DefaultHostCommandExecutor, type HostCommandExecutor } from "../utils/HostCommandExecutor";
import { errorMessage } from "../utils/describeUnknownError";
import { logger } from "../utils/logger";
import { raceWithDeadline } from "../utils/raceWithDeadline";
import { defaultTimer, type Timer } from "../utils/SystemTimer";
import type { LockOwnerGenerationProbe } from "../utils/fileLock";
import {
  ProcessTableEmulatorProcessStopper,
  isSafeEmulatorProcessPid,
  type EmulatorGroupProbe,
  type EmulatorProcessSignaler,
  type EmulatorProcessStopper,
} from "../utils/android-cmdline-tools/EmulatorProcessStop";

type ProcessGroupRow = { pid: number; pgid: number; command: string };

/** ps's first two columns are integers; the remainder is the exact command, including spaces. */
function parseProcessGroups(stdout: string): ProcessGroupRow[] | undefined {
  const rows: ProcessGroupRow[] = [];
  for (const line of stdout.split("\n")) {
    if (!line.trim()) {
      continue;
    }
    const columns = /^\s*(\d+)\s+(\d+)\s+(.+)$/.exec(line);
    if (!columns || !columns[3].trim()) {
      return undefined;
    }
    const pid = Number(columns[1]);
    const pgid = Number(columns[2]);
    if (!Number.isSafeInteger(pid) || !Number.isSafeInteger(pgid)) {
      return undefined;
    }
    rows.push({ pid, pgid, command: columns[3] });
  }
  return rows;
}

function provenOwnGroup(
  rows: ProcessGroupRow[] | undefined,
  identity: { pid: number; command: string },
  ownPid: number,
): EmulatorGroupProbe {
  if (!rows) {
    return { kind: "unproven" };
  }
  const candidates = rows.filter((row) => row.pid === identity.pid);
  const owners = rows.filter((row) => row.pid === ownPid);
  const row = candidates[0];
  const owner = owners[0];
  if (owners.length !== 1 || owner.pgid <= 0 || candidates.length > 1) {
    return { kind: "unproven" };
  }
  if (!row || row.command !== identity.command) {
    return { kind: "absent" };
  }
  return row.pgid === row.pid && row.pgid > 1 && row.pgid !== owner.pgid
    ? { kind: "own-group", pgid: row.pgid }
    : { kind: "shared" };
}

/** Host signalling leaf; the executor seam keeps process-group proof tool-free in tests. */
export class HostEmulatorProcessSignaler implements EmulatorProcessSignaler {
  constructor(
    private readonly executor: HostCommandExecutor,
    private readonly timer: Timer,
    private readonly options: { ownPid?: number; platform?: NodeJS.Platform } = {},
  ) {}

  async resolveOwnGroup(
    identity: { pid: number; command: string },
    options: { signal?: AbortSignal; deadlineMs: number },
  ): Promise<EmulatorGroupProbe> {
    const ownPid = this.options.ownPid ?? process.pid;
    if (
      (this.options.platform ?? process.platform) === "win32" ||
      !Number.isSafeInteger(identity.pid) ||
      !isSafeEmulatorProcessPid(identity.pid, ownPid)
    ) {
      return { kind: "unproven" };
    }
    const controller = new AbortController();
    const signal = options.signal
      ? AbortSignal.any([options.signal, controller.signal])
      : controller.signal;
    try {
      const timeoutMs = Math.min(500, options.deadlineMs - this.timer.now());
      if (timeoutMs <= 0) {
        throw new Error("Process group probe deadline already spent");
      }
      const result = await raceWithDeadline(
        () =>
          this.executor.executeCommand(
            "ps",
            ["-o", "pid=", "-o", "pgid=", "-o", "command=", "-p", `${identity.pid},${ownPid}`],
            { signal, timeoutMs },
          ),
        {
          timer: this.timer,
          signal: options.signal,
          timeoutMs,
          label: "Emulator process group",
          onTimeout: () => controller.abort(),
        },
      );
      return provenOwnGroup(parseProcessGroups(result.stdout), identity, ownPid);
    } catch (error) {
      logger.warn(
        `[EmulatorProcessStop] group probe failed for pid ${identity.pid}: ${errorMessage(error)}`,
        error,
      );
      return { kind: "unproven" };
    }
  }

  signal(pid: number, signal: "SIGTERM" | "SIGKILL"): void {
    if (!isSafeEmulatorProcessPid(pid)) {
      throw new ActionableError(`Refusing to signal unsafe emulator pid ${pid}`);
    }
    process.kill(pid, signal);
  }

  signalGroup(pgid: number, signal: "SIGTERM" | "SIGKILL"): void {
    if (!isSafeEmulatorProcessPid(pgid)) {
      throw new ActionableError(`Refusing to signal unsafe emulator group ${pgid}`);
    }
    process.kill(-pgid, signal);
  }

  isRunning(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "ESRCH"
      ) {
        // ESRCH means the process exited, so reporting absence is safe.
        logger.debug(`[EmulatorProcessStop] emulator pid ${pid} exited`);
        return false;
      }
      logger.warn(
        `[EmulatorProcessStop] could not probe emulator pid ${pid}; treating it as running`,
        error,
      );
      return true;
    }
  }
}

const hostStoppers = new WeakMap<Timer, EmulatorProcessStopper>();

/** Build the shared host fallback with injectable command, time, and generation seams. */
export function createHostEmulatorProcessStopper(deps: {
  executor: HostCommandExecutor;
  timer: Timer;
  processGeneration?: LockOwnerGenerationProbe;
  ownPid?: number;
  platform?: NodeJS.Platform;
}): EmulatorProcessStopper {
  const platform = deps.platform ?? process.platform;
  return new ProcessTableEmulatorProcessStopper(
    new ProcessTableReader(deps.executor, {
      timer: deps.timer,
      processTableSupported: platform !== "win32",
      procFs: platform === "linux" ? nodeProcFs : undefined,
    }),
    new HostEmulatorProcessSignaler(deps.executor, deps.timer, {
      ownPid: deps.ownPid,
      platform,
    }),
    deps.timer,
    {
      ownPid: deps.ownPid,
      processGeneration: deps.processGeneration ?? defaultLockOwnerGenerationProbe,
    },
  );
}

/** One fallback per timer; construction is lazy and never starts a command. */
export function getHostEmulatorProcessStopper(timer: Timer = defaultTimer): EmulatorProcessStopper {
  let hostStopper = hostStoppers.get(timer);
  if (!hostStopper) {
    hostStopper = createHostEmulatorProcessStopper({
      executor: new DefaultHostCommandExecutor(),
      timer,
    });
    hostStoppers.set(timer, hostStopper);
  }
  return hostStopper;
}
