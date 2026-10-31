import { describe, expect, spyOn, test } from "bun:test";
import {
  EmulatorAudioClient,
  INJECT_AUDIO_METHOD,
  type InjectAudioOptions,
  prepareForInjection,
  STREAM_AUDIO_METHOD,
} from "../../../../src/utils/android-cmdline-tools/emulatorGrpc/EmulatorAudioClient";
import { EmulatorAudioError } from "../../../../src/utils/android-cmdline-tools/emulatorGrpc/EmulatorAudioError";
import type { GrpcAuthorizer } from "../../../../src/utils/android-cmdline-tools/emulatorGrpc/emulatorGrpcAuth";
import {
  decodeAudioFormat,
  decodeAudioPacket,
  encodeAudioPacket,
} from "../../../../src/utils/android-cmdline-tools/emulatorGrpc/emulatorAudioMessages";
import { GrpcStatus } from "../../../../src/utils/android-cmdline-tools/emulatorGrpc/grpcFraming";
import { analyzeLevels, sineTone, type PcmAudio } from "../../../../src/utils/audio/pcm";
import { SilenceFiller } from "../../../../src/utils/android-cmdline-tools/emulatorGrpc/SilenceFiller";
import { FakeGrpcTransport } from "../../../fakes/FakeGrpcTransport";
import { FakeTimer } from "../../../fakes/FakeTimer";
import {
  drainUntil,
  drainMicrotasks,
  settleByFakeEvents,
} from "../../../helpers/fakeTimerStepping";

function tokenAuthorizer(): GrpcAuthorizer & { disposed: number } {
  const authorizer = {
    disposed: 0,
    authorization: async () => "Bearer t",
    dispose: async () => {
      authorizer.disposed++;
    },
  };
  return authorizer;
}

function setup(manualAcceptance = false) {
  const transport = new FakeGrpcTransport();
  const timer = new FakeTimer();
  const authorizer = tokenAuthorizer();
  const client = new EmulatorAudioClient(transport, authorizer, timer);
  if (!manualAcceptance) {
    const inject = client.injectAudio.bind(client);
    // Drive only startup waits; streaming deadlines remain under each test's control.
    client.injectAudio = (source, options) =>
      settleByFakeEvents(timer, inject(source, options), { description: "injection startup" });
  }
  return { transport, timer, authorizer, client };
}

/** 100ms of 16kHz mono tone = 1600 frames = 5 packets of 20ms. */
const CLIP = sineTone({ durationMs: 100, sampleRate: 16_000 });

function sentFrames(written: Uint8Array[]): number {
  return written.reduce((sum, message) => sum + decodeAudioPacket(message).audio.byteLength / 2, 0);
}

