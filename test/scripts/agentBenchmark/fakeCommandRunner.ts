import type { CommandResult, CommandRunner } from "../../../scripts/agent-benchmark/device";

export interface RecordedCommand {
  command: string;
  args: string[];
  env?: Record<string, string>;
}

type Responder = (args: string[]) => Partial<CommandResult> | undefined;

/**
 * Records every command and answers from responders; the most recently added
 * responder returning a value wins (so a test can override a setup default),
 * otherwise the command succeeds with empty output.
 */
export class FakeCommandRunner implements CommandRunner {
  readonly calls: RecordedCommand[] = [];
  private readonly responders: Array<{ command: string; respond: Responder }> = [];

  on(command: string, respond: Responder): this {
    this.responders.push({ command, respond });
    return this;
  }

  /** Answer `adb ...` calls whose args contain `fragment` (joined with spaces). */
  onAdb(fragment: string, result: Partial<CommandResult>): this {
    return this.on("adb", (args) => (args.join(" ").includes(fragment) ? result : undefined));
  }

  async run(command: string, args: string[], _timeoutMs: number, env?: Record<string, string>) {
    this.calls.push({ command, args, env });
    const answer = [...this.responders]
      .reverse()
      .filter((responder) => responder.command === command)
      .map((responder) => responder.respond(args))
      .find((result) => result !== undefined);
    return { exitCode: 0, stdout: "", stderr: "", ...answer };
  }

  adbCalls(): string[] {
    return this.calls.filter((call) => call.command === "adb").map((call) => call.args.join(" "));
  }
}
