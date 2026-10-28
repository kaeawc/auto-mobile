import { ActionableError } from "../../models";
import { type Timer } from "../../utils/SystemTimer";
import type { CaptureTarget, IosScreenCaptureReadinessPhase } from "../screen-stream";
import type { IosFrameCaptureHelper } from "./IosH264SourceConfig";
import { NoFirstFrameError } from "./NoFirstFrameError";
import { ScreenRecordingPermissionHintError } from "./ScreenRecordingPermissionHintError";

const NO_FRAMES_PERMISSION_WARNING = "warn: no frames received";

function makeNoFramesError(
  target: CaptureTarget,
  lastPhase: IosScreenCaptureReadinessPhase | null,
): NoFirstFrameError {
  const stage = lastPhase === null ? "" : ` (last stage: ${lastPhase})`;
  const hint = hintForNoFrames(target, lastPhase);
  return new NoFirstFrameError(`iOS screen capture did not produce a first frame${stage}.${hint}`);
}

function makeScreenRecordingPermissionHintError(
  target: CaptureTarget,
  lastPhase: IosScreenCaptureReadinessPhase | null,
): ScreenRecordingPermissionHintError {
  return new ScreenRecordingPermissionHintError(makeNoFramesError(target, lastPhase).message);
}

// Map the furthest startup stage reached to a targeted hint so the surfaced
// error distinguishes a permission stall from window discovery vs a hung start
// (issue #4766).
function hintForNoFrames(
  target: CaptureTarget,
  lastPhase: IosScreenCaptureReadinessPhase | null,
): string {
  const permissionHint =
    " Screen Recording permission may be required to observe the iOS Simulator window.";
  switch (lastPhase) {
    case null:
    case "helper-executable-found":
    case "helper-process-spawned":
      // The helper never confirmed permission; the likeliest cause is a missing
      // Screen Recording grant.
      return target.kind === "simulator" ? permissionHint : "";
    case "permission-ready":
      // Permission is granted but the target Simulator window never resolved.
      return " The Simulator window could not be resolved; ensure the Simulator is booted and visible.";
    case "target-resolved":
      // The window resolved but ScreenCaptureKit never confirmed the session
      // started — a hung start (see issue #4350).
      return " Capture never started after the window resolved (hung start); retry or restart the Simulator.";
    case "capture-started":
      // The session started but delivered no frames — usually a permission gate
      // that lets the session begin without producing pixels.
      return target.kind === "simulator" ? permissionHint : "";
    case "first-frame":
      return "";
  }
}

function isNoFramesPermissionWarning(line: string): boolean {
  return line.toLowerCase().includes(NO_FRAMES_PERMISSION_WARNING);
}

export function isHelperError(line: string): boolean {
  return line.trimStart().toLowerCase().startsWith("error:");
}
interface IosCaptureStartupContext {
  generation(): number;
  lastReadinessPhase(): IosScreenCaptureReadinessPhase | null;
  markRunning(): void;
  isCurrentHelper(helper: IosFrameCaptureHelper, generation: number): boolean;
  isActive(): boolean;
  helperFailureFor(line: string): Error;
  failIfCurrentHelper(helper: IosFrameCaptureHelper, generation: number, error: Error): void;
  describeHelperExit(
    info: { code: number | null; signal: NodeJS.Signals | null },
    what: string,
  ): string;
  encodedStartupError(error: Error): Error;
  encodedCapabilityConfirmed(): boolean;
}
export class IosCaptureStartup {
  cancelFirstFrameWait: (() => void) | null = null;
  cancelFirstAudioWait: (() => void) | null = null;
  rejectFirstAudioWait: ((error: Error) => void) | null = null;
  constructor(
    private readonly timer: Timer,
    private readonly firstFrameTimeoutMs: number,
    private readonly context: IosCaptureStartupContext,
  ) {}

