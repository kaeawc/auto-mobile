import { ActionableError } from "../../../models/ActionableError";
import { GrpcStatus, type GrpcStatusResult } from "./grpcFraming";

/** Stable codes for emulator gRPC, guest capture, and iOS Simulator host-loopback failures. */
export type EmulatorAudioErrorCode =
  | "audio_emulator_exited"
  | "audio_guest_capture_unavailable"
  | "audio_injection_busy"
  | "audio_injection_unsupported"
  | "audio_capture_unsupported"
  | "audio_grpc_failed"
  | "audio_loopback_failed";

/**
 * The generic tool-error path serializes only the message, so the message leads with the code in
 * brackets (as `androidLaunchIntent` does) for clients that branch on it.
 */
export class EmulatorAudioError extends ActionableError {
  constructor(
    readonly code: EmulatorAudioErrorCode,
    message: string,
    readonly grpcStatus?: GrpcStatusResult,
  ) {
    super(`[${code}] ${message}`);
  }
}

export function injectionError(status: GrpcStatusResult): EmulatorAudioError {
  switch (status.code) {
    case GrpcStatus.FAILED_PRECONDITION:
      return new EmulatorAudioError(
        "audio_injection_busy",
        "Another audio injection is already active on this emulator. Stop it before starting a new one.",
        status,
      );
    case GrpcStatus.UNIMPLEMENTED:
    case GrpcStatus.UNAVAILABLE:
      return new EmulatorAudioError(
        "audio_injection_unsupported",
        `The emulator's gRPC audio injection is unavailable (${status.message || "no detail"}). ` +
          "Use an emulator build with gRPC enabled and do not launch it with -no-audio.",
        status,
      );
    default:
      return new EmulatorAudioError(
        "audio_grpc_failed",
        `Emulator audio injection failed with gRPC status ${status.code}: ${status.message || "no detail"}`,
        status,
      );
  }
}

export function captureError(status: GrpcStatusResult): EmulatorAudioError {
  const unsupported =
    status.code === GrpcStatus.UNIMPLEMENTED || status.code === GrpcStatus.UNAVAILABLE;
  return new EmulatorAudioError(
    unsupported ? "audio_capture_unsupported" : "audio_grpc_failed",
    `Emulator audio capture failed with gRPC status ${status.code}: ${status.message || "no detail"}`,
    status,
  );
}

export function emulatorExitedDuringInjection(deviceId: string): EmulatorAudioError {
  return new EmulatorAudioError(
    "audio_emulator_exited",
    `Emulator ${deviceId} exited during audio injection. Restart the emulator and start a new injection.`,
  );
}
