import { ActionableError } from "../../models";
import type { RecordingFileProbe } from "./FfmpegVideoProcessingBackend";
import type { ProcessExitState, ProcessTracker } from "../../utils/ChildProcessTracker";
import { logger } from "../../utils/logger";

export type FfmpegDiagnosticsTracker = Pick<ProcessTracker, "exitState" | "stderr">;

type ProcessDiagnosticsTracker = Pick<ProcessTracker, "exitState" | "stderr">;

export function isFailedExitCode(exitCode: number | null | undefined): boolean {
  return exitCode !== undefined && exitCode !== 0;
}

export function isFailedExitState(exitState: ProcessExitState): boolean {
  return (
    isFailedExitCode(exitState.exitCode) ||
    (exitState.signal !== undefined && exitState.signal !== null)
  );
}

export function buildFfmpegFailureMessage(
  binaryPath: string,
  summary: string,
  args: string[],
  tracker: FfmpegDiagnosticsTracker,
  outputPath?: string,
): string {
  const details = [
    summary,
    outputPath ? `output: ${outputPath}` : undefined,
    `command: ${binaryPath} ${args.join(" ")}`,
    `exitCode: ${tracker.exitState.exitCode ?? "null"}`,
    `signal: ${tracker.exitState.signal ?? "null"}`,
    `stderr:\n${tracker.stderr.join("").trim() || "(empty)"}`,
  ].filter((line): line is string => Boolean(line));

  return details.join("\n");
}

export function buildProcessFailureMessage(
  summary: string,
  command: string,
  args: string[],
  tracker: ProcessDiagnosticsTracker,
  outputPath?: string,
): string {
  const details = [
    summary,
    outputPath ? `output: ${outputPath}` : undefined,
    `command: ${command} ${args.join(" ")}`,
    `exitCode: ${tracker.exitState.exitCode ?? "null"}`,
    `signal: ${tracker.exitState.signal ?? "null"}`,
    `stderr:\n${tracker.stderr.join("").trim() || "(empty)"}`,
  ].filter((line): line is string => Boolean(line));

  return details.join("\n");
}

export function logProcessWarnings(label: string, tracker: ProcessTracker): void {
  if (isFailedExitCode(tracker.exitState.exitCode)) {
    logger.warn(
      `[FfmpegVideo] ${label} exited with code ${tracker.exitState.exitCode}: ${tracker.stderr.join("")}`,
    );
  }

  if (tracker.stderr.length > 0) {
    logger.info(`[FfmpegVideo] ${label} stderr: ${tracker.stderr.join("")}`);
  }
}

export async function assertFfmpegOutputReady(
  outputPath: string,
  args: string[],
  tracker: FfmpegDiagnosticsTracker,
  recordingFileProbe: RecordingFileProbe,
  binaryPath: string,
): Promise<void> {
  const sizeBytes = await recordingFileProbe.size(outputPath);
  if (sizeBytes === null) {
    throw new ActionableError(
      buildFfmpegFailureMessage(
        binaryPath,
        "FFmpeg output file missing",
        args,
        tracker,
        outputPath,
      ),
    );
  }

  if (!sizeBytes) {
    throw new ActionableError(
      buildFfmpegFailureMessage(
        binaryPath,
        "FFmpeg output file is empty",
        args,
        tracker,
        outputPath,
      ),
    );
  }
}
