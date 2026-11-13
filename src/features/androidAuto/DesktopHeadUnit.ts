import type { Readable, Writable } from "node:stream";
import { ActionableError } from "../../models/ActionableError";
import {
  DefaultHostCommandExecutor,
  type HostProcessExecutor,
} from "../../utils/HostCommandExecutor";
import { errorMessage } from "../../utils/describeUnknownError";
import { logger } from "../../utils/logger";
import type { Timer } from "../../utils/SystemTimer";
import {
  DHU_CONNECTED_MARKER,
  DHU_FOCUS_VIDEO_COMMAND,
  DHU_NO_VIDEO_FOCUS_MARKER,
  DHU_PING_TIMEOUT_MARKER,
} from "./androidAutoProjection";

/** The DHU child surface the launcher uses: console on stdin, log on stdout/stderr. */
export interface DhuChildProcess {
  stdin: Writable;
  stdout: Readable;
  stderr: Readable;
  /** Undefined when the spawn itself failed, so there is no process to signal or wait for. */
  readonly pid?: number;
  kill(signal?: NodeJS.Signals): boolean;
  once(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): void;
  once(event: "error", listener: (error: Error) => void): void;
  on(event: "error", listener: (error: Error) => void): void;
}

export type DhuSpawner = (command: string, args: string[]) => DhuChildProcess;

export interface DesktopHeadUnitSession {
  /** Writes one console command (for example `screenshot /tmp/hu.png`). */
  sendCommand(command: string): void;
  isRunning(): boolean;
  /**
   * True until the DHU process exits, healthy or not. A live but unhealthy DHU still dials
   * host port 5277, so it blocks another projection until `stop()` resolves.
   */
  isAlive(): boolean;
  /**
   * False once the DHU printed that it has no video focus, until a `focus video` command is sent
   * again. Absent when the session cannot tell, so callers treat focus as possible.
   */
  hasVideoFocus?(): boolean;
  /**
   * Ends the DHU and resolves once its process exited: SIGTERM, then SIGKILL after
   * `stopTimeoutMs`. Rejects when the process still has not exited, so a caller never
   * launches a replacement next to a live DHU.
   */
  stop(): Promise<void>;
}

/** Which DHU process a console writes to, and the config it started with. */
export interface HeadUnitPanel {
  /** Distinct for each DHU process this daemon started. */
  instance: string;
  configPath?: string;
}

/** The part of a DHU session an action may use: write console commands, never start or stop it. */
export type DesktopHeadUnitConsole = Pick<
  DesktopHeadUnitSession,
  "sendCommand" | "isRunning" | "hasVideoFocus"
> & {
  /** Absent when the caller cannot tell which DHU process this is. */
  panel?: HeadUnitPanel;
};

export interface DhuLaunchOptions {
  binaryPath: string;
  configPath: string;
  signal?: AbortSignal;
}

export type DhuLaunchOutcome =
  | { status: "connected"; session: DesktopHeadUnitSession }
  /** No `connected.` line before the connect timeout. */
  | { status: "no-connect"; detail: string }
  /** The DHU exited, or kept reporting ping timeouts, after it connected. */
  | { status: "stalled"; detail: string }
  /**
   * The attempt failed and its DHU survived SIGTERM and SIGKILL. `session` still owns that
   * process (unhealthy, alive) so a caller can keep it counted as holding host port 5277 and
   * retry `session.stop()` later.
   */
  | { status: "unkillable"; detail: string; session: DesktopHeadUnitSession };

export interface DesktopHeadUnitLauncher {
  launch(options: DhuLaunchOptions): Promise<DhuLaunchOutcome>;
}

export interface DhuLaunchTiming {
  /** How long to wait for `connected.` after the spawn. */
  connectTimeoutMs: number;
  /** How long a connection must hold, without exiting or repeated ping timeouts, to count. */
  settleMs: number;
  /** Ping timeouts within the settle window that mark the projection as stalled. */
  pingTimeoutLimit: number;
  /** How long `stop()` waits for the process to exit after each signal. */
  stopTimeoutMs: number;
}

export const DEFAULT_DHU_LAUNCH_TIMING: DhuLaunchTiming = {
  connectTimeoutMs: 30_000,
  settleMs: 5_000,
  pingTimeoutLimit: 2,
  stopTimeoutMs: 5_000,
};

const hostProcessExecutor = new DefaultHostCommandExecutor();

type ConsoleChild = ReturnType<HostProcessExecutor["spawn"]> & {
  stdin: Writable;
  stdout: Readable;
  stderr: Readable;
};

function hasConsolePipes(child: ReturnType<HostProcessExecutor["spawn"]>): child is ConsoleChild {
  return child.stdin !== null && child.stdout !== null && child.stderr !== null;
}

