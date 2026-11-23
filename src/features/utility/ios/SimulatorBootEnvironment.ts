import {
  DefaultHostCommandExecutor,
  type HostCommandExecutor,
} from "../../../utils/HostCommandExecutor";

/**
 * Reads what a simulator's launchd_sim inherited at boot (`simctl boot` with `SIMCTL_CHILD_*`).
 * `launchctl getenv` inside the simulator does not show those values, and launchd keeps them over
 * a later `launchctl setenv`, so the only reliable source is launchd_sim's own environment, which
 * the host can read because the simulator runs as the same user.
 */
export interface SimulatorBootEnvironment {
  /** "" when the simulator was booted without `DYLD_INSERT_LIBRARIES` (or is not running). */
  dyldInsertLibraries(udid: string, signal?: AbortSignal): Promise<string>;
}

const PS_OPTIONS = { timeoutMs: 10_000, maxBuffer: 32 * 1024 * 1024 } as const;

/** One `ps` row: `<pid> <command>`, or for `ps -E`, the command with its environment appended. */
export function findLaunchdSimPid(psOutput: string, udid: string): string | undefined {
  for (const line of psOutput.split("\n")) {
    const match = /^\s*(\d+)\s+(.*)$/.exec(line);
    if (match && /(^|\/)launchd_sim(\s|$)/.test(match[2]!) && match[2]!.includes(`/${udid}/`)) {
      return match[1];
    }
  }
  return undefined;
}

/**
 * `ps -E` separates variables with spaces, so a value runs until the next ` NAME=`. A path that
 * itself contains ` NAME=` would be cut short; simulator library paths do not.
 */
export function parseDyldInsertLibraries(psEnvironmentOutput: string): string {
  const match = /(?:^|\s)DYLD_INSERT_LIBRARIES=(.*?)(?=\s[A-Za-z_][A-Za-z0-9_]*=|\s*$)/m.exec(
    psEnvironmentOutput,
  );
  return match?.[1]?.trim() ?? "";
}

export class PsSimulatorBootEnvironment implements SimulatorBootEnvironment {
  constructor(private readonly host: HostCommandExecutor = new DefaultHostCommandExecutor()) {}

  async dyldInsertLibraries(udid: string, signal?: AbortSignal): Promise<string> {
    const processes = await this.host.executeCommand("ps", ["-axww", "-o", "pid=,command="], {
      ...PS_OPTIONS,
      signal,
    });
    const pid = findLaunchdSimPid(processes.stdout, udid);
    if (!pid) {
      return "";
    }
    const environment = await this.host.executeCommand(
      "ps",
      ["-E", "-ww", "-o", "command=", "-p", pid],
      { ...PS_OPTIONS, signal },
    );
    return parseDyldInsertLibraries(environment.stdout);
  }
}

export const defaultSimulatorBootEnvironment: SimulatorBootEnvironment =
  new PsSimulatorBootEnvironment();
