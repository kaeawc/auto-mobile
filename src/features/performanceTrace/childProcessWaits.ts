import type { HostChildProcess } from "../../utils/HostCommandExecutor";
import type { Timer } from "../../utils/SystemTimer";

/** Resolves once the child exits or fails to spawn; never rejects. */
export function waitForChildExit(child: HostChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    child.once("exit", () => resolve());
    child.once("error", () => resolve());
  });
}

interface OutputWaitOptions {
  timer: Pick<Timer, "setTimeout" | "clearTimeout">;
  timeoutMs: number;
  label: string;
  signal?: AbortSignal;
}

/**
 * Resolve when the child prints a line matching `pattern` on stdout or stderr.
 * Rejects with the captured output if it exits first, fails to spawn, times out,
 * or the caller aborts.
 */
export function waitForChildOutput(
  child: HostChildProcess,
  pattern: RegExp,
  options: OutputWaitOptions,
): Promise<void> {
  return new Promise((resolve, reject) => {
    if (options.signal?.aborted) {
      reject(new Error(`${options.label} was cancelled.`));
      return;
    }
    let output = "";
    const handle = options.timer.setTimeout(
      () => fail(`${options.label} did not report that it started within ${options.timeoutMs}ms.`),
      options.timeoutMs,
    );
    const cleanup = () => {
      options.timer.clearTimeout(handle);
      child.stdout?.off("data", onData);
      child.stderr?.off("data", onData);
      child.off("close", onExit);
      child.off("error", onError);
      options.signal?.removeEventListener("abort", onAbort);
    };
    const fail = (message: string) => {
      cleanup();
      const tail = output.trim().slice(-1_000);
      reject(new Error(tail ? `${message}\n${tail}` : message));
    };
    const onData = (chunk: Buffer | string) => {
      output += chunk.toString();
      if (pattern.test(output)) {
        cleanup();
        resolve();
      }
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null) =>
      fail(`${options.label} exited before it started (code ${code}, signal ${signal}).`);
    const onError = (error: Error) => fail(`${options.label} failed to start: ${error.message}`);
    const onAbort = () => fail(`${options.label} was cancelled.`);
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    // `close` (not `exit`) fires after stdio drains, so the failure carries the child's output.
    child.once("close", onExit);
    child.once("error", onError);
    options.signal?.addEventListener("abort", onAbort, { once: true });
  });
}
