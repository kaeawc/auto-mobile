import type { ChildProcess, SpawnOptions } from "child_process";
import type { ExecResult } from "../../src/models";
import type {
  HostCommandOptions,
  HostProcessExecutor,
  StartedHostCommand,
} from "../../src/utils/HostCommandExecutor";
import { wrapCommandError } from "../../src/utils/CommandError";
import { FakeChildProcess } from "./FakeChildProcess";

/**
 * Fake ProcessExecutor for testing command execution and process spawning.
 */
export class FakeProcessExecutor implements HostProcessExecutor {
  private commandResponses: Map<string, ExecResult> = new Map();
  private commandHandlers: Array<{
    pattern: string;
    handler: (command: string) => ExecResult | Promise<ExecResult>;
  }> = [];
  private defaultResponse: ExecResult = this.createExecResult("", "");
  private commandErrors: Array<{ pattern: string; error: Error }> = [];
  private executedCommands: string[] = [];
  private executedArgv: Array<{ file: string; args: string[] }> = [];
  private spawnResponses: Array<{
    command: string;
    args: string[];
    options?: SpawnOptions;
    process: ChildProcess;
  }> = [];
  private nextSpawnProcess: ChildProcess | null = null;

  setCommandResponse(commandPattern: string, response: ExecResult): void {
    this.commandResponses.set(commandPattern, this.ensureExecResultMethods(response));
  }

  setCommandHandler(
    commandPattern: string,
    handler: (command: string) => ExecResult | Promise<ExecResult>,
  ): void {
    this.commandHandlers.push({ pattern: commandPattern, handler });
  }

  /** Makes matching commands fail the way a non-zero exit does for the real executor. */
  setCommandError(commandPattern: string, error: Error): void {
    this.commandErrors.push({ pattern: commandPattern, error });
  }

  setDefaultResponse(response: ExecResult): void {
    this.defaultResponse = this.ensureExecResultMethods(response);
  }

  getExecutedCommands(): string[] {
    return [...this.executedCommands];
  }

  /** The exact file and argv of each executeCommand call, unlike the rendered command strings. */
  getExecutedArgv(): Array<{ file: string; args: string[] }> {
    return this.executedArgv.map(({ file, args }) => ({ file, args: [...args] }));
  }

  wasCommandExecuted(pattern: string): boolean {
    return this.executedCommands.some((command) => command.includes(pattern));
  }

  setNextSpawnProcess(process: ChildProcess): void {
    this.nextSpawnProcess = process;
  }

  getSpawnedProcesses(): Array<{
    command: string;
    args: string[];
    options?: SpawnOptions;
    process: ChildProcess;
  }> {
    return [...this.spawnResponses];
  }

  async exec(command: string, _options?: HostCommandOptions): Promise<ExecResult> {
    this.executedCommands.push(command);
    for (const { pattern, handler } of this.commandHandlers) {
      if (command.includes(pattern)) {
        return this.ensureExecResultMethods(await handler(command));
      }
    }
    for (const [pattern, response] of this.commandResponses.entries()) {
      if (command.includes(pattern)) {
        return response;
      }
    }
    return this.defaultResponse;
  }

  async executeCommand(
    command: string,
    args: string[] = [],
    _options?: HostCommandOptions,
  ): Promise<ExecResult> {
    const renderedArgs = args.map((arg, index) =>
      command === "pgrep" && args[index - 1] === "-f"
        ? `'${arg}'`
        : arg.includes(" ")
          ? `'${arg}'`
          : arg,
    );
    this.executedArgv.push({ file: command, args: [...args] });
    const rendered = [command, ...renderedArgs].join(" ");
    const scripted = this.commandErrors.find(({ pattern }) => rendered.includes(pattern));
    if (scripted) {
      this.executedCommands.push(rendered);
      // The real executor rethrows through wrapCommandError so callers see the command line.
      // Only errors scripted here are wrapped: handler-thrown raw errors predate this and
      // dependent tests assert them unwrapped.
      throw wrapCommandError(scripted.error, { command, args, cwd: _options?.cwd });
    }
    return this.exec(rendered);
  }

  spawn(command: string, args: string[], options?: SpawnOptions): ChildProcess {
    const process = this.nextSpawnProcess ?? new FakeChildProcess();
    this.nextSpawnProcess = null;
    this.spawnResponses.push({ command, args, options, process });
    if (process instanceof FakeChildProcess) {
      process.simulateSpawn();
    }
    return process;
  }

  executeCommandWithChild(
    command: string,
    args: string[] = [],
    options?: HostCommandOptions,
  ): StartedHostCommand {
    return {
      child: this.spawn(command, args),
      result: this.executeCommand(command, args, options),
    };
  }

  private createExecResult(stdout: string, stderr: string): ExecResult {
    return {
      stdout,
      stderr,
      toString: () => stdout,
      trim: () => stdout.trim(),
      includes: (searchString: string) => stdout.includes(searchString),
    };
  }

  private ensureExecResultMethods(response: ExecResult): ExecResult {
    const stdout = response.stdout ?? "";
    const stderr = response.stderr ?? "";

    return {
      stdout,
      stderr,
      toString:
        typeof response.toString === "function" ? response.toString.bind(response) : () => stdout,
      trim:
        typeof response.trim === "function" ? response.trim.bind(response) : () => stdout.trim(),
      includes:
        typeof response.includes === "function"
          ? response.includes.bind(response)
          : (searchString: string) => stdout.includes(searchString),
    };
  }
}
