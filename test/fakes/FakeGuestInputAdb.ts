import type { ExecResult } from "../../src/models";
import type { AdbExecuteOptions } from "../../src/utils/android-cmdline-tools/interfaces/AdbExecutor";
import { FakeAdbExecutor } from "./FakeAdbExecutor";

/** A host that can exit while its guest input process is still alive. */
export class FakeGuestInputAdb extends FakeAdbExecutor {
  readonly entered = Promise.withResolvers<void>();
  readonly host = Promise.withResolvers<ExecResult>();
  readonly cleanupCalls: Array<{ args: string[]; options: AdbExecuteOptions }> = [];
  readonly dispatchOptions: AdbExecuteOptions[] = [];
  stdoutChunks = ["42", "42\n"];
  guest: "input" | "recycled" | "gone" = "input";
  cleanupError: Error | undefined;
  cleanupHangs = false;

  override async execute(args: string[], options: AdbExecuteOptions = {}): Promise<ExecResult> {
    if (args.join(" ").includes("/proc/")) {
      this.cleanupCalls.push({ args, options });
      if (this.cleanupHangs) {
        return new Promise(() => {});
      }
      if (this.cleanupError) {
        throw this.cleanupError;
      }
      return { stdout: this.guest === "input" ? "alive\n" : "", stderr: "" };
    }
    const result = await super.execute(args, options);
    if (args.join(" ").includes("input text ")) {
      this.dispatchOptions.push(options);
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
