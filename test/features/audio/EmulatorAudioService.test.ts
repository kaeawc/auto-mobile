import { describe, expect, test } from "bun:test";
import {
  DEFAULT_LOOP_MAX_DURATION_MS,
  EmulatorAudioService,
  MAX_AUDIO_SOURCE_BYTES,
} from "../../../src/features/audio/EmulatorAudioService";
import { FakeEmulatorAudioSession as FakeSession } from "../../fakes/FakeEmulatorAudioSession";
import { EmulatorAudioError } from "../../../src/utils/android-cmdline-tools/emulatorGrpc/EmulatorAudioError";
import type { EmulatorGrpcEndpoint } from "../../../src/utils/android-cmdline-tools/emulatorGrpc/emulatorGrpcDiscovery";
import { encodeWav, sineTone } from "../../../src/utils/audio/pcm";
import { CountingIdGenerator } from "../../../src/utils/CountingIdGenerator";

const ENDPOINT: EmulatorGrpcEndpoint = {
  pid: 1,
  consolePort: 5554,
  address: "localhost:8554",
  auth: { kind: "none" },
  descriptionFile: "pid_1.ini",
};

function setup(
  files: Record<string, Uint8Array> = {},
  prepare: (session: FakeSession) => void = () => {},
) {
  const sessions: FakeSession[] = [];
  const lookups: number[] = [];
  const service = new EmulatorAudioService({
    discovery: {
      findByConsolePort: async (port) => {
        lookups.push(port);
        return port === 5554 ? ENDPOINT : undefined;
      },
    },
    createSession: (endpoint) => {
      const session = new FakeSession(endpoint);
      prepare(session);
      sessions.push(session);
      return session;
    },
    readFile: async (path) => {
      const bytes = files[path];
      if (!bytes) {
        throw new Error(`ENOENT ${path}`);
      }
      return bytes;
    },
    fileSize: async (path) => files[path]?.byteLength ?? MAX_AUDIO_SOURCE_BYTES + 1,
    ids: new CountingIdGenerator("inj"),
  });
  return { service, sessions, lookups };
}

describe("EmulatorAudioService injection", () => {
  test("starts a tone on the emulator matching the serial's console port", async () => {
    const { service, sessions, lookups } = setup();
    const started = await service.startInjection("emulator-5554", { source: { kind: "tone" } });
    expect(started).toEqual({
      injectionId: "inj-1",
      deviceId: "emulator-5554",
      durationMs: 100,
      sampleRate: 48_000,
      route: "emulator-grpc",
    });
    expect(lookups).toEqual([5554]);
    expect(sessions[0].injected[0].samples.length).toBe(96_000);
    expect(service.activeInjectionIds("emulator-5554")).toEqual(["inj-1"]);
  });

  test("decodes a WAV file and applies gain", async () => {
    const wav = encodeWav({ sampleRate: 16_000, channels: 1, samples: Int16Array.from([1000]) });
    const { service, sessions } = setup({ "/clip.wav": wav });
    await service.startInjection("emulator-5554", {
      source: { kind: "file", path: "/clip.wav" },
      gainDb: 6,
    });
    expect(Array.from(sessions[0].injected[0].samples)).toEqual([1995]);
  });

  test("rejects an oversized file before reading it", async () => {
    const { service, sessions } = setup();
    await expect(
      service.startInjection("emulator-5554", { source: { kind: "file", path: "/huge.wav" } }),
    ).rejects.toThrow(/limit/);
    expect(sessions).toHaveLength(0);
  });

  test("stop is idempotent and returns the same result after the injection ends", async () => {
    const { service, sessions } = setup();
    const { injectionId } = await service.startInjection("emulator-5554", {
      source: { kind: "tone" },
    });
    const first = await service.stopInjection(injectionId);
    const second = await service.stopInjection(injectionId);
    expect(first).toEqual({ injectionId, framesSent: 7, reason: "stopped" });
    expect(second).toEqual(first);
    expect(sessions[0].closed).toBe(1);
    expect(service.activeInjectionIds("emulator-5554")).toEqual([]);
  });

  test("a naturally finished injection can still be stopped without error", async () => {
    const { service, sessions } = setup();
    const { injectionId } = await service.startInjection("emulator-5554", {
      source: { kind: "tone" },
    });
    sessions[0].settleInjection?.({ framesSent: 96_000, reason: "completed" });
    await Promise.resolve();
    await Promise.resolve();
    expect(await service.stopInjection(injectionId)).toEqual({
      injectionId,
      framesSent: 96_000,
      reason: "completed",
    });
  });

  test("a failed injection reports its error on stop", async () => {
    const { service, sessions } = setup();
    const { injectionId } = await service.startInjection("emulator-5554", {
      source: { kind: "tone" },
    });
    sessions[0].failInjection?.(new EmulatorAudioError("audio_injection_busy", "busy"));
    await expect(service.stopInjection(injectionId)).rejects.toMatchObject({
      code: "audio_injection_busy",
    });
    await expect(service.stopInjection(injectionId)).rejects.toMatchObject({
      code: "audio_injection_busy",
    });
  });

  test("an unknown injection id is an actionable error", async () => {
    const { service } = setup();
    await expect(service.stopInjection("nope")).rejects.toThrow(/No audio injection 'nope'/);
  });

  test("stopDevice stops only that device's injections", async () => {
    const { service } = setup();
    await service.startInjection("emulator-5554", { source: { kind: "tone" } });
    await service.startInjection("emulator-5554", { source: { kind: "tone" } });
    expect(await service.stopDevice("emulator-5554")).toBe(2);
    expect(await service.stopDevice("emulator-5556")).toBe(0);
    expect(service.activeInjectionIds("emulator-5554")).toEqual([]);
  });

  test("physical devices and emulators without gRPC get typed unsupported errors", async () => {
    const { service } = setup();
    await expect(
      service.startInjection("R58M123ABC", { source: { kind: "tone" } }),
    ).rejects.toMatchObject({ code: "audio_injection_unsupported" });
    await expect(
      service.startInjection("emulator-5556", { source: { kind: "tone" } }),
    ).rejects.toMatchObject({ code: "audio_injection_unsupported" });
    await expect(service.capture("emulator-5556", { durationMs: 100 })).rejects.toMatchObject({
      code: "audio_capture_unsupported",
    });
  });
});

