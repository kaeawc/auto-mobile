import { describe, expect, test } from "bun:test";
import { ActionableError } from "../../../src/models/ActionableError";
import { FakeTimer } from "../../fakes/FakeTimer";
import { FakeGuestAudioCapture } from "../../fakes/FakeGuestAudioCapture";
import {
  DEFAULT_LOOP_MAX_DURATION_MS,
  EmulatorAudioService,
  FINISHED_INJECTIONS_KEPT,
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
  consolePorts: number[] = [5554],
  maxSourceBytes?: number,
  hostLoopback = false,
) {
  const sessions: FakeSession[] = [];
  const lookups: number[] = [];
  const guestCapture = new FakeGuestAudioCapture();
  const service = new EmulatorAudioService({
    guestCapture,
    discovery: {
      findByConsolePort: async (port) => {
        lookups.push(port);
        return consolePorts.includes(port) ? { ...ENDPOINT, consolePort: port } : undefined;
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
    createHostLoopbackSession: hostLoopback
      ? () => {
          const session = new FakeSession({ ...ENDPOINT, consolePort: 0 });
          prepare(session);
          sessions.push(session);
          return session;
        }
      : undefined,
    ids: new CountingIdGenerator("inj"),
    maxSourceBytes,
  });
  return { service, sessions, lookups, guestCapture, consolePorts };
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

  test("a read that comes back larger than the cap is refused before any device work", async () => {
    const { service, sessions } = setup({ "/big.wav": new Uint8Array(100) }, () => {}, [5554], 50);
    await expect(
      service.startInjection("emulator-5554", { source: { kind: "file", path: "/big.wav" } }),
    ).rejects.toThrow("larger than the 50-byte limit");
    expect(sessions).toHaveLength(0);
  });

  test("a failed start closes its session and leaves nothing active", async () => {
    const { service, sessions } = setup({}, (session) => {
      session.injectAudio = async () => {
        throw new Error("start failed");
      };
    });
    await expect(
      service.startInjection("emulator-5554", { source: { kind: "tone" } }),
    ).rejects.toThrow("start failed");
    expect(sessions[0].closed).toBe(1);
    expect(service.activeInjectionIds("emulator-5554")).toEqual([]);
  });

  test("stop is idempotent and returns the same result after the injection ends", async () => {
    const { service, sessions } = setup();
    const { injectionId } = await service.startInjection("emulator-5554", {
      source: { kind: "tone" },
    });
    const first = await service.stopInjection(injectionId);
    const second = await service.stopInjection(injectionId);
    expect(first).toEqual({ injectionId, framesQueued: 7, framesPlayed: 0, reason: "stopped" });
    expect(second).toEqual(first);
    expect(sessions[0].closed).toBe(1);
    expect(service.activeInjectionIds("emulator-5554")).toEqual([]);
  });

  test("a naturally finished injection can still be stopped without error", async () => {
    const { service, sessions } = setup();
    const { injectionId } = await service.startInjection("emulator-5554", {
      source: { kind: "tone" },
    });
    sessions[0].settleInjection?.({
      framesQueued: 96_000,
      framesPlayed: 96_000,
      reason: "completed",
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(await service.stopInjection(injectionId)).toEqual({
      injectionId,
      framesQueued: 96_000,
      framesPlayed: 96_000,
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

  test("a stop aimed at another device is refused, before and after the injection ends", async () => {
    const { service, sessions } = setup();
    const { injectionId } = await service.startInjection("emulator-5554", {
      source: { kind: "tone" },
    });
    await expect(service.stopInjection(injectionId, "emulator-5556")).rejects.toThrow(
      "is on emulator-5554, not emulator-5556",
    );
    expect(service.activeInjectionIds("emulator-5554")).toEqual([injectionId]);
    expect(await service.stopInjection(injectionId, "emulator-5554")).toMatchObject({
      reason: "stopped",
    });
    await expect(service.stopInjection(injectionId, "emulator-5556")).rejects.toThrow(
      "is on emulator-5554",
    );
    expect(sessions[0].closed).toBe(1);
  });

  test("an unknown injection id is an actionable error", async () => {
    const { service } = setup();
    await expect(service.stopInjection("nope")).rejects.toThrow(/No audio injection 'nope'/);
  });

  test("stopDevice stops only that device's injections", async () => {
    const { service, guestCapture } = setup({}, () => {}, [5554, 5556]);
    await service.startInjection("emulator-5554", { source: { kind: "tone" } });
    const other = await service.startInjection("emulator-5556", { source: { kind: "tone" } });
    expect(await service.stopDevice("emulator-5554")).toBe(1);
    expect(guestCapture.closed).toEqual(["emulator-5554"]);
    expect(service.activeInjectionIds("emulator-5554")).toEqual([]);
    expect(service.activeInjectionIds("emulator-5556")).toEqual([other.injectionId]);
  });

  test("only the most recent ended injections stay stoppable", async () => {
    const { service } = setup();
    const ids: string[] = [];
    for (let index = 0; index <= FINISHED_INJECTIONS_KEPT; index++) {
      // A 10 ms tone keeps 65 starts well inside the unit-test time budget.
      const { injectionId } = await service.startInjection("emulator-5554", {
        source: { kind: "tone", durationMs: 10 },
      });
      await service.stopInjection(injectionId);
      ids.push(injectionId);
    }
    await expect(service.stopInjection(ids[0])).rejects.toThrow(
      `Only the last ${FINISHED_INJECTIONS_KEPT} ended injections are kept`,
    );
    expect(await service.stopInjection(ids[1])).toMatchObject({ reason: "stopped" });
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
    const { service, guestCapture } = setup({}, () => {}, [5554, 5556]);
    const elsewhere = await service.startInjection("emulator-5556", {
      source: { kind: "tone" },
      sessionId: "s1",
    });
    const mine = await service.startInjection("emulator-5554", {
      source: { kind: "tone" },
      sessionId: "s1",
    });

    expect(service.stopOwnedBy("emulator-5554", "s3")).toBeUndefined();
    expect(await service.stopOwnedBy("emulator-5554", "s1")).toBe(1);
    expect(guestCapture.closed).toEqual(["emulator-5554"]);
    expect(service.activeInjectionIds("emulator-5554")).toEqual([]);
    expect(service.activeInjectionIds("emulator-5556")).toEqual([elsewhere.injectionId]);
    expect(await service.stopInjection(mine.injectionId)).toMatchObject({ reason: "stopped" });
  });

  test("stopOwnerless closes its recorder and preserves another device's owned injection", async () => {
    const { service, guestCapture } = setup({}, () => {}, [5554, 5556]);
    const owned = await service.startInjection("emulator-5556", {
      source: { kind: "tone" },
      sessionId: "s1",
    });
    expect(service.stopOwnerless("emulator-5556")).toBeUndefined();
    await service.startInjection("emulator-5554", { source: { kind: "tone" } });
    expect(await service.stopOwnerless("emulator-5554")).toBe(1);
    expect(guestCapture.closed).toEqual(["emulator-5554"]);
    expect(service.activeInjectionIds("emulator-5556")).toEqual([owned.injectionId]);
  });

  test("a loop without its own limit is capped; a single pass is not", async () => {
    const { service, sessions, guestCapture } = setup();
    const first = await service.startInjection("emulator-5554", {
      source: { kind: "tone" },
      loop: true,
    });
    await service.stopInjection(first.injectionId);
    const second = await service.startInjection("emulator-5554", { source: { kind: "tone" } });
    await service.stopInjection(second.injectionId);
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
    expect(guestCapture.openOptions).toEqual([
      { leaseMs: DEFAULT_LOOP_MAX_DURATION_MS + 60_000 },
      { leaseMs: 62_000 },
      { leaseMs: 65_000 },
    ]);
  });
});

describe("EmulatorAudioService capture", () => {
  test("a stream closes its device session once stopped, even when the stop fails", async () => {
    const { service, sessions } = setup({}, (session) => {
      session.streamStopError = new Error("stream broke");
    });
    const received: number[] = [];
    const stream = await service.startStream("emulator-5554", (pcm) => {
      received.push(...pcm);
    });
    void sessions[0].streamSink?.(Uint8Array.from([1, 2]));
    await expect(stream.stop()).rejects.toThrow("stream broke");
    await expect(stream.stop()).rejects.toThrow("stream broke");
    expect(received).toEqual([1, 2]);
    expect(sessions[0].streamStops).toBe(1);
    expect(sessions[0].closed).toBe(1);
  });

  test("a stream on a device with no route is audio_capture_unsupported", async () => {
    const { service } = setup();
    await expect(service.startStream("R58M123ABC", () => {})).rejects.toMatchObject({
      code: "audio_capture_unsupported",
    });
  });

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
    expect(sessions[0].captureRequests).toEqual([{ durationMs: 100, sampleRate: undefined }]);
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

describe("verified guest capture guard", () => {
  test("one hour loop leases capture through its start delay and margin", async () => {
    const { service, guestCapture } = setup();
    const started = await service.startInjection("emulator-5554", {
      source: { kind: "tone", durationMs: 10 },
      loop: true,
      startDelayMs: 60_000,
      maxDurationMs: 3_600_000,
    });
    expect(guestCapture.openOptions).toEqual([{ leaseMs: 3_720_000 }]);
    await service.stopInjection(started.injectionId);
  });

  test("single pass lease derives duration from PCM sample rate and channels", async () => {
    const wav = encodeWav({ sampleRate: 16_000, channels: 2, samples: new Int16Array(100) });
    const { service, guestCapture } = setup({ "/clip.wav": wav });
    const started = await service.startInjection("emulator-5554", {
      source: { kind: "file", path: "/clip.wav" },
      startDelayMs: 100,
    });
    expect(guestCapture.openOptions).toEqual([{ leaseMs: 60_104 }]);
    await service.stopInjection(started.injectionId);
  });

  test("lease above the 3720000 ms limit is refused before capture or injection", async () => {
    const { service, guestCapture, sessions } = setup();
    const starting = service.startInjection("emulator-5554", {
      source: { kind: "tone", durationMs: 10 },
      loop: true,
      startDelayMs: 60_001,
      maxDurationMs: 3_600_000,
    });
    await expect(starting).rejects.toBeInstanceOf(ActionableError);
    await expect(starting).rejects.toThrow("3720000");
    expect(guestCapture.opened).toEqual([]);
    expect(sessions).toEqual([]);
    expect(service.activeInjectionIds("emulator-5554")).toEqual([]);
  });

  test("refuses an unverified capture without calling injectAudio", async () => {
    const { service, sessions, guestCapture } = setup();
    guestCapture.failure = new EmulatorAudioError(
      "audio_guest_capture_unavailable",
      "Cannot verify capture",
    );
    await expect(
      service.startInjection("emulator-5554", { source: { kind: "tone" } }),
    ).rejects.toThrow("[audio_guest_capture_unavailable]");
    expect(sessions.flatMap((session) => session.injected)).toEqual([]);
    expect(service.activeInjectionIds("emulator-5554")).toEqual([]);
  });

  test("waits for capture verification before creating the gRPC session", async () => {
    const { service, sessions, guestCapture } = setup();
    let verified: (() => void) | undefined;
    let entered: (() => void) | undefined;
    const opening = new Promise<void>((resolve) => {
      entered = resolve;
    });
    guestCapture.onOpen = () => {
      entered?.();
      return new Promise<void>((resolve) => {
        verified = resolve;
      });
    };
    const starting = service.startInjection("emulator-5554", { source: { kind: "tone" } });
    await opening;
    expect(guestCapture.opened).toEqual(["emulator-5554"]);
    expect(sessions).toEqual([]);
    verified?.();
    const started = await starting;
    expect(sessions[0].injected).toHaveLength(1);
    await service.stopInjection(started.injectionId);
    expect(guestCapture.closed).toEqual(["emulator-5554"]);
  });

  for (const reason of ["completed", "max_duration"] as const) {
    test(`closes the recorder on ${reason}`, async () => {
      const { service, sessions, guestCapture } = setup();
      const started = await service.startInjection("emulator-5554", { source: { kind: "tone" } });
      const closed = new Promise<void>((resolve) => {
        guestCapture.onClose = resolve;
      });
      sessions[0].settleInjection?.({ framesQueued: 2, framesPlayed: 2, reason });
      await closed;
      expect(guestCapture.closed).toEqual(["emulator-5554"]);
      expect(await service.stopInjection(started.injectionId)).toMatchObject({ reason });
      expect(guestCapture.closed).toEqual(["emulator-5554"]);
    });
  }

  test("maxDurationMs closes the capture without an explicit stop", async () => {
    const timer = new FakeTimer();
    const { service, guestCapture } = setup({}, (session) => {
      const inject = session.injectAudio.bind(session);
      session.injectAudio = async (pcm, options) => {
        const injection = await inject(pcm, options);
        timer.setTimeout(
          () =>
            session.settleInjection?.({ framesQueued: 1, framesPlayed: 1, reason: "max_duration" }),
          options?.maxDurationMs ?? 0,
        );
        return injection;
      };
    });
    const started = await service.startInjection("emulator-5554", {
      source: { kind: "tone" },
      loop: true,
      maxDurationMs: 100,
    });
    const closed = new Promise<void>((resolve) => {
      guestCapture.onClose = resolve;
    });
    timer.advanceTime(99);
    expect(guestCapture.closed).toEqual([]);
    timer.advanceTime(1);
    await closed;
    expect(guestCapture.closed).toEqual(["emulator-5554"]);
    expect(await service.stopInjection(started.injectionId)).toMatchObject({
      reason: "max_duration",
    });
  });

  test("a session factory failure after capture opens closes the recorder", async () => {
    const { service, guestCapture } = setup({}, () => {
      throw new Error("factory failed");
    });
    await expect(
      service.startInjection("emulator-5554", { source: { kind: "tone" } }),
    ).rejects.toThrow("factory failed");
    expect(guestCapture.closed).toEqual(["emulator-5554"]);
  });

  test("closes the recorder on failed start and allows retry", async () => {
    const { service, guestCapture, sessions } = setup({}, (session) => {
      session.injectAudio = async () => {
        throw new Error("start failed");
      };
    });
    for (let i = 0; i < 2; i++) {
      await expect(
        service.startInjection("emulator-5554", { source: { kind: "tone" } }),
      ).rejects.toThrow("start failed");
    }
    expect(guestCapture.closed).toEqual(["emulator-5554", "emulator-5554"]);
    expect(sessions.every((session) => session.closed === 1)).toBe(true);
  });

  for (const alive of [true, false]) {
    test(`stop classifies gRPC failure when emulator alive=${alive}`, async () => {
      const { service, guestCapture, sessions, consolePorts } = setup();
      const started = await service.startInjection("emulator-5554", { source: { kind: "tone" } });
      if (!alive) {
        consolePorts.length = 0;
      }
      const closed = new Promise<void>((resolve) => {
        guestCapture.onClose = resolve;
      });
      sessions[0].failInjection?.(
        new EmulatorAudioError("audio_injection_unsupported", "read ECONNRESET"),
      );
      await closed;
      await expect(service.stopInjection(started.injectionId)).rejects.toMatchObject({
        code: alive ? "audio_injection_unsupported" : "audio_emulator_exited",
      });
      if (!alive) {
        await expect(service.stopInjection(started.injectionId)).rejects.toThrow(
          "Emulator emulator-5554 exited during audio injection",
        );
      }
      expect(guestCapture.closed).toEqual(["emulator-5554"]);
      expect(sessions[0].closed).toBe(1);
    });
  }

  test("rejects overlapping starts before opening a second recorder", async () => {
    const { service, guestCapture } = setup();
    const first = service.startInjection("emulator-5554", { source: { kind: "tone" } });
    await expect(
      service.startInjection("emulator-5554", { source: { kind: "tone" } }),
    ).rejects.toMatchObject({ code: "audio_injection_busy" });
    await service.stopInjection((await first).injectionId);
    expect(guestCapture.opened).toHaveLength(1);
  });
});

describe("EmulatorAudioService iOS Simulators over the host loopback", () => {
  const SIM_A = "11111111-2222-3333-4444-555555555555";
  const SIM_B = "AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE";

  test("a simulator UDID injects and captures through the host loopback route", async () => {
    const { service, lookups, guestCapture } = setup({}, () => {}, [5554], undefined, true);
    guestCapture.failure = new Error("Android capture must not run for a simulator");
    const started = await service.startInjection(SIM_A, { source: { kind: "tone" } });
    expect(started.route).toBe("host-loopback");
    expect(lookups).toEqual([]);
    expect((await service.capture(SIM_A, { durationMs: 10 })).route).toBe("host-loopback");
    await service.stopInjection(started.injectionId);
    expect(guestCapture.opened).toEqual([]);
    expect(guestCapture.closed).toEqual([]);
    expect(lookups).toEqual([]);
  });

  test("a failed host-loopback injection preserves its error without checking an emulator PID", async () => {
    const { service, sessions, lookups, guestCapture } = setup(
      {},
      () => {},
      [5554],
      undefined,
      true,
    );
    const started = await service.startInjection(SIM_A, { source: { kind: "tone" } });
    sessions[0].failInjection?.(new EmulatorAudioError("audio_loopback_failed", "helper exited"));
    await expect(service.stopInjection(started.injectionId)).rejects.toMatchObject({
      code: "audio_loopback_failed",
    });
    expect(sessions[0].closed).toBe(1);
    expect(guestCapture.opened).toEqual([]);
    expect(lookups).toEqual([]);
    expect((await service.startInjection(SIM_B, { source: { kind: "tone" } })).route).toBe(
      "host-loopback",
    );
  });

  test("one host-loopback injection runs per host, across simulators", async () => {
    const { service } = setup({}, () => {}, [5554], undefined, true);
    const first = await service.startInjection(SIM_A, { source: { kind: "tone" } });
    await expect(service.startInjection(SIM_B, { source: { kind: "tone" } })).rejects.toMatchObject(
      { code: "audio_injection_busy" },
    );
    // An emulator has its own route and is unaffected.
    expect(
      (await service.startInjection("emulator-5554", { source: { kind: "tone" } })).route,
    ).toBe("emulator-grpc");
    await service.stopInjection(first.injectionId);
    expect((await service.startInjection(SIM_B, { source: { kind: "tone" } })).route).toBe(
      "host-loopback",
    );
  });

  test("a second start racing the first's start is refused", async () => {
    const { service } = setup({}, () => {}, [5554], undefined, true);
    const [first, second] = await Promise.allSettled([
      service.startInjection(SIM_A, { source: { kind: "tone" } }),
      service.startInjection(SIM_B, { source: { kind: "tone" } }),
    ]);
    expect(first.status).toBe("fulfilled");
    expect(second).toMatchObject({ status: "rejected", reason: { code: "audio_injection_busy" } });
  });

  test("a failed start frees the host loopback", async () => {
    let fail = true;
    const { service } = setup(
      {},
      (session) => {
        if (fail) {
          session.injectAudio = async () => {
            throw new Error("no loopback");
          };
        }
      },
      [5554],
      undefined,
      true,
    );
    await expect(service.startInjection(SIM_A, { source: { kind: "tone" } })).rejects.toThrow(
      "no loopback",
    );
    fail = false;
    expect((await service.startInjection(SIM_A, { source: { kind: "tone" } })).route).toBe(
      "host-loopback",
    );
  });

  test("without a host loopback session a simulator is unsupported", async () => {
    const { service } = setup();
    await expect(service.startInjection(SIM_A, { source: { kind: "tone" } })).rejects.toMatchObject(
      { code: "audio_injection_unsupported" },
    );
  });
});
