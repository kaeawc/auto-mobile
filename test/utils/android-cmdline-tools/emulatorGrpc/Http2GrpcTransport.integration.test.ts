import { afterEach, describe, expect, test } from "bun:test";
import http2 from "node:http2";
import type { AddressInfo } from "node:net";
import {
  EmulatorAudioClient,
  INJECT_AUDIO_METHOD,
  STREAM_AUDIO_METHOD,
} from "../../../../src/utils/android-cmdline-tools/emulatorGrpc/EmulatorAudioClient";
import { createGrpcAuthorizer } from "../../../../src/utils/android-cmdline-tools/emulatorGrpc/emulatorGrpcAuth";
import {
  decodeAudioFormat,
  decodeAudioPacket,
  encodeAudioPacket,
} from "../../../../src/utils/android-cmdline-tools/emulatorGrpc/emulatorAudioMessages";
import {
  frameMessage,
  GrpcFrameDecoder,
} from "../../../../src/utils/android-cmdline-tools/emulatorGrpc/grpcFraming";
import { Http2GrpcTransport } from "../../../../src/utils/android-cmdline-tools/emulatorGrpc/grpcTransport";
import { analyzeLevels, sineTone } from "../../../../src/utils/audio/pcm";

/**
 * A loopback HTTP/2 server speaking the two emulator audio RPCs, so the real transport, framing
 * and status handling run end to end without an emulator.
 */
interface FakeEmulator {
  address: string;
  injectedFrames: number[];
  micBusy: boolean;
  close(): Promise<void>;
}

const TOKEN = "secret-token";

function respondStatus(stream: http2.ServerHttp2Stream, code: number, message = ""): void {
  stream.respond(
    {
      ":status": 200,
      "content-type": "application/grpc",
      "grpc-status": String(code),
      "grpc-message": message,
    },
    { endStream: true },
  );
}

function handleInject(stream: http2.ServerHttp2Stream, emulator: FakeEmulator): void {
  if (emulator.micBusy) {
    respondStatus(stream, 9, "There is already an active microphone");
    return;
  }
  const decoder = new GrpcFrameDecoder();
  let frames = 0;
  stream.on("data", (chunk: Buffer) => {
    for (const message of decoder.push(chunk)) {
      frames += decodeAudioPacket(message).audio.byteLength / 2;
    }
  });
  stream.on("end", () => {
    emulator.injectedFrames.push(frames);
    stream.respond(
      { ":status": 200, "content-type": "application/grpc" },
      { waitForTrailers: true },
    );
    stream.on("wantTrailers", () => stream.sendTrailers({ "grpc-status": "0" }));
    stream.end(frameMessage(new Uint8Array(0)));
  });
}

function handleStream(stream: http2.ServerHttp2Stream): void {
  const decoder = new GrpcFrameDecoder();
  stream.on("data", (chunk: Buffer) => {
    const [request] = decoder.push(chunk);
    if (!request) {
      return;
    }
    const format = decodeAudioFormat(request);
    stream.respond({ ":status": 200, "content-type": "application/grpc" });
    const tone = sineTone({ durationMs: 200, sampleRate: format.samplingRate });
    const packetSamples = format.samplingRate / 50;
    for (let start = 0; start < tone.samples.length; start += packetSamples) {
      const samples = tone.samples.slice(start, start + packetSamples);
      stream.write(frameMessage(encodeAudioPacket({ audio: new Uint8Array(samples.buffer) })));
    }
    // Like a real emulator, keep the stream open until the client cancels.
  });
  stream.on("error", () => {});
}

async function startFakeEmulator(): Promise<FakeEmulator> {
  const server = http2.createServer();
  const emulator: FakeEmulator = {
    address: "",
    injectedFrames: [],
    micBusy: false,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
  server.on("stream", (stream: http2.ServerHttp2Stream, headers: http2.IncomingHttpHeaders) => {
    if (headers.authorization !== `Bearer ${TOKEN}`) {
      respondStatus(stream, 16, "bad token");
    } else if (headers[":path"] === INJECT_AUDIO_METHOD) {
      handleInject(stream, emulator);
    } else if (headers[":path"] === STREAM_AUDIO_METHOD) {
      handleStream(stream);
    } else {
      respondStatus(stream, 12);
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  emulator.address = `127.0.0.1:${(server.address() as AddressInfo).port}`;
  return emulator;
}

const noFs = {
  writeFile: async () => {},
  readFile: async () => "",
  unlink: async () => {},
};

describe("Http2GrpcTransport against a loopback emulator", () => {
  const cleanups: Array<() => Promise<void>> = [];
  afterEach(async () => {
    for (const cleanup of cleanups.splice(0)) {
      await cleanup();
    }
  });

  async function connect(token = TOKEN) {
    const emulator = await startFakeEmulator();
    const client = new EmulatorAudioClient(
      new Http2GrpcTransport(emulator.address),
      createGrpcAuthorizer({ kind: "token", token }, noFs),
    );
    cleanups.push(async () => {
      await client.close();
      await emulator.close();
    });
    return { emulator, client };
  }

  test("injectAudio streams every frame and completes with OK", async () => {
    const { emulator, client } = await connect();
    const injection = await client.injectAudio(sineTone({ durationMs: 100, sampleRate: 16_000 }));
    expect(await injection.done).toMatchObject({ framesQueued: 1_600, reason: "completed" });
    expect(emulator.injectedFrames).toEqual([1_600]);
  });

  test("a busy microphone surfaces as audio_injection_busy", async () => {
    const { emulator, client } = await connect();
    emulator.micBusy = true;
    await expect(client.injectAudio(sineTone({ durationMs: 100 }))).rejects.toMatchObject({
      code: "audio_injection_busy",
    });
  });

  test("captureAudio collects the requested duration and cancels the open stream", async () => {
    const { client } = await connect();
    const result = await client.captureAudio({ durationMs: 100, sampleRate: 16_000 });
    expect(result.timedOut).toBe(false);
    expect(result.pcm.samples.length).toBe(1_600);
    expect(analyzeLevels(result.pcm).silent).toBe(false);
  });

  test("a rejected token is a typed gRPC failure, not a hang", async () => {
    const { client } = await connect("wrong");
    await expect(client.injectAudio(sineTone({ durationMs: 40 }))).rejects.toMatchObject({
      code: "audio_grpc_failed",
    });
  });

  test("an unreachable endpoint is audio_injection_unsupported", async () => {
    const emulator = await startFakeEmulator();
    const address = emulator.address;
    await emulator.close();
    const client = new EmulatorAudioClient(
      new Http2GrpcTransport(address),
      createGrpcAuthorizer({ kind: "token", token: TOKEN }, noFs),
    );
    cleanups.push(() => client.close());
    await expect(client.injectAudio(sineTone({ durationMs: 40 }))).rejects.toMatchObject({
      code: "audio_injection_unsupported",
    });
  });
});
