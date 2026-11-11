import type { Readable, Writable } from "node:stream";
import { ActionableError } from "../../models/ActionableError";
import {
  DefaultHostCommandExecutor,
  type HostProcessExecutor,
} from "../../utils/HostCommandExecutor";
import { logger } from "../../utils/logger";
import type { Timer } from "../../utils/SystemTimer";
import {
  DHU_CONNECTED_MARKER,
  DHU_FOCUS_VIDEO_COMMAND,
  DHU_PING_TIMEOUT_MARKER,
} from "./androidAutoProjection";

/** The DHU child surface the launcher uses: console on stdin, log on stdout/stderr. */
export interface DhuChildProcess {
  stdin: Writable;
  stdout: Readable;
  stderr: Readable;
  kill(signal?: NodeJS.Signals): boolean;
  once(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): void;
  once(event: "error", listener: (error: Error) => void): void;
}

export type DhuSpawner = (command: string, args: string[]) => DhuChildProcess;

export interface DesktopHeadUnitSession {
  /** Writes one console command (for example `screenshot /tmp/hu.png`). */
  sendCommand(command: string): void;
  isRunning(): boolean;
  stop(): void;
}

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
  | { status: "stalled"; detail: string };

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
}

export const DEFAULT_DHU_LAUNCH_TIMING: DhuLaunchTiming = {
  connectTimeoutMs: 30_000,
  settleMs: 5_000,
  pingTimeoutLimit: 2,
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

function childSession(child: DhuChildProcess): DesktopHeadUnitSession {
  let running = true;
  child.once("exit", () => {
    running = false;
  });
  return {
    sendCommand(command) {
      if (!running) {
        throw new ActionableError(
          `The Desktop Head Unit is not running; cannot send "${command}".`,
        );
      }
      child.stdin.write(`${command}\n`);
    },
    isRunning: () => running,
    stop() {
      if (running) {
        child.kill("SIGTERM");
      }
    },
  };
}

type Phase = "connecting" | "settling" | "done";

/**
 * One launch attempt: wait for `connected.`, then watch a settle window in which an
 * exit or repeated ping timeouts mark the projection as stalled.
 */
function watchLaunch(
  child: DhuChildProcess,
  timer: Timer,
  timing: DhuLaunchTiming,
  signal?: AbortSignal,
): Promise<DhuLaunchOutcome> {
  return new Promise<DhuLaunchOutcome>((resolve) => {
    let phase: Phase = "connecting";
    let pingTimeouts = 0;
    let pending = "";
    let timeout: NodeJS.Timeout | null = null;

    const arm = (ms: number, onTimeout: () => void) => {
      if (timeout) {
        timer.clearTimeout(timeout);
      }
      timeout = timer.setTimeout(onTimeout, ms);
    };
    const finish = (outcome: DhuLaunchOutcome) => {
      if (phase === "done") {
        return;
      }
      phase = "done";
      if (timeout) {
        timer.clearTimeout(timeout);
      }
      resolve(outcome);
    };
    const fail = (status: "no-connect" | "stalled", detail: string) => {
      if (phase !== "done") {
        child.kill("SIGTERM");
        finish({ status, detail });
      }
    };
    const succeed = () => {
      const session = childSession(child);
      session.sendCommand(DHU_FOCUS_VIDEO_COMMAND);
      finish({ status: "connected", session });
    };
    const onLine = (line: string) => {
      logger.debug(`[DHU] ${line}`);
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
    const onData = (chunk: Buffer | string) => {
      const lines = `${pending}${chunk.toString()}`.split(/\r?\n/);
      pending = lines.pop() ?? "";
      lines.forEach(onLine);
    };

    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.once("exit", (code) => {
      const status = phase === "settling" ? "stalled" : "no-connect";
      const tail = pending.trim() ? `: ${pending.trim()}` : "";
      finish({ status, detail: `the DHU exited (code ${code ?? "none"})${tail}` });
    });
    child.once("error", (error) => fail("no-connect", error.message));
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
