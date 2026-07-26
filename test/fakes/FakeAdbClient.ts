import type { AdbExecutor } from "../../src/utils/android-cmdline-tools/interfaces/AdbExecutor";

type FakeAdbClientContract = Pick<
  AdbExecutor,
  "executeCommand" | "getForegroundApp" | "listUsers"
>;

/**
 * Fake implementation of AdbClient for testing
 * Captures commands executed without actually running ADB
 */
export class FakeAdbClient implements FakeAdbClientContract {
  private commandCalls: Array<{
    command: string;
    timeoutMs?: number;
    maxBuffer?: number;
    noRetry?: boolean;
    signal?: AbortSignal;
  }> = [];
  private commandResults: Map<string, { stdout: string; stderr: string }> = new Map();
  private commandResultSequences: Map<string, Array<{ stdout: string; stderr: string }>> = new Map();
  private commandSequenceCursor: Map<string, number> = new Map();
  private commandErrors: Map<string, Error> = new Map();
  private foregroundApp: { packageName: string; userId: number } | null = null;
  private foregroundAppError: Error | null = null;
  private hangingCommandPatterns: string[] = [];
  private users: Array<{ userId: number; name: string; flags?: number; running?: boolean }> = [];

  /**
   * Record a command execution
   */
  async executeCommand(
    command: string,
    timeoutMs?: number,
    maxBuffer?: number,
    noRetry?: boolean,
    signal?: AbortSignal
  ): Promise<{ stdout: string; stderr: string; toString: () => string; trim: () => string; includes: (search: string) => boolean }> {
    this.commandCalls.push({ command, timeoutMs, maxBuffer, noRetry, signal });

    const error = this.commandErrors.get(command);
    if (error) {
      throw error;
    }

    // A hanging command never resolves — used to let a racing timeout win
    // deterministically (e.g. an adb backup the user never confirms). Safe
    // because the caller races it against a FakeTimer setTimeout, so nothing
    // actually blocks the test.
    if (this.hangingCommandPatterns.some(pattern => command.includes(pattern))) {
      return new Promise(() => {});
    }

    // A scripted sequence takes precedence: each call to the same command returns
    // the next entry, and the final entry repeats once exhausted. This lets a
    // pre/post-uninstall re-check observe a state transition without monkeypatching.
    const sequence = this.commandResultSequences.get(command);
    let result: { stdout: string; stderr: string };
    if (sequence && sequence.length > 0) {
      const cursor = this.commandSequenceCursor.get(command) ?? 0;
      result = sequence[Math.min(cursor, sequence.length - 1)];
      this.commandSequenceCursor.set(command, cursor + 1);
    } else {
      // Return configured result or default success
      result = this.commandResults.get(command) || { stdout: "", stderr: "" };
    }
    return {
      stdout: result.stdout,
      stderr: result.stderr,
      toString: () => result.stdout,
      trim: () => result.stdout.trim(),
      includes: (search: string) => result.stdout.includes(search)
    };
  }

  /**
   * Configure the result for a specific command
   */
  setCommandResult(command: string, stdout: string, stderr: string = ""): void {
    this.commandResults.set(command, { stdout, stderr });
  }

  /**
   * Script successive results for repeated calls to the exact same command.
   * Call N returns entry N; once exhausted the last entry repeats. Takes
   * precedence over {@link setCommandResult} for the same command.
   */
  setCommandResultSequence(command: string, results: Array<{ stdout: string; stderr?: string }>): void {
    this.commandResultSequences.set(
      command,
      results.map(entry => ({ stdout: entry.stdout, stderr: entry.stderr ?? "" }))
    );
    this.commandSequenceCursor.set(command, 0);
  }

  /**
   * Configure a command to throw an error
   */
  setCommandError(command: string, error: Error): void {
    this.commandErrors.set(command, error);
  }

  /**
   * Configure the current foreground app
   */
  setForegroundApp(app: { packageName: string; userId: number } | null): void {
    this.foregroundApp = app;
    this.foregroundAppError = null;
  }

  /**
   * Configure getForegroundApp() to reject, exercising a caller's degrade path.
   */
  setForegroundAppError(error: Error | null): void {
    this.foregroundAppError = error;
  }

  /**
   * Make any command containing `pattern` never resolve. A racing timeout must
   * be the one to settle the operation.
   */
  setHangingCommand(pattern: string): void {
    this.hangingCommandPatterns.push(pattern);
  }

  /**
   * Configure the list of users
   */
  setUsers(users: Array<{ userId: number; name: string; flags?: number; running?: boolean }>): void {
    this.users = [...users];
  }

  /**
   * Return the current foreground app
   */
  async getForegroundApp(): Promise<{ packageName: string; userId: number } | null> {
    if (this.foregroundAppError) {
      throw this.foregroundAppError;
    }
    return this.foregroundApp;
  }

  /**
   * Return the list of users
   */
  async listUsers(): Promise<Array<{ userId: number; name: string; flags?: number; running?: boolean }>> {
    return [...this.users];
  }

  /**
   * Get all recorded command calls
   */
  getCommandCalls(): Array<{
    command: string;
    timeoutMs?: number;
    maxBuffer?: number;
    noRetry?: boolean;
    signal?: AbortSignal;
  }> {
    return [...this.commandCalls];
  }

  /**
   * Get the last command call details
   */
  getLastCommandCall(): {
    command: string;
    timeoutMs?: number;
    maxBuffer?: number;
    noRetry?: boolean;
    signal?: AbortSignal;
  } | undefined {
    return this.commandCalls[this.commandCalls.length - 1];
  }

  /**
   * Get the last command executed
   */
  getLastCommand(): string {
    return this.commandCalls[this.commandCalls.length - 1]?.command || "";
  }

  /**
   * Get all commands executed
   */
  getAllCommands(): string[] {
    return this.commandCalls.map(call => call.command);
  }

  /**
   * Clear recorded commands
   */
  clearCommands(): void {
    this.commandCalls = [];
  }

  /**
   * Reset fake state
   */
  reset(): void {
    this.commandCalls = [];
    this.commandResults.clear();
    this.commandErrors.clear();
    // Also clear the scripted seams added for the action-lifecycle slice, or a
    // suite that reuses a client after reset() inherits stale sequences/cursors,
    // a lingering foreground-app error, and hanging-command patterns.
    this.commandResultSequences.clear();
    this.commandSequenceCursor.clear();
    this.foregroundAppError = null;
    this.hangingCommandPatterns = [];
  }

  /**
   * Check if a command was executed
   */
  wasCommandExecuted(commandPattern: string | RegExp): boolean {
    if (typeof commandPattern === "string") {
      return this.commandCalls.some(call => call.command.includes(commandPattern));
    }
    return this.commandCalls.some(call => commandPattern.test(call.command));
  }

  /**
   * Get count of commands matching a pattern
   */
  getCommandCount(commandPattern: string | RegExp): number {
    if (typeof commandPattern === "string") {
      return this.commandCalls.filter(call => call.command.includes(commandPattern)).length;
    }
    return this.commandCalls.filter(call => commandPattern.test(call.command)).length;
  }
}
