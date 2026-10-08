import * as fs from "node:fs/promises";
import { runExecSeam } from "../../utils/ExecSeam";
import { execFileAsync } from "../../utils/HostCommandExecutor";
import { logger } from "../../utils/logger";
import { errorMessage } from "../../utils/describeUnknownError";

/**
 * Host seams for the opt-in Network Extension installer (#10588). Every
 * host-mutating or process-spawning step goes through one of these narrow
 * interfaces so unit tests run against in-memory fakes and never touch
 * `/Applications`, `codesign`, `ditto` or the controller.
 */

/** Outcome of one argv-only command. Never throws for a non-zero exit. */
export interface NetworkFilterCommandOutcome {
  exitCode: number;
  stdout: string;
  stderr: string;
  /** True when the command was killed by the timeout. */
  timedOut: boolean;
}

export interface NetworkFilterCommandRunner {
  run(
    file: string,
    args: readonly string[],
    options?: { timeoutMs?: number },
  ): Promise<NetworkFilterCommandOutcome>;
}

/** Exit code reported when the executable itself could not be started. */
export const COMMAND_NOT_STARTED_EXIT_CODE = 127;

export class DefaultNetworkFilterCommandRunner implements NetworkFilterCommandRunner {
  async run(
    file: string,
    args: readonly string[],
    options: { timeoutMs?: number } = {},
  ): Promise<NetworkFilterCommandOutcome> {
    try {
      const result = await runExecSeam(
        (execOptions) => execFileAsync(file, [...args], execOptions),
        { timeoutMs: options.timeoutMs, maxBuffer: 16 * 1024 * 1024, killSignal: "SIGKILL" },
        { command: file, args: [...args] },
        { preserveError: true },
      );
      return { exitCode: 0, stdout: result.stdout, stderr: result.stderr, timedOut: false };
    } catch (error) {
      // Non-zero exits are structured outcomes here; callers map them to states.
      const failure = error as {
        code?: unknown;
        killed?: unknown;
        signal?: unknown;
        stdout?: unknown;
        stderr?: unknown;
      };
      logger.debug(`[NETWORK_FILTER] ${file} exited unsuccessfully: ${errorMessage(error)}`);
      return {
        exitCode: typeof failure.code === "number" ? failure.code : COMMAND_NOT_STARTED_EXIT_CODE,
        stdout: String(failure.stdout ?? ""),
        stderr: String(failure.stderr ?? (typeof failure.code === "string" ? failure.code : "")),
        timedOut: failure.killed === true && failure.signal === "SIGKILL",
      };
    }
  }
}

/** The filesystem operations the provider and status inspector need. */
export interface NetworkFilterFileSystem {
  isDirectory(path: string): Promise<boolean>;
  isFile(path: string): Promise<boolean>;
  /** File contents, or null when the file is missing or unreadable. */
  readText(path: string): Promise<string | null>;
  writeText(path: string, content: string): Promise<void>;
  ensureDir(path: string): Promise<void>;
  /** Recursive, forced removal; a missing path is not an error. */
  remove(path: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
}

const SECURE_DIR_MODE = 0o700;
const SECURE_FILE_MODE = 0o600;

async function statKind(path: string): Promise<"file" | "directory" | null> {
  try {
    const stats = await fs.stat(path);
    if (stats.isDirectory()) {
      return "directory";
    }
    return stats.isFile() ? "file" : null;
  } catch (error) {
    // A missing path is the expected "not installed / not cached" answer.
    logger.debug(`[NETWORK_FILTER] ${path} is not statable: ${errorMessage(error)}`);
    return null;
  }
}

export class NodeNetworkFilterFileSystem implements NetworkFilterFileSystem {
  async isDirectory(path: string): Promise<boolean> {
    return (await statKind(path)) === "directory";
  }

  async isFile(path: string): Promise<boolean> {
    return (await statKind(path)) === "file";
  }

  async readText(path: string): Promise<string | null> {
    try {
      return await fs.readFile(path, "utf8");
    } catch (error) {
      // Missing metadata/receipts are expected before the first download or install.
      logger.debug(`[NETWORK_FILTER] ${path} is not readable: ${errorMessage(error)}`);
      return null;
    }
  }

  async writeText(path: string, content: string): Promise<void> {
    await fs.writeFile(path, content, { encoding: "utf8", mode: SECURE_FILE_MODE });
  }

  async ensureDir(path: string): Promise<void> {
    await fs.mkdir(path, { recursive: true, mode: SECURE_DIR_MODE });
  }

  async remove(path: string): Promise<void> {
    await fs.rm(path, { recursive: true, force: true });
  }

  async rename(from: string, to: string): Promise<void> {
    await fs.rename(from, to);
  }
}