describe("EmulatorAudioClient.injectAudio", () => {
  test.each([GrpcStatus.PERMISSION_DENIED, GrpcStatus.INVALID_ARGUMENT])(
    "rejects headers status %i at call time without waiting for close",
    async (code) => {
      const { client, transport, timer } = setup();
      const status = { code, message: "refused" };
      transport.onOpen = (call) => call.respondHeaders(status);
      const error = await client.injectAudio(CLIP).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(EmulatorAudioError);
      expect(error).toMatchObject({ code: "audio_grpc_failed", grpcStatus: status });
      expect(transport.calls[0].written).toHaveLength(0);
      expect(transport.calls[0].ended).toBe(false);
      expect(timer.getPendingTimeoutCount()).toBe(0);
      expect(timer.now()).toBe(0);
    },
  );

  test.each([undefined, GrpcStatus.OK, GrpcStatus.CANCELLED])(
    "accepts headers status %s before the window and preserves the close status",
    async (code) => {
      const { client, transport, timer } = setup();
      const armTimeout = spyOn(timer, "setTimeout");
      transport.onOpen = (call) => {
        call.statusOnEnd = undefined;
        call.respondHeaders(code === undefined ? undefined : { code, message: "" });
      };
      const injection = await client.injectAudio(CLIP);
      expect(armTimeout).toHaveBeenCalledWith(expect.any(Function), 200);
      expect(timer.now()).toBe(0);
      expect(timer.getPendingTimeoutCount()).toBe(0);
      const call = transport.calls[0];
      let closed = false;
      const status = call.status().then((result) => {
        closed = true;
        return result;
      });
      await drainMicrotasks(20);
      expect(call.ended).toBe(true);
      expect(closed).toBe(false);
      const finalStatus = { code: GrpcStatus.OK, message: "completed" };
      call.finish(finalStatus);
      expect(await status).toEqual(finalStatus);
      expect(await injection.done).toMatchObject({ framesQueued: 1600, reason: "completed" });
      armTimeout.mockRestore();
    },
  );

  test.each([
    [GrpcStatus.UNIMPLEMENTED, "audio_injection_unsupported"],
    [GrpcStatus.FAILED_PRECONDITION, "audio_injection_busy"],
    [GrpcStatus.UNAVAILABLE, "audio_injection_unsupported"],
  ])("rejects status %i at call time before any write or start delay", async (code, errorCode) => {
    const { client, transport, timer } = setup(true);
    transport.onOpen = (call) => call.finish({ code, message: "refused" });
    const error = await client
      .injectAudio(CLIP, { startDelayMs: 60_000 })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(EmulatorAudioError);
    expect(error).toMatchObject({ code: errorCode });
    expect(transport.calls[0].written).toHaveLength(0);
    expect(timer.getPendingTimeoutCount()).toBe(0);
    expect(timer.getSleepCallCount()).toBe(0);
    expect(timer.now()).toBe(0);
  });

  test("a rejection arriving during the window clears its timer without sending packets", async () => {
    const { client, transport, timer } = setup(true);
    const starting = client.injectAudio(CLIP).catch((caught: unknown) => caught);
    await drainUntil(() => timer.getPendingTimeoutCount() === 1, {
      description: "acceptance timer",
    });
    timer.advanceTime(199);
    transport.calls[0].respondHeaders({ code: GrpcStatus.FAILED_PRECONDITION, message: "busy" });
    expect(await starting).toMatchObject({ code: "audio_injection_busy" });
    expect(transport.calls[0].written).toHaveLength(0);
    expect(timer.getPendingTimeoutCount()).toBe(0);
    expect(timer.getSleepCallCount()).toBe(0);
    expect(timer.now()).toBe(199);
  });

  test("waits for the acceptance window before streaming an open call", async () => {
    const { client, transport, timer } = setup(true);
    const armTimeout = spyOn(timer, "setTimeout");
    let resolved = false;
    const starting = client.injectAudio(CLIP).then((injection) => {
      resolved = true;
      return injection;
    });
    await drainUntil(() => timer.getPendingTimeoutCount() === 1, {
      description: "acceptance timer",
    });
    expect(armTimeout).toHaveBeenCalledWith(expect.any(Function), 200);
    expect(timer.getMsUntilNextDueEvent()).toBe(200);
    timer.advanceTime(199);
    await drainMicrotasks(20);
    expect(resolved).toBe(false);
    expect(transport.calls[0].written).toHaveLength(0);
    timer.advanceTime(1);
    const injection = await starting;
    expect(await injection.done).toEqual({
      framesQueued: 1600,
      framesPlayed: 0,
      reason: "completed",
    });
    expect(timer.getPendingTimeoutCount()).toBe(0);
    expect(timer.getSleepCallCount()).toBe(0);
    expect(
      await Promise.race([transport.calls[0].responseHeaders(), Promise.resolve("pending")]),
    ).toBe("pending");
    armTimeout.mockRestore();
  });

  test.each([GrpcStatus.OK, GrpcStatus.CANCELLED])(
    "allows early status %i and clears the window timer",
    async (code) => {
      const { client, transport, timer } = setup(true);
      transport.onOpen = (call) => call.finish({ code, message: "" });
      const injection = await client.injectAudio(CLIP);
      expect(await injection.done).toEqual({
        framesQueued: 0,
        framesPlayed: 0,
        reason: "completed",
      });
      expect(timer.getPendingTimeoutCount()).toBe(0);
      expect(timer.now()).toBe(0);
      expect(timer.getSleepCallCount()).toBe(0);
    },
  );

  test("runs the stream guard after authorization and preserves its refusal without opening transport", async () => {
    const { client, transport, authorizer } = setup();
    const authorized = Promise.withResolvers<string>();
    authorizer.authorization = () => authorized.promise;
    const refusal = new EmulatorAudioError(
      "audio_host_microphone_unavailable",
      "host voice failed",
    );
    let guardCalls = 0;
    const options: InjectAudioOptions = {
      beforeStreamOpen: () => {
        guardCalls++;
        throw refusal;
      },
    };
    const outcome = client.injectAudio(CLIP, options).catch((error: unknown) => error);
    expect(guardCalls).toBe(0);
    expect(transport.calls).toHaveLength(0);
    authorized.resolve("Bearer registered");
    expect(await outcome).toBe(refusal);
    expect(guardCalls).toBe(1);
    expect(transport.calls).toHaveLength(0);
  });

  test("streams the clip in 20ms packets with the format on the first packet only", async () => {
    const { client, transport } = setup();
    const injection = await client.injectAudio(CLIP);
    expect(await injection.done).toEqual({
      framesQueued: 1600,
      framesPlayed: 0,
      reason: "completed",
    });

    const [call] = transport.calls;
    expect(call.method).toBe(INJECT_AUDIO_METHOD);
    expect(call.metadata).toEqual({ authorization: "Bearer t" });
    expect(call.ended).toBe(true);
    const packets = call.written.map(decodeAudioPacket);
    expect(packets).toHaveLength(5);
    expect(packets[0].format).toEqual({
      samplingRate: 16_000,
      channels: "mono",
      format: "s16",
      mode: "unspecified",
    });
    expect(packets.slice(1).every((packet) => packet.format === undefined)).toBe(true);
    expect(injection).toMatchObject({ durationMs: 100, sampleRate: 16_000 });
  });

  test("downmixes stereo and resamples above 48kHz before sending", () => {
    const stereo96k: PcmAudio = {
      sampleRate: 96_000,
      channels: 2,
      samples: new Int16Array(9_600).fill(500),
    };
    const prepared = prepareForInjection(stereo96k);
    expect(prepared).toMatchObject({ sampleRate: 48_000, channels: 1 });
    expect(prepared.samples.length).toBe(2_400);
  });

  test("maps FAILED_PRECONDITION to audio_injection_busy", async () => {
    const { client, transport } = setup();
    transport.onOpen = (call) => {
      call.onWrite = () => {
        call.finish({
          code: GrpcStatus.FAILED_PRECONDITION,
          message: "There is already an active microphone",
        });
        throw new Error("stream closed");
      };
    };
    const injection = await client.injectAudio(CLIP);
    const error = await injection.done.catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(EmulatorAudioError);
    expect((error as EmulatorAudioError).code).toBe("audio_injection_busy");
  });

  test("maps UNIMPLEMENTED and connection failures to audio_injection_unsupported", async () => {
    for (const code of [GrpcStatus.UNIMPLEMENTED, GrpcStatus.UNAVAILABLE]) {
      const { client, transport } = setup();
      transport.onOpen = (call) => {
        call.statusOnEnd = { code, message: "nope" };
      };
      const injection = await client.injectAudio(CLIP);
      await expect(injection.done).rejects.toMatchObject({ code: "audio_injection_unsupported" });
    }
  });

  test("stop cancels a write parked on back-pressure and is idempotent", async () => {
    const { client, transport } = setup();
    let release: (() => void) | undefined;
    transport.onOpen = (call) => {
      call.onWrite = (index) =>
        index === 2
          ? new Promise<void>((resolve) => {
              release = resolve;
            })
          : undefined;
    };
    const injection = await client.injectAudio(CLIP);
    while (!release) {
      await Promise.resolve();
    }
    const first = await injection.stop();
    const second = await injection.stop();
    expect(first).toEqual({ framesQueued: 640, framesPlayed: 0, reason: "stopped" });
    expect(second).toBe(first);
    expect(transport.calls[0].cancelled).toBe(true);
  });

  test("loop repeats the clip until maxDurationMs elapses", async () => {
    const { client, transport, timer } = setup();
    transport.onOpen = (call) => {
      call.onWrite = () => timer.advanceTime(20);
    };
    const injection = await client.injectAudio(CLIP, { loop: true, maxDurationMs: 250 });
    const result = await injection.done;
    expect(result.reason).toBe("max_duration");
    // 250ms at 20ms per packet: 13 packets of 320 frames, more than two full passes.
    expect(result.framesQueued).toBe(13 * 320);
    expect(result.framesPlayed).toBe(4_160);
    expect(sentFrames(transport.calls[0].written)).toBe(result.framesQueued);
  });

  test("startDelayMs waits before the first packet", async () => {
    const { client, transport, timer } = setup();
    const injection = await client.injectAudio(CLIP, { startDelayMs: 500 });
    await Promise.resolve();
    expect(transport.calls[0].written).toHaveLength(0);
    timer.advanceTime(500);
    expect((await injection.done).framesQueued).toBe(1600);
  });

  test("stop during the start delay settles at once without sending audio", async () => {
    const { client, transport, timer } = setup();
    const injection = await client.injectAudio(CLIP, { startDelayMs: 60_000 });
    expect(await injection.stop()).toEqual({ framesQueued: 0, framesPlayed: 0, reason: "stopped" });
    expect(transport.calls[0].written).toHaveLength(0);
    expect(transport.calls[0].cancelled).toBe(true);
    expect(timer.getMsUntilNextDueEvent()).toBeUndefined();
  });

  test("maxDurationMs ends an injection whose write is parked on back-pressure", async () => {
    const { client, transport, timer } = setup();
    transport.onOpen = (call) => {
      // The emulator stops pulling audio after the first packet.
      call.onWrite = (index) => (index === 1 ? new Promise<void>(() => {}) : undefined);
    };
    const injection = await client.injectAudio(CLIP, { loop: true, maxDurationMs: 1_000 });
    while (transport.calls[0].written.length < 2) {
      await Promise.resolve();
    }
    timer.advanceTime(1_000);
    expect(await injection.done).toEqual({
      framesQueued: 320,
      framesPlayed: 320,
      reason: "max_duration",
    });
    expect(transport.calls[0].cancelled).toBe(true);
  });

  test("framesPlayed follows the monotonic clock at real-time pace and never exceeds framesQueued", async () => {
    const { client, transport, timer } = setup();
    transport.onOpen = (call) => {
      call.onWrite = (index) => {
        timer.advanceTime(10);
        return index === 2 ? new Promise<void>(() => {}) : undefined;
      };
    };
    const injection = await client.injectAudio(CLIP);
    while (transport.calls[0].written.length < 3) {
      await Promise.resolve();
    }
    // Three 10ms steps elapsed: 480 frames at 16 kHz, of the 640 frames queued.
    expect(await injection.stop()).toEqual({
      framesQueued: 640,
      framesPlayed: 480,
      reason: "stopped",
    });
  });

  test.each([60_000, -60_000])("framesPlayed ignores a %i ms wall-clock step", async (stepMs) => {
    const { client, transport, timer } = setup();
    // Start with distinct clock origins so mixing time sources also fails this test.
    timer.stepWallClock(5_000);
    transport.onOpen = (call) => {
      call.onWrite = (index) => {
        timer.advanceTime(10);
        return index === 2 ? new Promise<void>(() => {}) : undefined;
      };
    };
    const injection = await client.injectAudio(CLIP);
    while (transport.calls[0].written.length < 3) {
      await Promise.resolve();
    }
    timer.stepWallClock(stepMs);
    expect(await injection.stop()).toEqual({
      framesQueued: 640,
      framesPlayed: 480,
      reason: "stopped",
    });
  });

  test("a clip that finishes before maxDurationMs clears its deadline", async () => {
    const { client, timer } = setup();
    const injection = await client.injectAudio(CLIP, { maxDurationMs: 5_000 });
    expect(await injection.done).toEqual({
      framesQueued: 1600,
      framesPlayed: 0,
      reason: "completed",
    });
    expect(timer.getMsUntilNextDueEvent()).toBeUndefined();
  });
});

