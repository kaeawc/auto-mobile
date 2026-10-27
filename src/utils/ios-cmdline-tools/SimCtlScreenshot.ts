import {
  SCREENSHOT_CLEANUP_BOUND_MS,
  ScreenshotCaptureContext,
  SimCtlFileSystem,
} from "./SimCtlSupport";
import { buildSimctlArgs } from "./simctlArgs";

import { detectImageMimeType } from "../screenshot/imageHeaderDimensions";
import { errorMessage } from "../describeUnknownError";

import type {
  HostChildProcess as ChildProcess,
  HostSpawnOptions as SpawnOptions,
} from "../HostCommandExecutor";

import { tmpdir } from "os";
import { resolve } from "path";
import { logger } from "../logger";

import { Timer } from "../SystemTimer";
import { raceWithDeadline } from "../raceWithDeadline";

import { type IdGenerator } from "../IdGenerator";

import { SimctlScreenshotError } from "./SimctlScreenshotError";

export interface SimCtlScreenshotContext {
  timer: Timer;
  idGenerator: IdGenerator;
  fileSystem: SimCtlFileSystem;
  spawnProcess: (command: string, args: string[], options?: SpawnOptions) => ChildProcess;
}
export class SimCtlScreenshot {
  constructor(private readonly context: SimCtlScreenshotContext) {}

  /** Capture the selected physical framebuffer as PNG through a private temporary file. */
  async screenshot(deviceId: string, display: string, signal?: AbortSignal): Promise<Buffer> {
    const startedAt = this.context.timer.now();
    const timeout = new AbortController();
    const handle = this.context.timer.setTimeout(() => timeout.abort(), 10_000);
    const captureSignal = signal ? AbortSignal.any([signal, timeout.signal]) : timeout.signal;
    const context: ScreenshotCaptureContext = {
      signal: captureSignal,
      abortFailure: (cause, exitCode, stderr) => {
        const elapsed = this.context.timer.now() - startedAt;
        const timedOut = captureSignal.reason === timeout.signal.reason && timeout.signal.aborted;
        return new SimctlScreenshotError(
          timedOut ? "aborted-by-timeout" : "aborted-by-caller",
          timedOut
            ? `simctl screenshot timed out after ${elapsed}ms`
            : `simctl screenshot cancelled by the caller after ${elapsed}ms: ${errorMessage(signal?.reason)}`,
          { exitCode, stderr, cause: cause ?? captureSignal.reason },
        );
      },
    };
    let dir: string | undefined;
    let finished = false;
    try {
      // The continuation owns late directories; finally owns ones received before settlement.
      const preparing = this.prepareScreenshotDirectory().then(async (created) => {
        if (finished) {
          await this.removeScreenshotDirectory(created);
        } else {
          dir = created;
        }
        return created;
      });
      // A pre-aborted race does not subscribe to its input; observe setup failures even then.
      void preparing.then(undefined, (error: unknown) => {
        logger.debug(`simctl screenshot temp preparation failed: ${errorMessage(error)}`, error);
      });
      const created = await raceWithDeadline(preparing, {
        timer: this.context.timer,
        signal: captureSignal,
        label: "simctl screenshot temp directory",
      });
      const path = resolve(created, `screenshot-${this.context.idGenerator.next()}.png`);
      return await this.captureScreenshotFile(deviceId, display, path, context);
    } catch (error) {
      throw error instanceof SimctlScreenshotError || !captureSignal.aborted
        ? error
        : context.abortFailure(error);
    } finally {
      finished = true;
      try {
        if (dir !== undefined) {
          await this.removeScreenshotDirectory(dir);
        }
      } finally {
        this.context.timer.clearTimeout(handle);
      }
    }
  }

  async prepareScreenshotDirectory(): Promise<string> {
    try {
      return await this.context.fileSystem.mkdtemp(resolve(tmpdir(), "automobile-screenshot-"));
    } catch (error) {
      throw new SimctlScreenshotError(
        "read-failure",
        "Unable to prepare simctl screenshot temp directory",
        { cause: error },
      );
    }
  }

  async removeScreenshotDirectory(dir: string): Promise<void> {
    await this.waitForScreenshotCleanup(
      () => this.context.fileSystem.rm(dir, { recursive: true, force: true }),
      "temp directory",
    );
  }