describe("EmulatorAudioService session ownership and limits", () => {
  test("stopOwnedBy stops only the session's injections on that device", async () => {
    const { service } = setup();
    const mine = await service.startInjection("emulator-5554", {
      source: { kind: "tone" },
      sessionId: "s1",
    });
    const other = await service.startInjection("emulator-5554", {
      source: { kind: "tone" },
      sessionId: "s2",
    });
    expect(service.stopOwnedBy("emulator-5554", "s3")).toBeUndefined();
    expect(await service.stopOwnedBy("emulator-5554", "s1")).toBe(1);
    expect(service.activeInjectionIds("emulator-5554")).toEqual([other.injectionId]);
    expect(await service.stopInjection(mine.injectionId)).toMatchObject({ reason: "stopped" });
  });

  test("a loop without its own limit is capped; a single pass is not", async () => {
    const { service, sessions } = setup();
    await service.startInjection("emulator-5554", { source: { kind: "tone" }, loop: true });
    await service.startInjection("emulator-5554", { source: { kind: "tone" } });
    await service.startInjection("emulator-5554", {
      source: { kind: "tone" },
      loop: true,
      maxDurationMs: 5_000,
    });
    expect(sessions.map((session) => session.injectOptions[0]?.maxDurationMs)).toEqual([
      DEFAULT_LOOP_MAX_DURATION_MS,
      undefined,
      5_000,
    ]);
  });
});

describe("EmulatorAudioService capture", () => {
  test("reports levels with the requested threshold and closes the session", async () => {
    const { service, sessions } = setup({}, (session) => {
      session.captureSamples = sineTone({ durationMs: 100, amplitudeDbfs: -30 }).samples;
    });
    const result = await service.capture("emulator-5554", {
      durationMs: 100,
      silenceThresholdDbfs: -40,
    });
    expect(result).toMatchObject({
      silent: false,
      timedOut: false,
      durationMs: 100,
      route: "emulator-grpc",
    });
    expect(sessions[0].closed).toBe(1);
  });

  test("an empty, timed-out capture is silent", async () => {
    const { service } = setup({}, (session) => {
      session.captureTimedOut = true;
    });
    expect(await service.capture("emulator-5554", { durationMs: 100 })).toMatchObject({
      silent: true,
      timedOut: true,
      durationMs: 0,
    });
  });
});