describe("EmulatorAudioClient.captureAudio", () => {
  function audioPacket(samples: Int16Array): Uint8Array {
    return encodeAudioPacket({ audio: new Uint8Array(samples.buffer.slice(0)) });
  }

  test("requests mono S16 and stops once the duration is collected", async () => {
    const { client, transport } = setup();
    const tone = sineTone({ durationMs: 60, sampleRate: 48_000 });
    transport.onOpen = (call) => {
      call.statusOnEnd = undefined;
      call.onWrite = () => {
        for (let start = 0; start < tone.samples.length; start += 960) {
          call.respond(audioPacket(tone.samples.slice(start, start + 960)));
        }
      };
    };
    const result = await client.captureAudio({ durationMs: 50 });

    const [call] = transport.calls;
    expect(call.method).toBe(STREAM_AUDIO_METHOD);
    expect(decodeAudioFormat(call.written[0])).toMatchObject({
      samplingRate: 48_000,
      channels: "mono",
      format: "s16",
    });
    expect(call.cancelled).toBe(true);
    expect(result.timedOut).toBe(false);
    expect(result.pcm.samples.length).toBe(2_400);
    expect(analyzeLevels(result.pcm).silent).toBe(false);
  });

  test("a guest that produces no audio returns empty, timed-out PCM instead of hanging", async () => {
    const { client, transport, timer } = setup();
    transport.onOpen = (call) => {
      call.statusOnEnd = undefined;
    };
    const capture = client.captureAudio({ durationMs: 1_000 });
    while (transport.calls.length === 0 || !transport.calls[0].ended) {
      await Promise.resolve();
    }
    timer.advanceTime(3_000);
    const result = await capture;
    expect(result.timedOut).toBe(true);
    expect(result.pcm.samples.length).toBe(0);
    expect(analyzeLevels(result.pcm).silent).toBe(true);
  });

  test("an UNIMPLEMENTED stream with no audio is audio_capture_unsupported", async () => {
    const { client, transport } = setup();
    transport.onOpen = (call) => {
      call.statusOnEnd = { code: GrpcStatus.UNIMPLEMENTED, message: "" };
    };
    await expect(client.captureAudio({ durationMs: 100 })).rejects.toMatchObject({
      code: "audio_capture_unsupported",
    });
  });
});

