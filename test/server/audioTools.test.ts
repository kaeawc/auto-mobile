import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { SessionManager } from "../../src/daemon/sessionManager";
import { registerEmulatorAudioSessionCleanup } from "../../src/daemon/emulatorAudioSessionCleanup";
import { EmulatorAudioService } from "../../src/features/audio/EmulatorAudioService";
import {
  captureAudioSchema,
  createCaptureAudioHandler,
  createInjectAudioInputHandler,
  createStopAudioInputHandler,
  createToolOutputsWavSaver,
  injectAudioInputSchema,
  MAX_CAPTURE_SECONDS,
} from "../../src/server/audioTools";
import {
  captureAudioResultSchema,
  injectAudioInputResultSchema,
  stopAudioInputResultSchema,
} from "../../src/server/audioToolOutputSchemas";
import type { BootedDevice } from "../../src/models";
import { encodeWav, parseWav, sineTone } from "../../src/utils/audio/pcm";
import { CountingIdGenerator } from "../../src/utils/CountingIdGenerator";
import { FakeDbWriteBarrier } from "../fakes/FakeDbWriteBarrier";
import { FakeDeviceSessionPersistence } from "../fakes/FakeDeviceSessionPersistence";
import { FakeEmulatorAudioSession } from "../fakes/FakeEmulatorAudioSession";
import { FakeGuestAudioCapture } from "../fakes/FakeGuestAudioCapture";
import { EmulatorAudioError } from "../../src/utils/android-cmdline-tools/emulatorGrpc/EmulatorAudioError";
import { FakeTimer } from "../fakes/FakeTimer";

const emulator: BootedDevice = { name: "emu", platform: "android", deviceId: "emulator-5554" };
const physicalIos: BootedDevice = {
  name: "iPhone",
  platform: "ios",
  deviceId: "00008110-001A2B3C4D5E801E",
};

function structured(response: unknown): unknown {
  return (response as { structuredContent?: unknown }).structuredContent;
}

