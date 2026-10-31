import { logger } from "../../utils/logger";
import { Timer, defaultTimer } from "../../utils/SystemTimer";
import { raceWithDeadline } from "../../utils/raceWithDeadline";
import { IosCtrlProxyProcessClient } from "./IosCtrlProxyProcessClient";
import {
  MAX_STARTUP_ORPHAN_RUNNER_CANDIDATES,
  STARTUP_ORPHAN_RUNNER_REAP_DEADLINE_MS,
  ListeningProcess,
  DaemonManagedRunnerTreeRoot,
  DaemonManagedRunnerParentRoot,
  IOS_CTRL_PROXY_DEFAULT_PORT,
} from "./IosCtrlProxyContracts";

export class IosCtrlProxyOrphanReaper {
  /**
   * Best-effort startup sweep for orphaned CtrlProxy iOS runner processes left
   * behind by a previously crashed daemon.
   */
  public static async reapOrphanedRunnerProcessesOnStartup(
    processClient: IosCtrlProxyProcessClient = new IosCtrlProxyProcessClient(),
    timer: Timer = defaultTimer,
  ): Promise<void> {
    const deadline = timer.now() + STARTUP_ORPHAN_RUNNER_REAP_DEADLINE_MS;
    let pids: number[] = [];
    try {
      pids = await processClient.findStartupCandidatePids(deadline);
    } catch (error) {
      logger.debug(
        `[IOSCtrlProxy] Failed to enumerate CtrlProxy iOS processes during startup sweep: ${error}`,
      );
      return;
    }

    const reapedRootPids = new Set<number>();
    for (const pid of pids) {
      if (timer.now() >= deadline) {
        IosCtrlProxyOrphanReaper.logStartupOrphanRunnerReapDeadline();
        return;
      }
      try {
        if (
          !(await IosCtrlProxyOrphanReaper.reapStartupOrphanRunnerCandidate(
            processClient,
            pid,
            deadline,
            { timer, reapedRootPids },
          ))
        ) {
          return;
        }
      } catch (error) {
        logger.debug(
          `[IOSCtrlProxy] Failed to reap orphaned CtrlProxy iOS process ${pid}: ${error}`,
        );
        if (timer.now() >= deadline) {
          IosCtrlProxyOrphanReaper.logStartupOrphanRunnerReapDeadline();
          return;
        }
      }
    }
  }

  static async reapStartupOrphanRunnerCandidate(
    processClient: IosCtrlProxyProcessClient,
    pid: number,
    deadline: number,
    { timer, reapedRootPids }: { timer: Timer; reapedRootPids: Set<number> },
  ): Promise<boolean> {
    const root = await IosCtrlProxyOrphanReaper.findStartupOrphanRunnerRoot(
      processClient,
      pid,
      deadline,
      timer,
    );
    if (root.kind === "deadline_exhausted" || timer.now() >= deadline) {
      IosCtrlProxyOrphanReaper.logStartupOrphanRunnerReapDeadline();
      return false;
    }
    if (root.kind !== "root" || reapedRootPids.has(root.pid)) {
      return true;
    }
    if (reapedRootPids.size >= MAX_STARTUP_ORPHAN_RUNNER_CANDIDATES) {
      logger.warn(
        `[IOSCtrlProxy] startup sweep skipped 1 startup CtrlProxy runner candidate after ` +
          `reaching the ${MAX_STARTUP_ORPHAN_RUNNER_CANDIDATES}-candidate cap`,
      );
      return false;
    }
    reapedRootPids.add(root.pid);
    logger.info(`[IOSCtrlProxy] Reaping orphaned CtrlProxy iOS process tree rooted at ${root.pid}`);
    await processClient.terminateProcessTree(root.pid, deadline);
    if (timer.now() >= deadline) {
      IosCtrlProxyOrphanReaper.logStartupOrphanRunnerReapDeadline();
      return false;
    }
    return true;
  }

  static async findStartupOrphanRunnerRoot(
    processClient: IosCtrlProxyProcessClient,
    pid: number,
    deadline: number,
    timer: Timer,
  ): Promise<DaemonManagedRunnerTreeRoot> {
    const processInfo = await processClient.getProcessInfo(pid, deadline);
    if (!processInfo || !processClient.isCtrlProxyRunnerCommand(processInfo.command)) {
      return { kind: "not_daemon_managed" };
    }
    return IosCtrlProxyOrphanReaper.findDaemonManagedRunnerTreeRoot(
      processClient,
      {
        pid,
        port: IOS_CTRL_PROXY_DEFAULT_PORT,
        command: processInfo.command,
        environment: processInfo.environment,
        ppid: processInfo.ppid,
      },
      {
        requireOrphanedRoot: true,
        shouldContinue: () => timer.now() < deadline,
        deadline,
      },
    );
  }