describe("EmulatorAudioClient.streamCapture", () => {
  function audioPacket(bytes: number[]): Uint8Array {
    return encodeAudioPacket({ audio: Uint8Array.from(bytes) });
  }

  test("forwards PCM until stopped, then cancels the stream", async () => {
    const { client, transport } = setup();
    transport.onOpen = (call) => {
      call.statusOnEnd = undefined;
      call.onWrite = () => {
        call.respond(audioPacket([1, 0, 2, 0]));
        call.respond(audioPacket([3, 0]));
      };
    };
    const received: number[] = [];
    const stream = await client.streamCapture(
      (pcm) => {
        received.push(...pcm);
      },
      {
        sampleRate: 16_000,
      },
    );
    while (received.length < 6) {
      await Promise.resolve();
    }
    await stream.stop();
    await stream.stop();
    expect(stream.sampleRate).toBe(16_000);
    expect(received).toEqual([1, 0, 2, 0, 3, 0]);
    expect(transport.calls[0].cancelled).toBe(true);
  });

  test("a busy sink holds the next packet until it settles", async () => {
    const { client, transport } = setup();
    transport.onOpen = (call) => {
      call.statusOnEnd = undefined;
      call.onWrite = () => {
        call.respond(audioPacket([1, 0]));
        call.respond(audioPacket([2, 0]));
      };
    };
    const received: number[] = [];
    let release: () => void = () => {};
    const stream = await client.streamCapture((pcm) => {
      received.push(...pcm);
      if (received.length === 2) {
        return new Promise<void>((resolve) => {
          release = resolve;
        });
      }
      return undefined;
    });
    for (let turn = 0; turn < 10; turn++) {
      await Promise.resolve();
    }
    expect(received).toEqual([1, 0]);
    release();
    while (received.length < 4) {
      await Promise.resolve();
    }
    expect(received).toEqual([1, 0, 2, 0]);
    await stream.stop();
  });

  test("a stream the emulator refuses before any audio fails at stop", async () => {
    const { client, transport } = setup();
    transport.onOpen = (call) => {
      call.statusOnEnd = { code: GrpcStatus.UNIMPLEMENTED, message: "" };
    };
    const stream = await client.streamCapture(() => {});
    await expect(stream.stop()).rejects.toMatchObject({ code: "audio_capture_unsupported" });
  });

  test("a stream that fails after some audio still fails at stop", async () => {
    const { client, transport } = setup();
    transport.onOpen = (call) => {
      call.statusOnEnd = undefined;
      call.onWrite = () => {
        call.respond(audioPacket([1, 0]));
        call.finish({ code: GrpcStatus.UNAVAILABLE, message: "emulator went away" });
      };
    };
    const received: number[] = [];
    const stream = await client.streamCapture((pcm) => {
      received.push(...pcm);
    });
    while (received.length < 2) {
      await Promise.resolve();
    }
    await expect(stream.stop()).rejects.toBeInstanceOf(EmulatorAudioError);
  });
});

