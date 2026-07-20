import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import {
  PersistentEncoderH264Source,
  VIDEO_SERVER_SOCKET_NAME,
  type SocketConnector,
  type StreamSocket,
} from "../../../src/features/webrtc/PersistentEncoderH264Source";
import type { SpawnedProcess } from "../../../src/features/webrtc/processSpawner";
import {
  VIDEO_SERVER_CODEC_ID_AMUX,
  VIDEO_SERVER_CODEC_ID_H264,
  VIDEO_SERVER_CODEC_ID_PCM16,
  VIDEO_SERVER_TRACK_ID_AUDIO,
  VIDEO_SERVER_TRACK_ID_VIDEO,
} from "../../../src/features/webrtc/VideoServerStreamParser";
import type { AdbClientFactory } from "../../../src/utils/android-cmdline-tools/AdbClientFactory";
import type { BootedDevice } from "../../../src/models";
import { FakeTimer } from "../../fakes/FakeTimer";

const DEVICE: BootedDevice = { deviceId: "emulator-5554", platform: "android", name: "t" } as BootedDevice;
const FORWARD_PORT = "45999";
// Flush the nextTick + microtask queues so the source's async launch steps and
// the PassThrough `data` emissions settle (no fake timer involved here).
const tick = (): Promise<void> => new Promise(resolve => setImmediate(resolve));

class FakeProcess extends EventEmitter implements SpawnedProcess {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  killed: string[] = [];
  kill(signal?: NodeJS.Signals): boolean {
    this.killed.push(signal ?? "SIGTERM");
    return true;
  }
  ready(): void {
    this.stdout.write(Buffer.from("Waiting for client connection on localabstract:x\n"));
  }
  streamingStarted(): void {
    this.stdout.write(Buffer.from("Streaming started\n"));
  }
  exit(code: number | null = 0, signal: NodeJS.Signals | null = null): void {
    this.emit("exit", code, signal);
  }
}

class FakeSocket extends EventEmitter implements StreamSocket {
  destroyed = false;
  destroy(): void {
    this.destroyed = true;
  }
  feed(chunk: Buffer): void {
    this.emit("data", chunk);
  }
}

function streamHeader(width: number, height: number): Buffer {
  const buf = Buffer.alloc(12);
  buf.writeUInt32BE(VIDEO_SERVER_CODEC_ID_H264, 0);
  buf.writeUInt32BE(width, 4);
  buf.writeUInt32BE(height, 8);
  return buf;
}

function framedPacket(payload: Buffer): Buffer {
  const header = Buffer.alloc(12);
  header.writeBigUInt64BE(0n, 0);
  header.writeUInt32BE(payload.length, 8);
  return Buffer.concat([header, payload]);
}

function muxHeader(): Buffer {
  const header = Buffer.alloc(44);
  header.writeUInt32BE(VIDEO_SERVER_CODEC_ID_AMUX, 0);
  header.writeUInt32BE(1, 4);
  header.writeUInt32BE(2, 8);
  header.writeUInt32BE(VIDEO_SERVER_TRACK_ID_VIDEO, 12);
  header.writeUInt32BE(VIDEO_SERVER_CODEC_ID_H264, 16);
  header.writeUInt32BE(480, 20);
  header.writeUInt32BE(1040, 24);
  header.writeUInt32BE(VIDEO_SERVER_TRACK_ID_AUDIO, 28);
  header.writeUInt32BE(VIDEO_SERVER_CODEC_ID_PCM16, 32);
  header.writeUInt32BE(8000, 36);
  header.writeUInt32BE(1, 40);
  return header;
}

function muxPacket(trackId: number, payload: Buffer): Buffer {
  const header = Buffer.alloc(16);
  header.writeUInt32BE(trackId, 0);
  header.writeBigUInt64BE(0n, 4);
  header.writeUInt32BE(payload.length, 12);
  return Buffer.concat([header, payload]);
}

function makeSource(overrides: Record<string, unknown> = {}) {
  const commands: string[] = [];
  const processes: FakeProcess[] = [];
  const sockets: FakeSocket[] = [];
  const spawnArgs: string[][] = [];
  const chunks: Buffer[] = [];
  const audioChunks: Buffer[] = [];
  const errors: Error[] = [];
  const timer = new FakeTimer();
  const audioEnabled = overrides.audioEnabled === true;

  const adbFactory: AdbClientFactory = {
    create() {
      return {
        getAdbPathOnly: async () => "adb",
        executeCommand: async (command: string) => {
          commands.push(command);
          if (command.startsWith("forward tcp:0")) {
            return { stdout: `${FORWARD_PORT}\n`, stderr: "", exitCode: 0 };
          }
          return { stdout: "", stderr: "", exitCode: 0 };
        },
        spawn: async (args: string[]) => {
          spawnArgs.push(args);
          const process = new FakeProcess();
          processes.push(process);
          return process;
        },
      } as unknown as ReturnType<AdbClientFactory["create"]>;
    },
  };

  const connector: SocketConnector = async () => {
    const socket = new FakeSocket();
    sockets.push(socket);
    (overrides.connectorHook as ((socket: FakeSocket) => void) | undefined)?.(socket);
    return socket;
  };

  const source = new PersistentEncoderH264Source({
    device: DEVICE,
    onData: chunk => chunks.push(chunk),
    onAudioData: chunk => audioChunks.push(chunk),
    onError: error => errors.push(error),
    jarPath: "/tmp/automobile-video.jar",
    adbFactory,
    connector,
    timer,
    ...overrides,
  });

  return {
    source,
    commands,
    processes,
    sockets,
    spawnArgs,
    chunks,
    audioChunks,
    errors,
    timer,
    audioEnabled,
  };
}

