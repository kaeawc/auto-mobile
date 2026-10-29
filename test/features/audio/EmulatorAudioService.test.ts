import { describe, expect, test } from "bun:test";
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
  const service = new EmulatorAudioService({
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
    const { service } = setup({}, () => {}, [5554, 5556]);
    await service.startInjection("emulator-5554", { source: { kind: "tone" } });
    await service.startInjection("emulator-5554", { source: { kind: "tone" } });
    const other = await service.startInjection("emulator-5556", { source: { kind: "tone" } });
    expect(await service.stopDevice("emulator-5554")).toBe(2);
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
    const { service } = setup({}, () => {}, [5554, 5556]);
    const elsewhere = await service.startInjection("emulator-5556", {
      source: { kind: "tone" },
      sessionId: "s1",
    });
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
    expect(service.activeInjectionIds("emulator-5556")).toEqual([elsewhere.injectionId]);
    expect(await service.stopInjection(mine.injectionId)).toMatchObject({ reason: "stopped" });
  });

  test("stopOwnerless stops only sessionless injections on that device", async () => {
    const { service } = setup();
    const owned = await service.startInjection("emulator-5554", {
      source: { kind: "tone" },
      sessionId: "s1",
    });
    expect(service.stopOwnerless("emulator-5554")).toBeUndefined();
    await service.startInjection("emulator-5554", { source: { kind: "tone" } });
    expect(await service.stopOwnerless("emulator-5554")).toBe(1);
    expect(service.activeInjectionIds("emulator-5554")).toEqual([owned.injectionId]);
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
  test("a stream closes its device session once stopped, even when the stop fails", async () => {
    const { service, sessions } = setup({}, (session) => {
      session.streamStopError = new Error("stream broke");
    });
    const received: number[] = [];
    const stream = await service.startStream("emulator-5554", (pcm) => received.push(...pcm));
    sessions[0].streamSink?.(Uint8Array.from([1, 2]));
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

describe("EmulatorAudioService iOS Simulators over the host loopback", () => {
  const SIM_A = "11111111-2222-3333-4444-555555555555";
  const SIM_B = "AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE";

  test("a simulator UDID injects and captures through the host loopback route", async () => {
    const { service, lookups } = setup({}, () => {}, [5554], undefined, true);
    const started = await service.startInjection(SIM_A, { source: { kind: "tone" } });
    expect(started.route).toBe("host-loopback");
    expect(lookups).toEqual([]);
    expect((await service.capture(SIM_A, { durationMs: 10 })).route).toBe("host-loopback");
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
