import { getAbortSignal } from "../../src/utils/AbortContext";
import type { ExecResult } from "../../src/models";
import type {
  AdbExecuteOptions,
  AdbExecutor,
} from "../../src/utils/android-cmdline-tools/interfaces/AdbExecutor";
import { FakeAdbExecutor } from "./FakeAdbExecutor";
import type { FakeTimer } from "./FakeTimer";

/** A host that can exit while its guest input process is still alive. */
export class FakeGuestInputAdb extends FakeAdbExecutor implements AdbExecutor {
  readonly entered = Promise.withResolvers<void>();
  readonly host = Promise.withResolvers<ExecResult>();
  readonly cleanupCalls: Array<{ args: string[]; options: AdbExecuteOptions }> = [];
  readonly dispatchOptions: AdbExecuteOptions[] = [];
  /** The ambient request signal visible to each dispatch (AdbClient defaults to it). */
  readonly ambientSignals: Array<AbortSignal | undefined> = [];
  stdoutChunks = ["42", "42\n"];
  guest: "input" | "recycled" | "gone" = "input";
  cleanupError: Error | undefined;
  cleanupHangs = false;
  cleanupResult: Promise<ExecResult> | undefined;
  private apiLevel = 30;
  private typingDeadline: { timer: FakeTimer; at: number } | undefined;
  private clientKilled = false;

  override setAndroidApiLevel(level: number | null): void {
    super.setAndroidApiLevel(level);
    this.apiLevel = level ?? 34;
  }

  setTypingDuration(timer: FakeTimer, durationMs: number): void {
    this.typingDeadline = { timer, at: timer.now() + durationMs };
    // API 31+: the host adb client stays attached until typing completes, unless it is killed.
    timer.setTimeout(() => {
      if (this.apiLevel >= 31 && !this.clientKilled) {
        this.host.resolve({ stdout: "", stderr: "" });
      }
    }, durationMs);
  }

  isTyping(): boolean {
    return (
      this.guest === "input" &&
      (!this.typingDeadline || this.typingDeadline.timer.now() < this.typingDeadline.at)
    );
  }

  override async execute(args: string[], options: AdbExecuteOptions = {}): Promise<ExecResult> {
    if (args.join(" ").includes("/proc/")) {
      this.cleanupCalls.push({ args, options });
      if (this.cleanupHangs) {
        return new Promise(() => {});
      }
      if (this.cleanupError) {
        throw this.cleanupError;
      }
      if (this.cleanupResult) {
        return this.cleanupResult;
      }
      if (this.typingDeadline && args[1].includes("kill 4242")) {
        this.clientKilled = true;
        // API 31+ typing runs in system_server, independently of the binder client.
        if (this.apiLevel < 31) {
          this.guest = "gone";
        }
      }
      return { stdout: this.isTyping() && !this.clientKilled ? "alive\n" : "", stderr: "" };
    }
    const result = await super.execute(args, options);
    if (args.join(" ").includes("input text ")) {
      this.dispatchOptions.push(options);
      this.ambientSignals.push(getAbortSignal());
      if (this.apiLevel >= 31) {
        // Killing the host adb client closes the shell stream, so the guest `cmd` binder client
        // dies with it. system_server keeps typing, but nothing is left to observe or wait on.
        options.signal?.addEventListener(
          "abort",
          () => {
            this.clientKilled = true;
            this.host.reject(options.signal?.reason);
          },
          { once: true },
        );
      }
      for (const chunk of this.stdoutChunks) {
        options.onStdout?.(chunk);
      }
      this.entered.resolve();
      return this.host.promise;
    }
    return result;
  }

  override async executeCommand(
    ...args: Parameters<FakeAdbExecutor["executeCommand"]>
  ): Promise<ExecResult> {
    // Model the old SendKeys path too, so its early release fails the regression.
    if (args[0].startsWith("shell input text ")) {
      this.entered.resolve();
      return this.host.promise;
    }
    return super.executeCommand(...args);
  }
}
