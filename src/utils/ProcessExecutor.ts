import { execFile, spawn, type ChildProcess, type SpawnOptions } from "child_process";
import process from "node:process";
import { promisify } from "util";
import type { ExecResult } from "../models";
import { runExecSeam, type ExecRequestOptions, type ExecSeamOptions, type RawExecOutput } from "./ExecSeam";

export type ProcessExecOptions = ExecRequestOptions;

export interface ProcessExecutor {
  exec(command: string, options?: ProcessExecOptions): Promise<ExecResult>;
  spawn(command: string, args: string[], options?: SpawnOptions): ChildProcess;
}

export type ExecAsync = (
  command: string,
  options?: ExecSeamOptions
) => Promise<RawExecOutput>;

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
  // Intentionally shell-based: existing callers rely on pipes, redirects,
  // and compound commands. Use HostCommandExecutor for argv-safe execution.
  // codeql[js/shell-command-injection-from-environment] This is the legacy shell executor; argv-safe callers use HostCommandExecutor.
  // codeql[js/indirect-command-line-injection] This is the legacy shell executor; argv-safe callers use HostCommandExecutor.
  const { stdout, stderr } = await execFileAsync(shellCommand.file, shellCommand.args, options);
  return { stdout, stderr };
};

export class DefaultProcessExecutor implements ProcessExecutor {
  private execAsync: ExecAsync;

  // The exec seam is injectable so tests can exercise the ExecResult helpers and
  // error-context formatting against a fake instead of spawning a real subprocess,
  // which stalls past the timeout on contended CI runners (#2914).
  constructor(execAsyncFn: ExecAsync = execAsync) {
    this.execAsync = execAsyncFn;
  }

  async exec(command: string, options: ProcessExecOptions = {}): Promise<ExecResult> {
    return runExecSeam(
      execOptions => this.execAsync(command, execOptions),
      options,
      { command, cwd: options.cwd }
    );
  }

  spawn(command: string, args: string[], options?: SpawnOptions): ChildProcess {
    return spawn(command, args, options);
  }
}