describe("SilenceFiller", () => {
  const START_US = 1_700_000_000_000_000;
  /** 20 ms of 16 kHz mono PCM. */
  const packet = (timestampUs?: number) => ({ timestampUs, audio: new Uint8Array(640) });

  test("a quiet stretch between packets becomes silence of the same length", () => {
    let nowUs = START_US;
    const filler = new SilenceFiller(16_000, () => nowUs);
    expect(filler.before(packet(START_US))).toBeUndefined();
    nowUs = START_US + 2_020_000;
    expect(filler.before(packet(START_US + 2_020_000))?.byteLength).toBe(64_000);
  });

  test("silence before the first packet is kept, and jitter is not", () => {
    let nowUs = START_US;
    const filler = new SilenceFiller(16_000, () => nowUs);
    nowUs += 1_000_000;
    expect(filler.before(packet(nowUs))?.byteLength).toBe(32_000);
    nowUs += 30_000;
    expect(filler.before(packet(nowUs))).toBeUndefined();
  });

  test("contiguous packets that waited out a slow consumer add no silence", () => {
    let nowUs = START_US;
    const filler = new SilenceFiller(16_000, () => nowUs);
    expect(filler.before(packet(START_US))).toBeUndefined();
    // An 11 s disk stall delays processing; the next packet's timestamp is still contiguous.
    nowUs += 11_000_000;
    expect(filler.before(packet(START_US + 20_000))).toBeUndefined();
  });

  test("a timestamp that disagrees with the host clock falls back to arrival time", () => {
    let nowUs = START_US;
    const filler = new SilenceFiller(16_000, () => nowUs);
    nowUs += 500_000;
    expect(filler.before(packet(42))?.byteLength).toBe(16_000);
  });
});

test("close releases the transport and the authorizer", async () => {
  const { client, transport, authorizer } = setup();
  await client.close();
  expect(transport.closed).toBe(true);
  expect(authorizer.disposed).toBe(1);
});
