import { expect, test } from "bun:test";
import {
  EmulatorAudioError,
  hostMicrophoneUnavailable,
  repeatInjectionUnsafe,
} from "../../../../src/utils/android-cmdline-tools/emulatorGrpc/EmulatorAudioError";
import { GrpcStatus } from "../../../../src/utils/android-cmdline-tools/emulatorGrpc/grpcFraming";

test("legacy constructor keeps its exact message and gRPC status", () => {
  const status = { code: GrpcStatus.UNAVAILABLE, message: "unavailable" };
  const error = new EmulatorAudioError("audio_grpc_failed", "original message", status);
  expect(error.message).toBe("[audio_grpc_failed] original message");
  expect(error.grpcStatus).toBe(status);
  expect(error.retryable).toBeUndefined();
  expect(error.remedy).toBeUndefined();
});

test("both host safety errors have typed non-retryable fields and the same actionable remedy", () => {
  const host = hostMicrophoneUnavailable("emulator-5554");
  const repeat = repeatInjectionUnsafe("emulator-5554");
  expect(host.remedy).toBe(repeat.remedy);
  for (const error of [host, repeat]) {
    expect(error).toBeInstanceOf(EmulatorAudioError);
    expect(error.retryable).toBe(false);
    expect(error.message).toStartWith(`[${error.code}]`);
    expect(error.remedy).toContain("host app that runs the emulator");
    expect(error.remedy).toContain("System Settings > Privacy and Security > Microphone");
    expect(error.remedy).toContain("restart the emulator");
  }
});
