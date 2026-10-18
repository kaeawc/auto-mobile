import { logger } from "../logger";
import { raceWithDeadline } from "../raceWithDeadline";
import { combineAbortSignals } from "../AbortContext";
import { trackAmbient } from "../PerfContext";
import type { Timer } from "../SystemTimer";
import { ActionableError, type ExecResult } from "../../models";

/** Members resolved through the client at call time (the other extracted units' convention). */
export interface EmulatorCommandRunnerHost {
  timer(): Timer;
  ensureEmulatorPath(): Promise<string>;
  execAsync(file: string, args: string[], signal?: AbortSignal): Promise<ExecResult>;
}

/** Runs `emulator <args>` with an optional deadline that also kills the child. */
export interface EmulatorCommandRunner {
  executeCommand(args: string[], timeoutMs?: number, signal?: AbortSignal): Promise<ExecResult>;
}

export class DefaultEmulatorCommandRunner implements EmulatorCommandRunner {
  constructor(private readonly host: EmulatorCommandRunnerHost) {}

  executeCommand(args: string[], timeoutMs?: number, signal?: AbortSignal): Promise<ExecResult> {
    // One span per `emulator <verb>` CLI invocation (e.g. `emulator -list-avds`
    // AVD discovery), recorded against the ambient device-lifecycle tracker when
    // one is in scope (see PerfContext).
    return trackAmbient(`emulator ${args.slice(0, 1).join(" ")}`.trimEnd(), () =>
      this.executeCommandInner(args, timeoutMs, signal),
    );
  }

  private async executeCommandInner(
    args: string[],
    timeoutMs?: number,
    signal?: AbortSignal,
  ): Promise<ExecResult> {
    const emulatorPath = await this.host.ensureEmulatorPath();
    const fullCommand = `${emulatorPath} ${args.join(" ")}`;
    logger.debug(`Executing emulator command: ${fullCommand}`);

    // On timeout we abort the controller so the underlying child process is
    // killed rather than left running orphaned (issue #3938).
    if (timeoutMs) {
      const controller = new AbortController();

      const runPromise = this.host.execAsync(
        emulatorPath,
        args,
        combineAbortSignals(signal, controller.signal),
      );
      return raceWithDeadline(runPromise, {
        timer: this.host.timer(),
        timeoutMs,
        label: "Emulator command",
        timeoutError: () =>
          new ActionableError(`Command timed out after ${timeoutMs}ms: ${fullCommand}`),
        onTimeout: () => controller.abort(),
      });
    }

    return await this.host.execAsync(emulatorPath, args, signal);
  }
}
