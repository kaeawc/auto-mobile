import { describe, expect, test } from "bun:test";
import {
  androidEmulatorAudioCapabilities,
  type AndroidAudioInputs,
} from "../../../src/utils/audio/audioCapabilities";

const inputs: AndroidAudioInputs = {
  config: {},
  launchWithoutAudio: false,
  host: { platform: "linux", probed: false, input: null, output: null, outputCaptureable: false },
};
const grpcIds = ["android.emulator.audioInputInjection", "android.emulator.audioOutputCapture"];

describe("Android emulator gRPC audio capabilities", () => {
  test("omits gRPC entries when no probe result was supplied", () => {
    expect(androidEmulatorAudioCapabilities(inputs)).toEqual([]);
  });

  test("reachable gRPC makes injection and capture available", () => {
    expect(androidEmulatorAudioCapabilities({ ...inputs, grpc: { state: "reachable" } })).toEqual(
      grpcIds.map((id) => ({ id, state: "available", source: "platform" })),
    );
  });

  const failures: {
    name: string;
    grpc: NonNullable<AndroidAudioInputs["grpc"]>;
    state: "unavailable" | "unsupported";
    reason: string;
  }[] = [
    {
      name: "unreachable preserves the probe reason",
      grpc: { state: "unreachable", reason: "Connection refused." },
      state: "unavailable",
      reason: "Connection refused.",
    },
    {
      name: "unreachable with an empty reason uses a fallback",
      grpc: { state: "unreachable", reason: "" },
      state: "unavailable",
      reason: "The emulator gRPC endpoint is unreachable.",
    },
    {
      name: "unreachable with a whitespace reason uses a fallback",
      grpc: { state: "unreachable", reason: " \n\t" },
      state: "unavailable",
      reason: "The emulator gRPC endpoint is unreachable.",
    },
    {
      name: "not configured preserves the probe reason",
      grpc: { state: "not_configured", reason: "No advertised gRPC endpoint." },
      state: "unsupported",
      reason: "No advertised gRPC endpoint.",
    },
    {
      name: "not configured without a reason names the missing port",
      grpc: { state: "not_configured" },
      state: "unsupported",
      reason: "No emulator gRPC port is configured.",
    },
    {
      name: "not configured with an empty reason uses a fallback",
      grpc: { state: "not_configured", reason: "" },
      state: "unsupported",
      reason: "No emulator gRPC port is configured.",
    },
    {
      name: "not configured with a whitespace reason uses a fallback",
      grpc: { state: "not_configured", reason: " \n\t" },
      state: "unsupported",
      reason: "No emulator gRPC port is configured.",
    },
  ];
  test.each(failures)("$name", ({ grpc, state, reason }) => {
    const entries = androidEmulatorAudioCapabilities({ ...inputs, grpc });
    expect(entries).toEqual(grpcIds.map((id) => ({ id, state, source: "platform", reason })));
    for (const entry of entries) {
      expect(entry.reason?.trim().length).toBeGreaterThan(0);
    }
  });

  test("-no-audio leaves gRPC available and preserves the existing audio entries", () => {
    const entries = androidEmulatorAudioCapabilities({
      ...inputs,
      config: { "hw.audioInput": "yes", "hw.audioOutput": "yes" },
      launchWithoutAudio: true,
      grpc: { state: "reachable" },
    });
    expect(entries).toEqual([
      ...["android.emulator.audioInput", "android.emulator.audioOutput"].map((id) => ({
        id,
        state: "unsupported" as const,
        source: "platform" as const,
        reason: "The emulator is launched with -no-audio (AUTOMOBILE_EMULATOR_AUDIO=false).",
      })),
      ...grpcIds.map((id) => ({ id, state: "available" as const, source: "platform" as const })),
    ]);
    for (const entry of entries.filter((entry) => entry.state === "unsupported")) {
      expect(entry.reason?.trim().length).toBeGreaterThan(0);
    }
  });
});
