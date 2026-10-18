import { raceWithDeadline } from "../utils/raceWithDeadline";
import type { Timer } from "../utils/SystemTimer";
import { AndroidCommandOutputStreamRedactor } from "../utils/android-cmdline-tools/redactAndroidCommandOutput";
import {
  boundedEmulatorOutputTail,
  emulatorLaunchOutputSource,
  type EmulatorLaunchOutputSource,
} from "../utils/android-cmdline-tools/AndroidEmulatorClient";
import type { DeviceAutolockChildProcess as ChildProcess } from "./devicePool";

/**
 * A process can emit output after readiness. Capture its redacted bounded tail
 * so a later unexpected exit has the same useful evidence as an early launch
 * failure without retaining unbounded process output.
 */
export class EmulatorProcessOutputTail {
  private output = "";
  private readonly launchSource: EmulatorLaunchOutputSource | undefined;
  private readonly stdoutRedactor: AndroidCommandOutputStreamRedactor | undefined;
  private readonly stderrRedactor: AndroidCommandOutputStreamRedactor | undefined;
  private readonly streamsClosed: Promise<void>;

  constructor(
    childProcess: ChildProcess,
    private readonly timer: Timer,
  ) {
    this.launchSource = emulatorLaunchOutputSource(childProcess);
    const hasStreams =
      (childProcess.stdout !== null && childProcess.stdout !== undefined) ||
      (childProcess.stderr !== null && childProcess.stderr !== undefined);
    this.streamsClosed = hasStreams
      ? new Promise((resolve) => childProcess.once("close", resolve))
      : Promise.resolve();
    if (!this.launchSource) {
      const stdoutRedactor = new AndroidCommandOutputStreamRedactor();
      const stderrRedactor = new AndroidCommandOutputStreamRedactor();
      this.stdoutRedactor = stdoutRedactor;
      this.stderrRedactor = stderrRedactor;
      childProcess.stdout?.on("data", (value) => this.append(value, stdoutRedactor));
      childProcess.stderr?.on("data", (value) => this.append(value, stderrRedactor));
    }
  }

  snapshot(): string | undefined {
    const output = boundedEmulatorOutputTail(
      this.launchSource
        ? this.launchSource.snapshot()
        : this.output + this.stdoutRedactor!.snapshot() + this.stderrRedactor!.snapshot(),
    );
    return output.length > 0 ? output : undefined;
  }

  async finalize(): Promise<string | undefined> {
    await this.waitForStreamClose();
    this.output = boundedEmulatorOutputTail(
      this.launchSource
        ? this.launchSource.flush()
        : this.output + this.stdoutRedactor!.flush() + this.stderrRedactor!.flush(),
    );
    return this.output.length > 0 ? this.output : undefined;
  }

  private append(value: unknown, redactor: AndroidCommandOutputStreamRedactor): void {
    if (typeof value !== "string" && !Buffer.isBuffer(value)) {
      return;
    }
    this.output = boundedEmulatorOutputTail(this.output + redactor.append(value));
  }

  private async waitForStreamClose(): Promise<void> {
    const timedOut = Symbol("stream-close-timeout");
    try {
      await raceWithDeadline(this.streamsClosed, {
        timer: this.timer,
        timeoutMs: 1_000,
        label: "Emulator output streams",
        timeoutError: () => timedOut,
      });
    } catch (error) {
      if (error !== timedOut) {
        throw error;
      }
    }
  }
}
