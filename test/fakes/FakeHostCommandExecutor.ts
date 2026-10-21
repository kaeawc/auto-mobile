import { HostCommandExecutor, HostCommandOptions } from "../../src/utils/HostCommandExecutor";
import { ExecResult } from "../../src/models";

/**
 * Fake implementation of HostCommandExecutor for testing
 */
export class FakeHostCommandExecutor implements HostCommandExecutor {
  private commandResponses: Map<string, ExecResult> = new Map();
  private defaultResponse: ExecResult = this.createExecResult("", "");
  private commandErrors: Map<string, Error> = new Map();
  private executedCommands: Array<{
    command: string;
    args: string[];
    options?: HostCommandOptions;
  }> = [];

  private createExecResult(stdout: string, stderr: string): ExecResult {
    return {
      stdout,
      stderr,
      toString: () => stdout,
      trim: () => stdout.trim(),
      includes: (searchString: string) => stdout.includes(searchString),
    };
  }

  setCommandResponse(commandPattern: string, response: ExecResult): void {
    this.commandResponses.set(commandPattern, this.ensureExecResultMethods(response));
  }

  /** Reject commands whose `command args...` string contains `commandPattern`. */
  setCommandError(commandPattern: string, error: Error): void {
    this.commandErrors.set(commandPattern, error);
  }

  /** Every call with its argv and options, in order. */
  getExecutedCalls(): Array<{ command: string; args: string[]; options?: HostCommandOptions }> {
    return [...this.executedCommands];
  }

  setDefaultResponse(response: ExecResult): void {
    this.defaultResponse = this.ensureExecResultMethods(response);
  }

  getExecutedCommands(): string[] {
    return this.executedCommands.map((entry) => [entry.command, ...entry.args].join(" ").trim());
  }

  wasCommandExecuted(pattern: string): boolean {
    return this.getExecutedCommands().some((command) => command.includes(pattern));
  }

  async executeCommand(
    command: string,
    args: string[] = [],
    options?: HostCommandOptions,
  ): Promise<ExecResult> {
    this.executedCommands.push({ command, args, options });

    const commandString = [command, ...args].join(" ");
    for (const [pattern, error] of this.commandErrors.entries()) {
      if (commandString.includes(pattern)) {
        throw error;
      }
    }
    for (const [pattern, response] of this.commandResponses.entries()) {
      if (commandString.includes(pattern)) {
        return response;
      }
    }

    return this.defaultResponse;
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
