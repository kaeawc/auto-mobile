import { describe, expect, test } from "bun:test";
import {
  EmulatorAudioClient,
  INJECT_AUDIO_METHOD,
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

function sentFrames(written: Uint8Array[]): number {
  return written.reduce((sum, message) => sum + decodeAudioPacket(message).audio.byteLength / 2, 0);
}

describe("EmulatorAudioClient.injectAudio", () => {
  test("streams the clip in 20ms packets with the format on the first packet only", async () => {
    const { client, transport } = setup();
    const injection = await client.injectAudio(CLIP);
    expect(await injection.done).toEqual({ framesSent: 1600, reason: "completed" });

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
    expect(first).toEqual({ framesSent: 640, reason: "stopped" });
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
    expect(result.framesSent).toBe(13 * 320);
    expect(sentFrames(transport.calls[0].written)).toBe(result.framesSent);
  });

  test("startDelayMs waits before the first packet", async () => {
    const { client, transport, timer } = setup();
    const injection = await client.injectAudio(CLIP, { startDelayMs: 500 });
    await Promise.resolve();
    expect(transport.calls[0].written).toHaveLength(0);
    timer.advanceTime(500);
    expect((await injection.done).framesSent).toBe(1600);
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

test("close releases the transport and the authorizer", async () => {
  const { client, transport, authorizer } = setup();
  await client.close();
  expect(transport.closed).toBe(true);
  expect(authorizer.disposed).toBe(1);
});