describe("audio tools (#13628, #13629)", () => {
  let timer: FakeTimer;
  let manager: SessionManager;
  let sessions: FakeEmulatorAudioSession[];
  let service: EmulatorAudioService;
  let guestCapture: FakeGuestAudioCapture;
  let emulatorAlive: boolean;
  let saved: Array<{ deviceId: string; bytes: Uint8Array }>;
  let readPaths: string[];
  let onCreateSession: () => void;
  let deps: Parameters<typeof createInjectAudioInputHandler>[0];

  beforeEach(() => {
    timer = new FakeTimer();
    manager = new SessionManager(timer, new FakeDeviceSessionPersistence(), {
      barrier: () => new FakeDbWriteBarrier(),
    });
    sessions = [];
    saved = [];
    readPaths = [];
    onCreateSession = () => {};
    guestCapture = new FakeGuestAudioCapture();
    emulatorAlive = true;
    service = new EmulatorAudioService({
      guestCapture,
      discovery: {
        findByConsolePort: async (port) =>
          emulatorAlive
            ? {
                pid: 1,
                consolePort: port,
                address: `localhost:${port + 3000}`,
                auth: { kind: "none" },
                descriptionFile: "pid_1.ini",
              }
            : undefined,
      },
      createSession: (endpoint) => {
        onCreateSession();
        const session = new FakeEmulatorAudioSession(endpoint);
        session.captureSamples = sineTone({ durationMs: 500 }).samples;
        sessions.push(session);
        return session;
      },
      readFile: async (path: string) => {
        readPaths.push(path);
        return encodeWav({ sampleRate: 16_000, channels: 1, samples: new Int16Array(160) });
      },
      ids: new CountingIdGenerator("inj"),
    });
    registerEmulatorAudioSessionCleanup(manager, service);
    deps = {
      service,
      sessionManager: () => manager,
      saveWav: async (deviceId, bytes) => {
        saved.push({ deviceId, bytes });
        return `/outputs/${deviceId}.wav`;
      },
    };
  });

  afterEach(() => {
    manager.stopCleanupTimer();
  });

  test("the tool refuses unverified capture without injecting", async () => {
    guestCapture.failure = new EmulatorAudioError(
      "audio_guest_capture_unavailable",
      "Cannot verify capture",
    );
    await expect(createInjectAudioInputHandler(deps)(emulator, { tone: {} })).rejects.toThrow(
      "[audio_guest_capture_unavailable]",
    );
    expect(sessions).toHaveLength(0);
  });

  for (const alive of [true, false]) {
    test(`stopAudioInput reports the correct failure with emulator alive=${alive}`, async () => {
      const started = injectAudioInputResultSchema.parse(
        structured(await createInjectAudioInputHandler(deps)(emulator, { tone: {} })),
      );
      emulatorAlive = alive;
      sessions[0].failInjection?.(
        new EmulatorAudioError("audio_injection_unsupported", "read ECONNRESET"),
      );
      await expect(
        createStopAudioInputHandler(deps)(emulator, { injectionId: started.injectionId }),
      ).rejects.toThrow(
        alive
          ? "[audio_injection_unsupported]"
          : "[audio_emulator_exited] Emulator emulator-5554 exited during audio injection",
      );
      expect(guestCapture.closed).toEqual([emulator.deviceId]);
    });
  }

  test("schemas are strict and bound capture length", () => {
    expect(injectAudioInputSchema.safeParse({ tone: {} }).success).toBe(true);
    expect(injectAudioInputSchema.safeParse({ tone: { volume: 3 } }).success).toBe(false);
    expect(captureAudioSchema.safeParse({ seconds: MAX_CAPTURE_SECONDS }).success).toBe(true);
    expect(captureAudioSchema.safeParse({ seconds: MAX_CAPTURE_SECONDS + 1 }).success).toBe(false);
    expect(captureAudioSchema.safeParse({ seconds: 1, extra: true }).success).toBe(false);
  });

  test("inject then stop returns schema-valid results", async () => {
    const inject = createInjectAudioInputHandler(deps);
    const started = injectAudioInputResultSchema.parse(
      structured(await inject(emulator, { tone: { durationMs: 500 } })),
    );
    expect(started).toMatchObject({ injectionId: "inj-1", deviceId: "emulator-5554" });

    const stop = createStopAudioInputHandler(deps);
    const stopped = stopAudioInputResultSchema.parse(
      structured(await stop(emulator, { injectionId: started.injectionId })),
    );
    expect(stopped).toMatchObject({
      injectionId: "inj-1",
      reason: "stopped",
      framesQueued: 7,
      framesPlayed: 0,
    });
  });

  test("stopAudioInput refuses an injection running on another emulator", async () => {
    const started = injectAudioInputResultSchema.parse(
      structured(await createInjectAudioInputHandler(deps)(emulator, { tone: {} })),
    );
    const other: BootedDevice = { name: "emu2", platform: "android", deviceId: "emulator-5556" };
    await expect(
      createStopAudioInputHandler(deps)(other, { injectionId: started.injectionId }),
    ).rejects.toThrow("is on emulator-5554, not emulator-5556");
    expect(service.activeInjectionIds(emulator.deviceId)).toEqual([started.injectionId]);
  });

  test("a relative WAV path is resolved to an absolute launch-directory path", async () => {
    await createInjectAudioInputHandler(deps)(emulator, { file: "fixtures/voice.wav" });
    expect(readPaths).toHaveLength(1);
    expect(path.isAbsolute(readPaths[0])).toBe(true);
    expect(readPaths[0].replaceAll("\\", "/").endsWith("fixtures/voice.wav")).toBe(true);
  });

  test("passing both file and tone is refused before any device work", async () => {
    await expect(
      createInjectAudioInputHandler(deps)(emulator, { file: "/a.wav", tone: {} }),
    ).rejects.toThrow("not both");
    expect(sessions).toHaveLength(0);
  });

  test("a physical iOS device has no route for injection or capture", async () => {
    await expect(
      createInjectAudioInputHandler(deps)(physicalIos, { tone: {} }),
    ).rejects.toMatchObject({ code: "audio_injection_unsupported" });
    await expect(
      createCaptureAudioHandler(deps)(physicalIos, { seconds: 1 }),
    ).rejects.toMatchObject({ code: "audio_capture_unsupported" });
  });

  test("a session's injection stops when the session is released", async () => {
    await manager.createSession("session-1", emulator.deviceId, "android");
    const started = injectAudioInputResultSchema.parse(
      structured(
        await createInjectAudioInputHandler(deps)(emulator, {
          tone: {},
          loop: true,
          sessionUuid: "session-1",
        }),
      ),
    );
    expect(service.activeInjectionIds(emulator.deviceId)).toEqual([started.injectionId]);

    await manager.releaseSession("session-1", "explicit-release");
    await manager.getPendingDeviceCleanup(emulator.deviceId);
    expect(service.activeInjectionIds(emulator.deviceId)).toEqual([]);
    expect(guestCapture.closed).toEqual([emulator.deviceId]);
  });

  test("an injection whose session is released while it starts is stopped", async () => {
    await manager.createSession("session-1", emulator.deviceId, "android");
    // Admitted when the start begins, released by the time it has connected.
    spyOn(manager, "isAdmittedForAutomation").mockReturnValueOnce(true).mockReturnValue(false);
    await expect(
      createInjectAudioInputHandler(deps)(emulator, {
        tone: {},
        loop: true,
        sessionUuid: "session-1",
      }),
    ).rejects.toThrow("released while the audio injection was starting");
    expect(service.activeInjectionIds(emulator.deviceId)).toEqual([]);
    expect(guestCapture.closed).toEqual([emulator.deviceId]);
  });

  test("a sessionless start cancelled while connecting is stopped, not left playing", async () => {
    const controller = new AbortController();
    // A session acquiring the device cancels the sessionless call mid-start.
    onCreateSession = () => controller.abort();
    await expect(
      createInjectAudioInputHandler(deps)(emulator, { tone: {} }, undefined, controller.signal),
    ).rejects.toThrow("cancelled while the audio injection was starting");
    expect(service.activeInjectionIds(emulator.deviceId)).toEqual([]);
    expect(guestCapture.closed).toEqual([emulator.deviceId]);
  });

  test("a released session cannot start an injection", async () => {
    await manager.createSession("session-1", emulator.deviceId, "android");
    await manager.releaseSession("session-1", "explicit-release");
    await expect(
      createInjectAudioInputHandler(deps)(emulator, { tone: {}, sessionUuid: "session-1" }),
    ).rejects.toThrow("Cannot inject audio");
    expect(sessions).toHaveLength(0);
  });

  test("capture reports levels and saves a WAV only when asked", async () => {
    const capture = createCaptureAudioHandler(deps);
    const plain = captureAudioResultSchema.parse(
      structured(await capture(emulator, { seconds: 0.5 })),
    );
    expect(plain).toMatchObject({ silent: false, durationMs: 500, timedOut: false });
    expect(plain.path).toBeUndefined();
    expect(saved).toHaveLength(0);

    const withFile = captureAudioResultSchema.parse(
      structured(await capture(emulator, { seconds: 0.5, saveArtifact: true })),
    );
    expect(withFile).toMatchObject({ path: "/outputs/emulator-5554.wav", sizeBytes: 48_044 });
    expect(parseWav(saved[0].bytes).samples.length).toBe(24_000);
  });

  test("the WAV saver gives captures in the same millisecond distinct files", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "capture-audio-"));
    try {
      const save = createToolOutputsWavSaver(
        { now: () => 1_700_000_000_123 },
        () => dir,
        new CountingIdGenerator("wav"),
      );
      const first = await save("emulator-5554", Uint8Array.from([1]));
      const second = await save("emulator-5554", Uint8Array.from([2]));
      expect(first).not.toBe(second);
      expect(path.basename(first)).toBe("1700000000123-captureAudio-emulator-5554-wav-1.wav");
      expect(existsSync(first) && existsSync(second)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
