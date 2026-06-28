import { execFile, spawn, type ChildProcess, type SpawnOptions } from "child_process";
import process from "node:process";
import { promisify } from "util";
import type { ExecResult } from "../models";
import { wrapCommandError } from "./CommandError";

export interface ProcessExecOptions {
  timeoutMs?: number;
  maxBuffer?: number;
  cwd?: string;
}

export interface ProcessExecutor {
  exec(command: string, options?: ProcessExecOptions): Promise<ExecResult>;
  spawn(command: string, args: string[], options?: SpawnOptions): ChildProcess;
}

type ExecAsync = (
  command: string,
  options?: {
    timeout?: number;
    maxBuffer?: number;
    cwd?: string;
  }
) => Promise<{ stdout: string | Buffer; stderr: string | Buffer }>;

const execFileAsync = promisify(execFile);

export function shellCommandForPlatform(
  command: string,
  platform: NodeJS.Platform = process.platform
): { file: string; args: string[] } {
  if (platform === "win32") {
    return { file: "cmd.exe", args: ["/d", "/s", "/c", command] };
  }
  return { file: "/bin/sh", args: ["-c", command] };
}

const execAsync: ExecAsync = async (command, options) => {
  const shellCommand = shellCommandForPlatform(command);
  const { stdout, stderr } = await execFileAsync(shellCommand.file, shellCommand.args, options);
  return { stdout, stderr };
};

const createExecResult = (stdout: string | Buffer, stderr: string | Buffer): ExecResult => {
  const stdoutText = typeof stdout === "string" ? stdout : stdout.toString();
  const stderrText = typeof stderr === "string" ? stderr : stderr.toString();
  return {
    stdout: stdoutText,
    stderr: stderrText,
    toString() { return stdoutText; },
    trim() { return stdoutText.trim(); },
    includes(searchString: string) { return stdoutText.includes(searchString); }
  };
};

export class DefaultProcessExecutor implements ProcessExecutor {
  async exec(command: string, options: ProcessExecOptions = {}): Promise<ExecResult> {
    try {
      // Intentionally shell-based: existing callers rely on pipes, redirects,
      // and compound commands. Use HostCommandExecutor for argv-safe execution.
      // codeql[js/shell-command-injection-from-environment] This is the legacy shell executor; argv-safe callers use HostCommandExecutor.
      // codeql[js/indirect-command-line-injection] This is the legacy shell executor; argv-safe callers use HostCommandExecutor.
      const { stdout, stderr } = await execAsync(command, {
        timeout: options.timeoutMs,
        maxBuffer: options.maxBuffer,
        cwd: options.cwd
      });
      return createExecResult(stdout, stderr);
    } catch (error) {
      throw wrapCommandError(error, {
        command,
        cwd: options.cwd,
      });
    }
  }

  spawn(command: string, args: string[], options?: SpawnOptions): ChildProcess {
    return spawn(command, args, options);
  }
}