/** Drive a successful start: launch -> ready -> forward -> connect. */
async function startReady(ctx: ReturnType<typeof makeSource>): Promise<void> {
  const startPromise = ctx.source.start();
  await tick(); // push + spawn
  ctx.processes[0].ready();
  await tick(); // ready resolves, forward + connect
  if (ctx.audioEnabled) {
    ctx.sockets[0].feed(muxHeader());
    ctx.processes[0].streamingStarted();
    ctx.sockets[0].feed(muxPacket(VIDEO_SERVER_TRACK_ID_AUDIO, Buffer.from([0x7f])));
    await tick(); // audio-ready marker + first PCM packet resolve
  }
  await startPromise;
  if (ctx.audioEnabled) {
    ctx.audioChunks.length = 0;
  }
}

describe("PersistentEncoderH264Source", () => {
  test("pushes the jar, launches the server with overrides, forwards, and forwards frames", async () => {
    const ctx = makeSource({ bitrateBps: 1_500_000, size: { width: 480, height: 1040 }, quality: "low" });
    await startReady(ctx);

    expect(ctx.commands.some(c => c.startsWith("push") && c.includes("/data/local/tmp/automobile-video.jar"))).toBe(true);
    expect(ctx.commands).toContain(`forward tcp:0 localabstract:${VIDEO_SERVER_SOCKET_NAME}`);

    const args = ctx.spawnArgs[0].join(" ");
    expect(args).not.toContain("-s emulator-5554");
    expect(args).toContain("CLASSPATH=/data/local/tmp/automobile-video.jar app_process /");
    expect(args).toContain("--quality low");
    expect(args).toContain("--bit-rate 1500000");
    expect(args).toContain("--size 480x1040");

    // A stream header + one packet: only the packet payload reaches onData.
    ctx.sockets[0].feed(streamHeader(480, 1040));
    ctx.sockets[0].feed(framedPacket(Buffer.from([0, 0, 0, 1, 0x67])));
    expect(ctx.chunks).toEqual([Buffer.from([0, 0, 0, 1, 0x67])]);

    await ctx.source.stop();
  });

  test("passes --audio and routes muxed PCM audio packets separately from video", async () => {
    const ctx = makeSource({ audioEnabled: true });
    await startReady(ctx);

    expect(ctx.spawnArgs[0]).toContain("--audio");

    ctx.sockets[0].feed(muxPacket(VIDEO_SERVER_TRACK_ID_AUDIO, Buffer.from([1, 2, 3, 4])));
    ctx.sockets[0].feed(muxPacket(VIDEO_SERVER_TRACK_ID_VIDEO, Buffer.from([0, 0, 0, 1, 0x65])));

    expect(ctx.audioChunks).toEqual([Buffer.from([1, 2, 3, 4])]);
    expect(ctx.chunks).toEqual([Buffer.from([0, 0, 0, 1, 0x65])]);

    await ctx.source.stop();
  });

  test("audio startup does not miss the streaming marker emitted during socket connect", async () => {
    const ctx = makeSource({
      audioEnabled: true,
      connectorHook: (socket: FakeSocket) => {
        ctx.processes[0].streamingStarted();
      },
    });

    const startPromise = ctx.source.start();
    await tick(); // push + spawn
    ctx.processes[0].ready();
    await tick(); // ready resolves, forward + connect, socket listeners are wired
    ctx.sockets[0].feed(muxHeader());
    ctx.sockets[0].feed(muxPacket(VIDEO_SERVER_TRACK_ID_AUDIO, Buffer.from([0x7f])));

    await startPromise;
    expect(ctx.source.isRunning).toBe(true);
    expect(ctx.audioChunks).toEqual([Buffer.from([0x7f])]);

    await ctx.source.stop();
  });

  test("audio startup rejects when the server exits before the post-audio-ready marker", async () => {
    const ctx = makeSource({ audioEnabled: true });
    const startPromise = ctx.source.start();
    await tick(); // push + spawn
    ctx.processes[0].ready();
    await tick(); // ready resolves, forward + connect, now waiting for Streaming started
    ctx.processes[0].exit(1, null);

    await expect(startPromise).rejects.toThrow(/before streaming started/);
    expect(ctx.errors).toEqual([]);
    expect(ctx.source.isRunning).toBe(false);
  });

  test("audio startup rejects when a stale video-server jar streams the legacy H.264 header", async () => {
    const ctx = makeSource({ audioEnabled: true });
    const startPromise = ctx.source.start();
    await tick(); // push + spawn
    ctx.processes[0].ready();
    await tick(); // ready resolves, forward + connect, now waiting for Streaming started + mux header
    ctx.sockets[0].feed(streamHeader(480, 1040));
    ctx.processes[0].streamingStarted();

    await expect(startPromise).rejects.toThrow(/did not advertise muxed PCM audio/);
    expect(ctx.errors).toEqual([]);
    expect(ctx.source.isRunning).toBe(false);
    expect(ctx.sockets[0].destroyed).toBe(true);
    expect(ctx.commands).toContain(`forward --remove tcp:${FORWARD_PORT}`);
  });

  test("audio startup rejects when the muxed server never produces PCM audio", async () => {
    const ctx = makeSource({ audioEnabled: true, readyTimeoutMs: 5000 });
    const startPromise = ctx.source.start();
    await tick(); // push + spawn
    ctx.processes[0].ready();
    await tick(); // ready resolves, forward + connect, now waiting for Streaming started + first PCM packet
    ctx.sockets[0].feed(muxHeader());
    ctx.processes[0].streamingStarted();
    await tick(); // streaming marker resolves; PCM packet is still missing
    ctx.timer.advanceTime(5000);

    await expect(startPromise).rejects.toThrow(/did not produce PCM audio/);
    expect(ctx.errors).toEqual([]);
    expect(ctx.source.isRunning).toBe(false);
    expect(ctx.sockets[0].destroyed).toBe(true);
    expect(ctx.commands).toContain(`forward --remove tcp:${FORWARD_PORT}`);
  });

  test("audio startup rejects when the socket closes before the post-audio-ready marker", async () => {
    const ctx = makeSource({ audioEnabled: true });
    const startPromise = ctx.source.start();
    await tick(); // push + spawn
    ctx.processes[0].ready();
    await tick(); // ready resolves, forward + connect, now waiting for Streaming started
    ctx.sockets[0].emit("close");

    await expect(startPromise).rejects.toThrow(/socket closed/);
    expect(ctx.errors).toEqual([]);
    expect(ctx.source.isRunning).toBe(false);
    expect(ctx.sockets[0].destroyed).toBe(true);
    expect(ctx.commands).toContain(`forward --remove tcp:${FORWARD_PORT}`);
  });

  test("audio startup rejects when the socket errors before the post-audio-ready marker", async () => {
    const ctx = makeSource({ audioEnabled: true });
    const startPromise = ctx.source.start();
    await tick(); // push + spawn
    ctx.processes[0].ready();
    await tick(); // ready resolves, forward + connect, now waiting for Streaming started
    ctx.sockets[0].emit("error", new Error("REMOTE_SUBMIX socket failed"));

    await expect(startPromise).rejects.toThrow(/REMOTE_SUBMIX socket failed/);
    expect(ctx.errors).toEqual([]);
    expect(ctx.source.isRunning).toBe(false);
    expect(ctx.sockets[0].destroyed).toBe(true);
    expect(ctx.commands).toContain(`forward --remove tcp:${FORWARD_PORT}`);
  });

  test("stop terminates the server, destroys the socket, and removes the forward", async () => {
    const ctx = makeSource();
    await startReady(ctx);
    await ctx.source.stop();

    expect(ctx.processes[0].killed).toContain("SIGINT");
    expect(ctx.sockets[0].destroyed).toBe(true);
    expect(ctx.commands).toContain(`forward --remove tcp:${FORWARD_PORT}`);
    // Must NOT device-wide pkill: it would kill a concurrent videoRecording.
    expect(ctx.commands.some(c => c.includes("pkill"))).toBe(false);
  });

  test("rejects start (for fallback) when the server never becomes ready", async () => {
    const ctx = makeSource({ readyTimeoutMs: 5000 });
    const startPromise = ctx.source.start();
    await tick(); // spawn
    ctx.timer.advanceTime(5000); // readiness timeout fires
    await expect(startPromise).rejects.toThrow(/did not become ready/);
    // A startup failure must NOT be reported via onError (that path is for
    // post-start failures / reconnect); it surfaces as the rejection.
    expect(ctx.errors).toEqual([]);
    expect(ctx.processes[0].killed).toContain("SIGINT");
  });

  test("rejects start when the server exits before ready", async () => {
    const ctx = makeSource();
    const startPromise = ctx.source.start();
    await tick();
    ctx.processes[0].exit(1, null);
    await expect(startPromise).rejects.toThrow(/exited before ready/);
    expect(ctx.errors).toEqual([]);
  });

  test("surfaces a post-start socket close via onError", async () => {
    const ctx = makeSource();
    await startReady(ctx);
    ctx.sockets[0].emit("close");
    expect(ctx.errors).toHaveLength(1);
    expect(ctx.source.isRunning).toBe(false);
  });

  test("surfaces a post-start server exit via onError", async () => {
    const ctx = makeSource();
    await startReady(ctx);
    ctx.processes[0].exit(137, "SIGKILL");
    expect(ctx.errors).toHaveLength(1);
    expect(ctx.errors[0].message).toContain("video-server exited");
  });
});