  static async findDaemonManagedRunnerTreeRoot(
    processClient: IosCtrlProxyProcessClient,
    process: ListeningProcess,
    options: {
      requireOrphanedRoot?: boolean;
      shouldContinue?: () => boolean;
      deadline?: number;
    } = {},
  ): Promise<DaemonManagedRunnerTreeRoot> {
    if (!processClient.isCtrlProxyRunnerCommand(process.command)) {
      return { kind: "not_daemon_managed" };
    }

    let rootPid = process.ppid === 1 ? process.pid : null;
    let parentPid = process.ppid;
    const visitedPids = new Set<number>([process.pid]);

    if (IosCtrlProxyProcessClient.isDaemonManagedSimulatorXcodebuildCommandShape(process.command)) {
      rootPid = IosCtrlProxyOrphanReaper.rootPidForDaemonManagedProcess(
        process.pid,
        process.ppid,
        options.requireOrphanedRoot,
      );
    }

    while (parentPid !== undefined && parentPid > 1 && !visitedPids.has(parentPid)) {
      if (!IosCtrlProxyOrphanReaper.shouldContinueStartupOrphanRunnerTraversal(options)) {
        return { kind: "deadline_exhausted" };
      }
      visitedPids.add(parentPid);
      const parentInfo = await processClient.getProcessInfo(parentPid, options.deadline);
      if (!parentInfo) {
        break;
      }

      const parentRoot = IosCtrlProxyOrphanReaper.daemonManagedParentRoot(
        parentInfo,
        parentPid,
        options.requireOrphanedRoot,
      );
      if (parentRoot) {
        if (parentRoot.terminal) {
          return IosCtrlProxyOrphanReaper.toDaemonManagedRunnerTreeRoot(parentRoot.rootPid);
        }
        rootPid = parentRoot.rootPid;
      }

      parentPid = parentInfo.ppid;
    }

    return IosCtrlProxyOrphanReaper.toDaemonManagedRunnerTreeRoot(rootPid);
  }

  static async completeWithinStartupReapDeadline(work: Promise<void>, timer: Timer): Promise<void> {
    const timedOut = Symbol("startup runner reap timeout");
    try {
      await raceWithDeadline(work, {
        timer,
        timeoutMs: STARTUP_ORPHAN_RUNNER_REAP_DEADLINE_MS,
        unref: true,
        label: "Startup runner reap",
        timeoutError: () => timedOut,
      });
    } catch (error) {
      if (error !== timedOut) {
        throw error;
      }
      IosCtrlProxyOrphanReaper.logStartupOrphanRunnerReapDeadline();
    }
  }

  static logStartupOrphanRunnerReapDeadline(): void {
    logger.warn(
      `[IOSCtrlProxy] startup CtrlProxy runner sweep timed out after ${STARTUP_ORPHAN_RUNNER_REAP_DEADLINE_MS}ms`,
    );
  }

  static shouldContinueStartupOrphanRunnerTraversal(options: {
    shouldContinue?: () => boolean;
  }): boolean {
    return options.shouldContinue?.() ?? true;
  }

  static daemonManagedParentRoot(
    process: { command: string; ppid?: number },
    pid: number,
    requireOrphanedRoot: boolean | undefined,
  ): DaemonManagedRunnerParentRoot | null {
    if (
      !IosCtrlProxyProcessClient.isDaemonManagedSimulatorXcodebuildCommandShape(process.command)
    ) {
      return null;
    }
    return {
      rootPid: IosCtrlProxyOrphanReaper.rootPidForDaemonManagedProcess(
        pid,
        process.ppid,
        requireOrphanedRoot,
      ),
      terminal: IosCtrlProxyProcessClient.isShellCommand(process.command),
    };
  }

  static rootPidForDaemonManagedProcess(
    pid: number,
    ppid: number | undefined,
    requireOrphanedRoot: boolean | undefined,
  ): number | null {
    return requireOrphanedRoot && ppid !== 1 ? null : pid;
  }

  static toDaemonManagedRunnerTreeRoot(rootPid: number | null): DaemonManagedRunnerTreeRoot {
    return rootPid === null ? { kind: "not_daemon_managed" } : { kind: "root", pid: rootPid };
  }
}