export const createDefaultDhuSpawner =
  (executor: Pick<HostProcessExecutor, "spawn"> = hostProcessExecutor): DhuSpawner =>
  (command, args) => {
    const child = executor.spawn(command, args, { stdio: ["pipe", "pipe", "pipe"] });
    if (!hasConsolePipes(child)) {
      child.kill();
      throw new ActionableError(`Failed to open the console pipes for ${command}`);
    }
    return child;
  };

interface ChildSession {
  session: DesktopHeadUnitSession;
  /** Writes one console command and settles once the pipe accepted or rejected it. */
  write(command: string): Promise<void>;
  /** Reads one DHU output line for session state (video focus). */
  observeLine(line: string): void;
}

/**
 * Owns the child's lifetime state. Its `error` listeners on the process and on stdin are
 * attached before the first write, so an EPIPE from a DHU that closed its console is
 * handled (it marks the session not running) instead of crashing the host process.
 *
 * Health and process lifetime are tracked apart: an error makes the session unusable but
 * does not end the process, so `stop()` kills whenever the child has not exited. Otherwise
 * a DHU that is still running would be orphaned and hold the head unit connection.
 */
function childSession(child: DhuChildProcess, timer: Timer, stopTimeoutMs: number): ChildSession {
  let healthy = true;
  let exited = false;
  // A headless DHU starts without video focus; the launcher's `focus video` write grants it.
  let videoFocus = false;
  const noteCommand = (command: string) => {
    // `focus video toggle` may also remove focus; the next refused capture reports that.
    if (command.startsWith(DHU_FOCUS_VIDEO_COMMAND)) {
      videoFocus = true;
    }
  };
  const exitWaiters = new Set<() => void>();
  const markExited = () => {
    exited = true;
    healthy = false;
    exitWaiters.forEach((notify) => notify());
    exitWaiters.clear();
  };
  child.once("exit", markExited);
  const waitForExit = (ms: number) =>
    new Promise<boolean>((resolve) => {
      if (exited) {
        resolve(true);
        return;
      }
      const onExit = () => {
        timer.clearTimeout(timeout);
        resolve(true);
      };
      const timeout = timer.setTimeout(() => {
        exitWaiters.delete(onExit);
        resolve(false);
      }, ms);
      exitWaiters.add(onExit);
    });
  const terminate = (signal: NodeJS.Signals): Promise<boolean> => {
    if (!exited) {
      child.kill(signal);
    }
    return waitForExit(stopTimeoutMs);
  };
  child.on("error", (error) => {
    logger.warn(`[DHU] process error: ${error.message}`);
    healthy = false;
    // A failed spawn has no pid and may never emit `exit`: no process exists to wait for.
    if (child.pid === undefined) {
      markExited();
    }
  });
  child.stdin.on("error", (error) => {
    logger.warn(`[DHU] console write failed: ${error.message}`);
    healthy = false;
  });
  const isRunning = () => healthy && !exited;
  const assertRunning = (command: string) => {
    if (!isRunning()) {
      throw new ActionableError(`The Desktop Head Unit is not running; cannot send "${command}".`);
    }
  };
  return {
    session: {
      sendCommand(command) {
        assertRunning(command);
        child.stdin.write(`${command}\n`);
        noteCommand(command);
      },
      isRunning,
      isAlive: () => !exited,
      hasVideoFocus: () => videoFocus,
      async stop() {
        healthy = false;
        if ((await terminate("SIGTERM")) || (await terminate("SIGKILL"))) {
          return;
        }
        throw new ActionableError(
          `The Desktop Head Unit did not exit within ${stopTimeoutMs} ms of SIGTERM and again of SIGKILL. End the desktop-head-unit process before retrying, or a relaunch would compete with it for the head unit connection.`,
        );
      },
    },
    write(command) {
      return new Promise<void>((resolve, reject) => {
        assertRunning(command);
        child.stdin.write(`${command}\n`, (error) => {
          if (error) {
            reject(error);
            return;
          }
          noteCommand(command);
          resolve();
        });
      });
    },
    observeLine(line) {
      if (line.includes(DHU_NO_VIDEO_FOCUS_MARKER)) {
        videoFocus = false;
      }
    },
  };
}

type Phase = "connecting" | "settling" | "done";

/**
 * One launch attempt: wait for `connected.`, then watch a settle window in which an
 * exit or repeated ping timeouts mark the projection as stalled. A failed attempt settles
 * only once its DHU exited (the session's bounded SIGTERM-then-SIGKILL stop), so a relaunch
 * never races the old process for host port 5277. When the DHU never exits it settles as
 * `unkillable` with the session that still owns the process.
 */
