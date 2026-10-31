import { describe, expect, test } from "bun:test";
import {
  EmulatorAudioClient,
  INJECT_AUDIO_METHOD,
  type InjectAudioOptions,
  prepareForInjection,
  START_REFUSAL_WINDOW_MS,
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

function setup() {
  const transport = new FakeGrpcTransport();
  const timer = new FakeTimer();
  const authorizer = tokenAuthorizer();
  return {
    transport,
    timer,
    authorizer,
    client: new EmulatorAudioClient(transport, authorizer, timer),
  };
}

/** 100ms of 16kHz mono tone = 1600 frames = 5 packets of 20ms. */
const CLIP = sineTone({ durationMs: 100, sampleRate: 16_000 });

/** Lets the start's refusal window lapse with no refusal, as for a stream the emulator accepted. */
async function lapseRefusalWindow(timer: FakeTimer): Promise<void> {
  // Bounded, so a start that never opens the window fails here instead of spinning on microtasks.
  for (let turn = 0; !timer.getPendingTimeouts().includes(START_REFUSAL_WINDOW_MS); turn++) {
    if (turn > 1_000) {
      throw new Error("injectAudio never opened its refusal window");
    }
    await Promise.resolve();
  }
  // The window is the newest timer: any start delay or max-duration deadline is registered first.
  timer.fireNewestPendingTimeout();
}

/** The emulator's refusal of a token with a `typ` header, as captured on emulator 37.1.11. */
const INVALID_JWT = {
  code: GrpcStatus.INVALID_ARGUMENT,
  message: "invalid JWT; token has type header set, but validator not",
};
/** The emulator's refusal of an issuer that is not on its default allowlist. */
const NOT_ALLOWLISTED = {
  code: GrpcStatus.PERMISSION_DENIED,
  message:
    "The endpoint: /android.emulation.control.EmulatorController/streamAudio is not on the " +
    "allowlist loaded from: emulator/lib/emulator_access.json",
};

function sentFrames(written: Uint8Array[]): number {
  return written.reduce((sum, message) => sum + decodeAudioPacket(message).audio.byteLength / 2, 0);
}

describe("EmulatorAudioClient.injectAudio", () => {
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

  test("maps FAILED_PRECONDITION to audio_injection_busy at start", async () => {
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
    const error = await client.injectAudio(CLIP).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(EmulatorAudioError);
    expect((error as EmulatorAudioError).code).toBe("audio_injection_busy");
  });

  test("maps UNIMPLEMENTED and connection failures to audio_injection_unsupported", async () => {
    for (const code of [GrpcStatus.UNIMPLEMENTED, GrpcStatus.UNAVAILABLE]) {
      const { client, transport } = setup();
      transport.onOpen = (call) => {
        call.statusOnEnd = { code, message: "nope" };
      };
      await expect(client.injectAudio(CLIP)).rejects.toMatchObject({
        code: "audio_injection_unsupported",
      });
    }
  });

  test.each([
    ["an invalid JWT", INVALID_JWT],
    ["an issuer off the allowlist", NOT_ALLOWLISTED],
    ["a missing token", { code: GrpcStatus.UNAUTHENTICATED, message: "no token" }],
  ])(
    "%s refused as the stream opens fails the start as audio_grpc_auth_rejected",
    async (_, status) => {
      const { client, transport } = setup();
      // The emulator answers trailers-only before any audio, even while the start delay runs.
      transport.onOpen = (call) => call.finish(status);
      const error = await client
        .injectAudio(CLIP, { startDelayMs: 60_000 })
        .catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(EmulatorAudioError);
      expect(error).toMatchObject({ code: "audio_grpc_auth_rejected", grpcStatus: status });
      expect((error as EmulatorAudioError).message).toContain(status.message);
      expect((error as EmulatorAudioError).remedy).toContain("-grpc-use-token");
    },
  );

  test("a refused start ends the injection, leaving no delay or deadline timer behind", async () => {
    const { client, transport, timer } = setup();
    transport.onOpen = (call) => call.finish(NOT_ALLOWLISTED);
    await expect(
      client.injectAudio(CLIP, { startDelayMs: 60_000, maxDurationMs: 600_000 }),
    ).rejects.toMatchObject({ code: "audio_grpc_auth_rejected" });
    expect(transport.calls[0].cancelled).toBe(true);
    expect(transport.calls[0].written).toHaveLength(0);
    expect(timer.getMsUntilNextDueEvent()).toBeUndefined();
  });

  test("an INVALID_ARGUMENT that is not about the token stays audio_grpc_failed", async () => {
    const { client, transport } = setup();
    transport.onOpen = (call) =>
      call.finish({ code: GrpcStatus.INVALID_ARGUMENT, message: "sampling rate too high" });
    await expect(client.injectAudio(CLIP)).rejects.toMatchObject({ code: "audio_grpc_failed" });
  });

  test("a failure after the refusal window still surfaces through done", async () => {
    const { client, transport, timer } = setup();
    const started = client.injectAudio(CLIP, { startDelayMs: 60_000 });
    await lapseRefusalWindow(timer);
    const injection = await started;
    transport.calls[0].finish({ code: GrpcStatus.UNKNOWN, message: "emulator went away" });
    timer.advanceTime(60_000);
    await expect(injection.done).rejects.toMatchObject({ code: "audio_grpc_failed" });
    expect(timer.getMsUntilNextDueEvent()).toBeUndefined();
  });

  test("stop cancels a write parked on back-pressure and is idempotent", async () => {
    const { client, transport, timer } = setup();
    let release: (() => void) | undefined;
    transport.onOpen = (call) => {
      call.onWrite = (index) =>
        index === 2
          ? new Promise<void>((resolve) => {
              release = resolve;
            })
          : undefined;
    };
    const started = client.injectAudio(CLIP);
    await lapseRefusalWindow(timer);
    const injection = await started;
    while (!release) {
      await Promise.resolve();
    }
    const first = await injection.stop();
    const second = await injection.stop();
    // The 500ms window is longer than the 40ms queued, so all of it has played.
    expect(first).toEqual({ framesQueued: 640, framesPlayed: 640, reason: "stopped" });
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
    const started = client.injectAudio(CLIP, { startDelayMs: 1_000 });
    await lapseRefusalWindow(timer);
    const injection = await started;
    expect(transport.calls[0].written).toHaveLength(0);
    timer.advanceTime(1_000 - START_REFUSAL_WINDOW_MS);
    expect((await injection.done).framesQueued).toBe(1600);
  });

  test("stop during the start delay settles at once without sending audio", async () => {
    const { client, transport, timer } = setup();
    const started = client.injectAudio(CLIP, { startDelayMs: 60_000 });
    await lapseRefusalWindow(timer);
    const injection = await started;
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
    const started = client.injectAudio(CLIP, { loop: true, maxDurationMs: 1_000 });
    await lapseRefusalWindow(timer);
    const injection = await started;
    while (transport.calls[0].written.length < 2) {
      await Promise.resolve();
    }
    timer.advanceTime(1_000 - START_REFUSAL_WINDOW_MS);
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
        return index === 99 ? new Promise<void>(() => {}) : undefined;
      };
    };
    // The writes' own clock steps carry the start past its refusal window.
    const injection = await client.injectAudio(CLIP, { loop: true });
    while (transport.calls[0].written.length < 100) {
      await Promise.resolve();
    }
    // A hundred 10ms steps elapsed: 16000 frames at 16 kHz, of the 31680 frames queued (the
    // hundredth write is still parked).
    expect(await injection.stop()).toEqual({
      framesQueued: 31_680,
      framesPlayed: 16_000,
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
        return index === 99 ? new Promise<void>(() => {}) : undefined;
      };
    };
    const injection = await client.injectAudio(CLIP, { loop: true });
    while (transport.calls[0].written.length < 100) {
      await Promise.resolve();
    }
    timer.stepWallClock(stepMs);
    expect(await injection.stop()).toEqual({
      framesQueued: 31_680,
      framesPlayed: 16_000,
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

  test("a capture refused for its issuer is audio_grpc_auth_rejected", async () => {
    const { client, transport } = setup();
    transport.onOpen = (call) => call.finish(NOT_ALLOWLISTED);
    await expect(client.captureAudio({ durationMs: 100 })).rejects.toMatchObject({
      code: "audio_grpc_auth_rejected",
    });
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
