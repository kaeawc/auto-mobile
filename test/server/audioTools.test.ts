import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { SessionManager } from "../../src/daemon/sessionManager";
import { registerEmulatorAudioSessionCleanup } from "../../src/daemon/emulatorAudioSessionCleanup";
import { EmulatorAudioService } from "../../src/features/audio/EmulatorAudioService";
import {
  captureAudioSchema,
  createCaptureAudioHandler,
  createInjectAudioInputHandler,
  createStopAudioInputHandler,
  injectAudioInputSchema,
  MAX_CAPTURE_SECONDS,
} from "../../src/server/audioTools";
import {
  captureAudioResultSchema,
  injectAudioInputResultSchema,
  stopAudioInputResultSchema,
} from "../../src/server/audioToolOutputSchemas";
import type { BootedDevice } from "../../src/models";
import { parseWav, sineTone } from "../../src/utils/audio/pcm";
import { CountingIdGenerator } from "../../src/utils/CountingIdGenerator";
import { FakeDbWriteBarrier } from "../fakes/FakeDbWriteBarrier";
import { FakeDeviceSessionPersistence } from "../fakes/FakeDeviceSessionPersistence";
import { FakeEmulatorAudioSession } from "../fakes/FakeEmulatorAudioSession";
import { FakeTimer } from "../fakes/FakeTimer";

const emulator: BootedDevice = { name: "emu", platform: "android", deviceId: "emulator-5554" };
const simulator: BootedDevice = { name: "sim", platform: "ios", deviceId: "UDID-1" };

function structured(response: unknown): unknown {
  return (response as { structuredContent?: unknown }).structuredContent;
}

describe("audio tools (#13628, #13629)", () => {
  let timer: FakeTimer;
  let manager: SessionManager;
  let sessions: FakeEmulatorAudioSession[];
  let service: EmulatorAudioService;
  let saved: Array<{ deviceId: string; bytes: Uint8Array }>;
  let deps: Parameters<typeof createInjectAudioInputHandler>[0];

  beforeEach(() => {
    timer = new FakeTimer();
    manager = new SessionManager(timer, new FakeDeviceSessionPersistence(), {
      barrier: () => new FakeDbWriteBarrier(),
    });
    sessions = [];
    saved = [];
    service = new EmulatorAudioService({
      discovery: {
        findByConsolePort: async (port) => ({
          pid: 1,
          consolePort: port,
          address: `localhost:${port + 3000}`,
          auth: { kind: "none" },
          descriptionFile: "pid_1.ini",
        }),
      },
      createSession: (endpoint) => {
        const session = new FakeEmulatorAudioSession(endpoint);
        session.captureSamples = sineTone({ durationMs: 500 }).samples;
        sessions.push(session);
        return session;
      },
      readFile: async () => new Uint8Array(0),
      fileSize: async () => 0,
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
    expect(stopped).toMatchObject({ injectionId: "inj-1", reason: "stopped", framesSent: 7 });
  });

  test("passing both file and tone is refused before any device work", async () => {
    await expect(
      createInjectAudioInputHandler(deps)(emulator, { file: "/a.wav", tone: {} }),
    ).rejects.toThrow("not both");
    expect(sessions).toHaveLength(0);
  });

  test("iOS is refused for injection and capture", async () => {
    await expect(createInjectAudioInputHandler(deps)(simulator, { tone: {} })).rejects.toThrow(
      "Android emulators only",
    );
    await expect(createCaptureAudioHandler(deps)(simulator, { seconds: 1 })).rejects.toThrow(
      "Android emulators only",
    );
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
  });

  test("a released session cannot start an injection", async () => {
    await manager.createSession("session-1", emulator.deviceId, "android");
    await manager.releaseSession("session-1", "explicit-release");
    await expect(
      createInjectAudioInputHandler(deps)(emulator, { tone: {}, sessionUuid: "session-1" }),
    ).rejects.toThrow("Cannot inject emulator audio");
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
});