function watchLaunch(
  child: DhuChildProcess,
  timer: Timer,
  timing: DhuLaunchTiming,
  signal?: AbortSignal,
): Promise<DhuLaunchOutcome> {
  return new Promise<DhuLaunchOutcome>((resolve) => {
    const dhuConsole = childSession(child, timer, timing.stopTimeoutMs);
    let phase: Phase = "connecting";
    let pingTimeouts = 0;
    // One partial-line buffer per stream, so interleaved stdout/stderr chunks never splice a line.
    const pending = { stdout: "", stderr: "" };
    let timeout: NodeJS.Timeout | null = null;

    const arm = (ms: number, onTimeout: () => void) => {
      if (timeout) {
        timer.clearTimeout(timeout);
      }
      timeout = timer.setTimeout(onTimeout, ms);
    };
    /** Claims the attempt's single outcome; false when another path already claimed it. */
    const settle = (): boolean => {
      if (phase === "done") {
        return false;
      }
      phase = "done";
      if (timeout) {
        timer.clearTimeout(timeout);
      }
      return true;
    };
    const finish = (outcome: DhuLaunchOutcome) => {
      if (settle()) {
        resolve(outcome);
      }
    };
    const fail = (status: "no-connect" | "stalled", detail: string) => {
      // Settle first: a synchronous exit from the kill must not replace this reason.
      if (settle()) {
        dhuConsole.session.stop().then(
          () => resolve({ status, detail }),
          (error: unknown) =>
            resolve({
              status: "unkillable",
              detail: `${status}: ${detail}; ${errorMessage(error)}`,
              session: dhuConsole.session,
            }),
        );
      }
    };
    // Connected only once the pipe accepted `focus video`; a closed console is a stalled start.
    const succeed = () => {
      dhuConsole.write(DHU_FOCUS_VIDEO_COMMAND).then(
        () =>
          dhuConsole.session.isRunning()
            ? finish({ status: "connected", session: dhuConsole.session })
            : fail("stalled", `the DHU stopped before "${DHU_FOCUS_VIDEO_COMMAND}" was confirmed`),
        (error: unknown) =>
          fail(
            "stalled",
            `the DHU console rejected "${DHU_FOCUS_VIDEO_COMMAND}" (${errorMessage(error)}); it likely closed its stdin`,
          ),
      );
    };
    const onLine = (line: string) => {
      logger.debug(`[DHU] ${line}`);
      dhuConsole.observeLine(line);
      if (phase === "connecting" && line.includes(DHU_CONNECTED_MARKER)) {
        phase = "settling";
        arm(timing.settleMs, succeed);
      } else if (phase === "settling" && line.includes(DHU_PING_TIMEOUT_MARKER)) {
        pingTimeouts++;
        if (pingTimeouts >= timing.pingTimeoutLimit) {
          fail("stalled", `${pingTimeouts} "${DHU_PING_TIMEOUT_MARKER}" lines after connecting`);
        }
      }
    };
    const onData = (stream: keyof typeof pending) => (chunk: Buffer | string) => {
      const lines = `${pending[stream]}${chunk.toString()}`.split(/\r?\n/);
      pending[stream] = lines.pop() ?? "";
      lines.forEach(onLine);
    };

    child.stdout.on("data", onData("stdout"));
    child.stderr.on("data", onData("stderr"));
    child.once("exit", (code) => {
      const status = phase === "settling" ? "stalled" : "no-connect";
      const last = `${pending.stdout} ${pending.stderr}`.trim();
      const tail = last ? `: ${last}` : "";
      finish({ status, detail: `the DHU exited (code ${code ?? "none"})${tail}` });
    });
    child.once("error", (error) =>
      fail(phase === "settling" ? "stalled" : "no-connect", error.message),
    );
    signal?.addEventListener("abort", () => fail("no-connect", "launch aborted"), { once: true });
    arm(timing.connectTimeoutMs, () =>
      fail("no-connect", `no "${DHU_CONNECTED_MARKER}" within ${timing.connectTimeoutMs} ms`),
    );
  });
}

/** Starts `desktop-head-unit --headless -c <config>` and gives it video focus once it holds a connection. */
export class SpawningDesktopHeadUnitLauncher implements DesktopHeadUnitLauncher {
  constructor(
    private readonly spawn: DhuSpawner,
    private readonly timer: Timer,
    private readonly timing: DhuLaunchTiming = DEFAULT_DHU_LAUNCH_TIMING,
  ) {}

  launch(options: DhuLaunchOptions): Promise<DhuLaunchOutcome> {
    options.signal?.throwIfAborted();
    const child = this.spawn(options.binaryPath, ["--headless", "-c", options.configPath]);
    return watchLaunch(child, this.timer, this.timing, options.signal);
  }
}