  waitForFirstAudio(helper: IosFrameCaptureHelper): Promise<void> {
    const generation = this.context.generation();
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (callback: () => void): void => {
        if (settled) {
          return;
        }
        settled = true;
        this.timer.clearTimeout(timeout);
        if (this.cancelFirstAudioWait === cancel) {
          this.cancelFirstAudioWait = null;
        }
        if (this.rejectFirstAudioWait === rejectWait) {
          this.rejectFirstAudioWait = null;
        }
        callback();
      };
      const cancel = (): void => finish(resolve);
      const rejectWait = (error: Error): void => finish(() => reject(error));
      const timeout = this.timer.setTimeout(() => {
        finish(() =>
          reject(
            new ActionableError(
              "iOS Simulator audio capture did not produce PCM audio before startup timed out.",
            ),
          ),
        );
      }, this.firstFrameTimeoutMs);
      this.cancelFirstAudioWait = cancel;
      this.rejectFirstAudioWait = rejectWait;
      helper.on("audio", () => {
        if (this.context.isCurrentHelper(helper, generation) && this.context.isActive()) {
          finish(resolve);
        }
      });
      helper.on("error", (error) => {
        if (this.context.isCurrentHelper(helper, generation) && this.context.isActive()) {
          finish(() => reject(error));
        }
      });
      helper.on("exit", (info) => {
        if (this.context.isCurrentHelper(helper, generation) && this.context.isActive()) {
          finish(() =>
            reject(new Error(this.context.describeHelperExit(info, "exited before audio"))),
          );
        }
      });
    });
  }

  /**
   * Wait for the first Annex-B record. Missing encoding capability is an
   * actionable version-skew failure; a capable helper timeout may be retried.
   */
  waitForFirstEncodedRecord(helper: IosFrameCaptureHelper, target: CaptureTarget): Promise<void> {
    const generation = this.context.generation();
    return new Promise((resolve, reject) => {
      let settled = false;
      let firstRecordSeen = false;
      const finish = (callback: () => void): void => {
        if (settled) {
          return;
        }
        settled = true;
        this.timer.clearTimeout(timeout);
        if (this.cancelFirstFrameWait === cancel) {
          this.cancelFirstFrameWait = null;
        }
        callback();
      };
      const cancel = (): void => {
        finish(resolve);
      };
      const rejectStartupFailure = (error: Error): void => {
        finish(() => reject(this.context.encodedStartupError(error)));
      };
      const timeout = this.timer.setTimeout(() => {
        rejectStartupFailure(makeNoFramesError(target, this.context.lastReadinessPhase()));
      }, this.firstFrameTimeoutMs);
      this.cancelFirstFrameWait = cancel;

      helper.on("encodedVideo", () => {
        if (!this.context.isCurrentHelper(helper, generation) || !this.context.isActive()) {
          return;
        }
        if (!this.context.encodedCapabilityConfirmed()) {
          rejectStartupFailure(
            new Error("Received encoded video without the required capability handshake"),
          );
          return;
        }
        firstRecordSeen = true;
        this.context.markRunning();
        finish(resolve);
      });
      helper.on("stderr", (line) => {
        if (!this.context.isCurrentHelper(helper, generation) || !this.context.isActive()) {
          return;
        }
        if (isNoFramesPermissionWarning(line)) {
          finish(() =>
            reject(
              makeScreenRecordingPermissionHintError(target, this.context.lastReadinessPhase()),
            ),
          );
        } else if (isHelperError(line)) {
          rejectStartupFailure(this.context.helperFailureFor(line));
        }
      });
      helper.on("error", (error) => {
        if (!this.context.isCurrentHelper(helper, generation) || !this.context.isActive()) {
          return;
        }
        if (firstRecordSeen) {
          this.context.failIfCurrentHelper(helper, generation, error);
          return;
        }
        rejectStartupFailure(error);
      });
      helper.on("exit", (info) => {
        if (!this.context.isCurrentHelper(helper, generation) || !this.context.isActive()) {
          return;
        }
        const error = new Error(this.context.describeHelperExit(info, "exited"));
        if (firstRecordSeen) {
          this.context.failIfCurrentHelper(helper, generation, error);
          return;
        }
        rejectStartupFailure(error);
      });
    });
  }
}