  async waitForScreenshotCleanup(cleanup: () => Promise<unknown>, phase: string): Promise<void> {
    try {
      await raceWithDeadline(cleanup, {
        timer: this.context.timer,
        timeoutMs: SCREENSHOT_CLEANUP_BOUND_MS,
        label: `simctl screenshot ${phase} cleanup`,
      });
    } catch (error) {
      // Best-effort cleanup is safe to swallow: the capture result is already decided.
      logger.debug(`simctl screenshot ${phase} cleanup failed: ${errorMessage(error)}`, error);
    }
  }

  async readScreenshotFile(path: string, stderr: string): Promise<Buffer> {
    let output: Buffer;
    try {
      output = await this.context.fileSystem.readFileBuffer(path);
    } catch (error) {
      const missing =
        typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
      throw new SimctlScreenshotError(
        missing ? "missing-output-file" : "read-failure",
        `simctl screenshot output ${missing ? "file missing" : "read failed"}: ${errorMessage(error)}`,
        { exitCode: 0, stderr, cause: error },
      );
    }
    if (output.length === 0 || detectImageMimeType(output) !== "image/png") {
      const reason = output.length === 0 ? "empty-output" : "non-image-output";
      throw new SimctlScreenshotError(reason, `simctl screenshot returned ${reason}`, {
        exitCode: 0,
        stderr,
        byteLength: output.length,
      });
    }
    return output;
  }

  async captureScreenshotFile(
    deviceId: string,
    display: string,
    path: string,
    context: ScreenshotCaptureContext,
  ): Promise<Buffer> {
    const args = buildSimctlArgs(["io", deviceId, "screenshot", `--display=${display}`, path]);
    const captureSignal = context.signal;
    const errors: Buffer[] = [];
    const stderrText = (): string => Buffer.concat(errors).toString();
    const abortFailure = (cause?: unknown, exitCode?: number | null): SimctlScreenshotError =>
      context.abortFailure(cause, exitCode, stderrText());
    if (captureSignal.aborted) {
      throw abortFailure();
    }
    const process = new Promise<string>((resolve, reject) => {
      let child: ChildProcess;
      try {
        if (captureSignal.aborted) {
          reject(abortFailure());
          return;
        }
        child = this.context.spawnProcess("xcrun", args, { signal: captureSignal });
      } catch (error) {
        reject(
          captureSignal.aborted
            ? abortFailure(error)
            : new SimctlScreenshotError(
                "non-zero-exit",
                `simctl screenshot failed to spawn: ${errorMessage(error)}`,
                { cause: error },
              ),
        );
        return;
      }
      // Drain diagnostic stdout; simctl writes the PNG only to the requested file.
      child.stdout?.on("data", () => {});
      child.stderr?.on("data", (chunk: Buffer) => errors.push(chunk));
      child.once("error", (error) => {
        reject(
          captureSignal.aborted
            ? abortFailure(error)
            : new SimctlScreenshotError(
                "non-zero-exit",
                `simctl screenshot process failed: ${errorMessage(error)}`,
                { stderr: stderrText(), cause: error },
              ),
        );
      });
      child.once("close", (code) => {
        if (captureSignal.aborted) {
          reject(abortFailure(captureSignal.reason, code));
        } else if (code === 0) {
          resolve(stderrText());
        } else {
          const stderr = stderrText();
          reject(
            new SimctlScreenshotError("non-zero-exit", `simctl screenshot failed: ${stderr}`, {
              exitCode: code,
              stderr,
            }),
          );
        }
      });
    });
    let stderr: string;
    try {
      stderr = await raceWithDeadline(process, {
        timer: this.context.timer,
        signal: captureSignal,
        label: "simctl screenshot process",
      });
    } catch (error) {
      const failure =
        error instanceof SimctlScreenshotError || !captureSignal.aborted
          ? error
          : abortFailure(error);
      if (captureSignal.aborted) {
        // Spawn's signal has requested termination; wait only briefly for its notification.
        await this.waitForScreenshotCleanup(
          () =>
            process.then(
              () => undefined,
              () => undefined,
            ),
          "process settlement",
        );
      }
      throw failure;
    }
    try {
      return await raceWithDeadline(() => this.readScreenshotFile(path, stderr), {
        timer: this.context.timer,
        signal: captureSignal,
        label: "simctl screenshot",
      });
    } catch (error) {
      throw captureSignal.aborted ? abortFailure(captureSignal.reason, 0) : error;
    }
  }
}
