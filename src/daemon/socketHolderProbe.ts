import { existsSync } from "node:fs";
import { platform } from "node:os";
import { runExecSeam } from "../utils/ExecSeam";
import { execFileAsync, type ExecFileAsync } from "../utils/HostCommandExecutor";
import { logger } from "../utils/logger";

/**
 * The narrow contract {@link DaemonClient.connect}'s stale-socket recovery depends on
 * for AUTHORITATIVE ownership evidence (issue #6140 P1): unlike the fast, heuristic
 * reachability probe (a handful of connect attempts, which a full accept backlog or a
 * slow accept can make fail even while a live winner owns the socket), this asks the OS
 * directly which live processes hold an open file descriptor on the socket path.
 *
 * The contract distinguishes three outcomes:
 * - a non-empty array: one or more live processes hold the path — a winner owns it.
 * - an empty array: CONFIRMED — no live process holds the path.
 * - `undefined`: ownership could NOT be authoritatively determined (no `lsof`, an
 *   unexpected error, an unsupported platform). Callers MUST treat this the same as
 *   "a live holder exists" for the purpose of gating a destructive unlink — an
 *   inconclusive check is never grounds to unlink.
 */
export interface SocketHolderProbe {
  getHolderPids(socketPath: string): Promise<number[] | undefined>;
}

function textFrom(value: string | Buffer | undefined): string {
  if (typeof value === "string") {
    return value;
  }
  if (Buffer.isBuffer(value)) {
    return value.toString();
  }
  return "";
}

/** Parses `lsof -Fp` output (one `p<pid>` line per matching process) into PIDs. */
export function parseLsofHolderPids(stdout: string): number[] {
  return [
    ...new Set(
      stdout.split("\n").flatMap((line) => {
        const match = line.match(/^p(\d+)$/);
        return match ? [Number.parseInt(match[1], 10)] : [];
      }),
    ),
  ];
}

/**
 * Authoritative socket-ownership probe backed by `lsof`, routed through the shared
 * exec seam (never a fresh raw `execFile`) with `preserveError: true` so the rejected
 * error keeps its real `.code`/`.stdout`/`.stderr` — needed to distinguish `lsof`'s
 * documented "no match" exit (a nonzero exit with BOTH stdout and stderr empty) from a
 * genuine failure (bad path, missing binary, permission denied). `wrapCommandError`'s
 * default behavior would collapse that distinction into a single opaque error message.
 */
export class LsofSocketHolderProbe implements SocketHolderProbe {
  private readonly platform: NodeJS.Platform;

  constructor(
    private readonly execAsync: ExecFileAsync = execFileAsync,
    // Injected so a test can simulate Windows without a real OS switch, mirroring
    // the same `platformOverride` seam already used by `DaemonClient`/`DaemonManager`.
    platformOverride: NodeJS.Platform = platform(),
  ) {
    this.platform = platformOverride;
  }

  async getHolderPids(socketPath: string): Promise<number[] | undefined> {
    if (this.platform === "win32") {
      // No `lsof` on Windows, and a named pipe has no filesystem entry `lsof` could
      // query in the first place — ownership can never be authoritatively
      // established this way there.
      return undefined;
    }
    if (!existsSync(socketPath)) {
      // Nothing can hold a file descriptor on a path that does not exist.
      return [];
    }

    try {
      const { stdout } = await runExecSeam(
        (execOptions) => this.execAsync("lsof", ["-Fp", "--", socketPath], execOptions),
        {},
        { command: "lsof", args: ["-Fp", "--", socketPath] },
        { preserveError: true },
      );
      return parseLsofHolderPids(stdout);
    } catch (error) {
      // Node's execFile-style rejection carries `.code` as the process EXIT CODE
      // (a number) when the process ran but exited nonzero, or a string (e.g.
      // "ENOENT") when the spawn itself failed — `NodeJS.ErrnoException` only
      // models the string-code spawn-failure shape, so it is typed loosely here.
      const err = error as {
        code?: number | string;
        stdout?: string | Buffer;
        stderr?: string | Buffer;
      };
      const stdoutText = textFrom(err.stdout).trim();
      const stderrText = textFrom(err.stderr).trim();
      if (err.code === 1 && !stdoutText && !stderrText) {
        // lsof's documented "no match" exit: given an explicit path argument, it
        // exits 1 with empty stdout AND empty stderr when nothing has it open. This
        // is a CONFIRMED empty result, not a failure.
        return [];
      }
      // Any other shape (lsof missing → ENOENT spawn error, permission denied, an
      // unexpected stderr message) means ownership cannot be authoritatively
      // confirmed — the caller must treat this the same as "a live holder exists".
      logger.debug(
        `[DaemonClient] lsof socket-holder probe inconclusive for ${socketPath}: ${error}`,
        error,
      );
      return undefined;
    }
  }
}
