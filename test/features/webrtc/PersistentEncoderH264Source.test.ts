import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import {
  PersistentEncoderH264Source,
  VIDEO_SERVER_LEASE_DIRECTORY,
  VIDEO_SERVER_SOCKET_PREFIX,
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
const SESSION_TOKEN = "session-0001";
const SESSION_SOCKET = `${VIDEO_SERVER_SOCKET_PREFIX}_session0001`;
const VIDEO_SERVER_MAIN_CLASS = "dev.jasonpearson.automobile.video.VideoServer";
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
  ready(token: string = SESSION_TOKEN, socketName: string = SESSION_SOCKET, pid: number = 1234): void {
    this.stdout.write(Buffer.from(`VIDEO_SESSION_READY token=${token} pid=${pid} socket=${socketName}\n`));
    this.stdout.write(Buffer.from(`Waiting for client connection on localabstract:${socketName}\n`));
  }
  readyAndStreamingStarted(): void {
    this.stdout.write(
      Buffer.from(
        `VIDEO_SESSION_READY token=${SESSION_TOKEN} pid=1234 socket=${SESSION_SOCKET}\n` +
        "Streaming started\n"
      )
    );
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
  readonly written: Buffer[] = [];
  destroy(): void {
    this.destroyed = true;
  }
  write(chunk: Buffer): void {
    this.written.push(Buffer.from(chunk));
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

function framedPacket(payload: Buffer, flags: bigint = 0n): Buffer {
  const header = Buffer.alloc(12);
  header.writeBigUInt64BE(flags, 0);
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
  let forwardedSocket: string | null = null;
  const leaseOutput = (overrides.leaseOutput as string | undefined) ?? "";
  const deviceUptimeMs = (overrides.deviceUptimeMs as number | undefined) ?? 100_000;
  const forwardResult = overrides.forwardResult as
    | Promise<{ stdout: string; stderr: string; exitCode: number }>
    | undefined;
  const processCommandLine =
    (overrides.processCommandLine as string | undefined) ??
    `app_process\u0000/\u0000${VIDEO_SERVER_MAIN_CLASS}\u0000--session-token\u0000stale-session`;

  const adbFactory: AdbClientFactory = {
    create() {
      return {
        getAdbPathOnly: async () => "adb",
        executeCommand: async (command: string) => {
          commands.push(command);
          if (command.startsWith("forward tcp:0")) {
            forwardedSocket = command.split("localabstract:")[1] ?? null;
            if (forwardResult) {
              return forwardResult;
            }
            return { stdout: `${FORWARD_PORT}\n`, stderr: "", exitCode: 0 };
          }
          if (command === "forward --list") {
            const stdout =
              (overrides.forwardListOutput as string | undefined) ??
              (forwardedSocket
                ? `${DEVICE.deviceId} tcp:${FORWARD_PORT} localabstract:${forwardedSocket}\n`
                : "");
            return { stdout, stderr: "", exitCode: 0 };
          }
          if (command.includes(`for f in ${VIDEO_SERVER_LEASE_DIRECTORY}/*.json`)) {
            return { stdout: leaseOutput, stderr: "", exitCode: 0 };
          }
          if (command.startsWith(`shell cat ${VIDEO_SERVER_LEASE_DIRECTORY}/`)) {
            return { stdout: leaseOutput, stderr: "", exitCode: 0 };
          }
          if (command === "shell cat /proc/uptime") {
            return { stdout: `${deviceUptimeMs / 1000} 0.00\n`, stderr: "", exitCode: 0 };
          }
          if (command.startsWith("shell cat /proc/")) {
            return { stdout: processCommandLine, stderr: "", exitCode: 0 };
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
    sessionTokenFactory: () => SESSION_TOKEN,
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
    sessionSocket: () => forwardedSocket,
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
    expect(ctx.commands).toContain(`forward tcp:0 localabstract:${SESSION_SOCKET}`);

    const args = ctx.spawnArgs[0].join(" ");
    expect(args).not.toContain("-s emulator-5554");
    expect(args).toContain("CLASSPATH=/data/local/tmp/automobile-video.jar app_process /");
    expect(args).toContain("--quality low");
    expect(args).toContain("--bit-rate 1500000");
    expect(args).toContain("--size 480x1040");
    expect(args).toContain(`--session-token ${SESSION_TOKEN}`);
    expect(args).toContain(`--socket-name ${SESSION_SOCKET}`);

    // A stream header + one packet: only the packet payload reaches onData.
    ctx.sockets[0].feed(streamHeader(480, 1040));
    ctx.sockets[0].feed(framedPacket(Buffer.from([0, 0, 0, 1, 0x67])));
    expect(ctx.chunks).toEqual([Buffer.from([0, 0, 0, 1, 0x67])]);

    await ctx.source.stop();
  });

  test("requestKeyFrame sends the request-keyframe command byte to the device", async () => {
    const ctx = makeSource();
    await startReady(ctx);

    expect(ctx.source.requestKeyFrame()).toBe(true);
    expect(ctx.sockets[0].written).toEqual([Buffer.from([0x01])]);

    await ctx.source.stop();
    // After stop, no socket is available; the request is a safe no-op.
    expect(ctx.source.requestKeyFrame()).toBe(false);
    expect(ctx.sockets[0].written).toEqual([Buffer.from([0x01])]);
  });

  test("reports null-before-initialization and then precise IDR readiness telemetry", async () => {
    const ctx = makeSource();
    expect(ctx.source.getTelemetry()).toEqual({
      lastEncodedFrameTimestampUs: null,
      lastIdrTimestampUs: null,
      idrRequestCount: null,
      idrCompletionCount: null,
      encodedAccessUnitCount: null,
    });
    await startReady(ctx);

    ctx.sockets[0].feed(streamHeader(480, 1040));
    ctx.sockets[0].feed(
      framedPacket(
        Buffer.from([0, 0, 0, 1, 0x65, 0x80]),
        0x4000000000000000n | 123n
      )
    );

    expect(ctx.source.getTelemetry()).toEqual({
      lastEncodedFrameTimestampUs: 123,
      lastIdrTimestampUs: 123,
      idrRequestCount: 1,
      idrCompletionCount: 1,
      encodedAccessUnitCount: 1,
    });

    await ctx.source.stop();
  });

  test("does not count a replayed IDR as completion of the new keyframe request", async () => {
    const ctx = makeSource();
    await startReady(ctx);

    ctx.sockets[0].feed(streamHeader(480, 1040));
    ctx.sockets[0].feed(
      framedPacket(
        Buffer.from([0, 0, 0, 1, 0x65, 0x80]),
        0x6000000000000000n | 123n
      )
    );

    expect(ctx.source.getTelemetry()).toEqual({
      lastEncodedFrameTimestampUs: 123,
      lastIdrTimestampUs: 123,
      idrRequestCount: 1,
      idrCompletionCount: 0,
      encodedAccessUnitCount: 0,
    });

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

  test("audio startup observes a streaming marker emitted with session readiness", async () => {
    const ctx = makeSource({ audioEnabled: true });
    const startPromise = ctx.source.start();
    await tick(); // push + spawn
    ctx.processes[0].readyAndStreamingStarted();
    await tick(); // readiness resolves, forward + connect
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

  test("removes a forward created after stop races startup", async () => {
    let resolveForward!: (result: { stdout: string; stderr: string; exitCode: number }) => void;
    const forwardResult = new Promise<{ stdout: string; stderr: string; exitCode: number }>(
      resolve => {
        resolveForward = resolve;
      }
    );
    const ctx = makeSource({ forwardResult });

    const startPromise = ctx.source.start();
    await tick();
    await tick();
    expect(ctx.commands).toContain(`forward tcp:0 localabstract:${SESSION_SOCKET}`);

    const stopPromise = ctx.source.stop();
    resolveForward({ stdout: `${FORWARD_PORT}\n`, stderr: "", exitCode: 0 });
    await Promise.all([startPromise, stopPromise]);

    expect(ctx.commands).toContain(`forward --remove tcp:${FORWARD_PORT}`);
  });

  test("rejects start (for fallback) when the server never becomes ready", async () => {
    const ctx = makeSource({ readyTimeoutMs: 5000 });
    const startPromise = ctx.source.start();
    await tick(); // spawn
    ctx.timer.advanceTime(5000); // readiness timeout fires
    await expect(startPromise).rejects.toThrow(/did not become session-ready.*AUTOMOBILE_VIDEO_SERVER_JAR/);
    // A startup failure must NOT be reported via onError (that path is for
    // post-start failures / reconnect); it surfaces as the rejection.
    expect(ctx.errors).toEqual([]);
    expect(ctx.processes[0].killed).toContain("SIGINT");
    expect(ctx.commands).toContain(`forward --remove tcp:${FORWARD_PORT}`);
  });

  test("cleans up a matching lease when stop wins before PID handoff", async () => {
    const lease = JSON.stringify({
      version: 1,
      socketName: SESSION_SOCKET,
      sessionToken: SESSION_TOKEN,
      pid: 1234,
      ownerPid: process.pid,
      deviceSerial: DEVICE.deviceId,
      forwardPort: Number(FORWARD_PORT),
      startedAtMs: 1_000,
      heartbeatAtMs: 95_000,
      heartbeatElapsedRealtimeMs: 95_000,
    });
    const ctx = makeSource({
      leaseOutput: lease,
      processCommandLine:
        `app_process\u0000/\u0000${VIDEO_SERVER_MAIN_CLASS}\u0000--session-token\u0000${SESSION_TOKEN}`,
    });

    const startPromise = ctx.source.start();
    await tick(); // startup reached the server, but it has not emitted readiness.
    await ctx.source.stop();
    ctx.processes[0].exit();
    await expect(startPromise).rejects.toThrow(/exited before ready/);

    expect(ctx.commands).toContain("shell kill -2 1234");
    expect(ctx.commands).toContain(`shell rm -f ${VIDEO_SERVER_LEASE_DIRECTORY}/${SESSION_TOKEN}.json`);
  });

  test("rejects start when the server exits before ready", async () => {
    const ctx = makeSource();
    const startPromise = ctx.source.start();
    await tick();
    ctx.processes[0].exit(1, null);
    await expect(startPromise).rejects.toThrow(/exited before ready/);
    expect(ctx.errors).toEqual([]);
  });

  test("rejects a readiness line whose token does not match this session", async () => {
    const ctx = makeSource();
    const startPromise = ctx.source.start();
    await tick();
    ctx.processes[0].ready("different-session", `${VIDEO_SERVER_SOCKET_PREFIX}_differentsession`);

    await expect(startPromise).rejects.toThrow(/readiness token mismatch/);
    expect(ctx.errors).toEqual([]);
    expect(ctx.processes[0].killed).toContain("SIGINT");
  });

  test("waits for a complete readiness line when stdout splits the socket name", async () => {
    const ctx = makeSource();
    const startPromise = ctx.source.start();
    await tick();

    const socketPrefix = SESSION_SOCKET.slice(0, -1);
    ctx.processes[0].stdout.write(
      Buffer.from(`VIDEO_SESSION_READY token=${SESSION_TOKEN} pid=1234 socket=${socketPrefix}`)
    );
    await tick();
    expect(ctx.sockets).toHaveLength(0);

    ctx.processes[0].stdout.write(Buffer.from(`${SESSION_SOCKET.slice(-1)}\n`));
    await startPromise;
    expect(ctx.source.isRunning).toBe(true);

    await ctx.source.stop();
  });

  test("reconnects a post-start socket close without failing the retained encoder source", async () => {
    const ctx = makeSource();
    await startReady(ctx);

    ctx.sockets[0].emit("close");
    await tick();

    expect(ctx.sockets).toHaveLength(2);
    expect(ctx.sockets[0].destroyed).toBe(true);
    expect(ctx.errors).toEqual([]);
    expect(ctx.source.isRunning).toBe(true);

    ctx.sockets[1].feed(streamHeader(480, 1040));
    expect(ctx.sockets[1].written).toEqual([Buffer.from([0x01])]);

    await ctx.source.stop();
  });

  test("fails after the bounded local socket reconnect window", async () => {
    const firstSocket = new FakeSocket();
    let connectAttempts = 0;
    const ctx = makeSource({
      localSocketReconnectWindowMs: 200,
      localSocketReconnectRetryMs: 100,
      connector: async () => {
        connectAttempts++;
        if (connectAttempts === 1) {
          return firstSocket;
        }
        throw new Error("forward unavailable");
      },
    });

    const startPromise = ctx.source.start();
    await tick();
    ctx.processes[0].ready();
    await tick();
    await startPromise;

    firstSocket.emit("close");
    await tick(); // first failed retry is now waiting 100ms
    ctx.timer.advanceTime(100);
    await tick(); // second failed retry is now waiting 100ms
    ctx.timer.advanceTime(100);
    await tick(); // deadline expires before another connection attempt

    expect(connectAttempts).toBe(3);
    expect(ctx.errors).toHaveLength(1);
    expect(ctx.errors[0].message).toContain("did not reconnect within 200ms");
    expect(ctx.source.isRunning).toBe(false);
  });

  test("fails a hung reconnect attempt at the deadline and closes a late socket", async () => {
    const firstSocket = new FakeSocket();
    const lateSocket = new FakeSocket();
    let resolveHangingConnect: ((socket: StreamSocket) => void) | undefined;
    let connectAttempts = 0;
    const ctx = makeSource({
      localSocketReconnectWindowMs: 200,
      connector: async () => {
        connectAttempts++;
        if (connectAttempts === 1) {
          return firstSocket;
        }
        return new Promise<StreamSocket>(resolve => {
          resolveHangingConnect = resolve;
        });
      },
    });

    const startPromise = ctx.source.start();
    await tick();
    ctx.processes[0].ready();
    await tick();
    await startPromise;

    firstSocket.emit("close");
    await tick();
    ctx.timer.advanceTime(200);
    await tick();

    expect(ctx.errors).toHaveLength(1);
    expect(ctx.errors[0].message).toContain("did not reconnect within 200ms");
    expect(ctx.source.isRunning).toBe(false);

    resolveHangingConnect?.(lateSocket);
    await tick();
    expect(lateSocket.destroyed).toBe(true);
  });

  test("stopping aborts a hung reconnect and closes a late socket without waiting for its deadline", async () => {
    const firstSocket = new FakeSocket();
    const lateSocket = new FakeSocket();
    let resolveHangingConnect: ((socket: StreamSocket) => void) | undefined;
    let reconnectSignal: AbortSignal | undefined;
    let connectAttempts = 0;
    const ctx = makeSource({
      connector: async (_port, signal) => {
        connectAttempts++;
        if (connectAttempts === 1) {
          return firstSocket;
        }
        reconnectSignal = signal;
        return new Promise<StreamSocket>(resolve => {
          resolveHangingConnect = resolve;
        });
      },
    });

    const startPromise = ctx.source.start();
    await tick();
    ctx.processes[0].ready();
    await tick();
    await startPromise;

    firstSocket.emit("close");
    await tick();
    expect(reconnectSignal?.aborted).toBe(false);

    await ctx.source.stop();
    expect(reconnectSignal?.aborted).toBe(true);
    expect(ctx.errors).toEqual([]);

    resolveHangingConnect?.(lateSocket);
    await tick();
    expect(lateSocket.destroyed).toBe(true);
  });

  test("surfaces a post-start server exit via onError", async () => {
    const ctx = makeSource();
    await startReady(ctx);
    ctx.processes[0].exit(137, "SIGKILL");
    expect(ctx.errors).toHaveLength(1);
    expect(ctx.errors[0].message).toContain("video-server exited");
  });

  test("handles a server error while socket connection is pending", async () => {
    const lateSocket = new FakeSocket();
    let resolveConnector: ((socket: StreamSocket) => void) | undefined;
    const ctx = makeSource({
      connector: () => new Promise<StreamSocket>(resolve => {
        resolveConnector = resolve;
      }),
    });

    const startPromise = ctx.source.start();
    await tick();
    ctx.processes[0].ready();
    await tick();

    expect(ctx.processes[0].listenerCount("error")).toBeGreaterThan(0);
    expect(() => ctx.processes[0].emit("error", new Error("server failed while connecting"))).not.toThrow();
    await expect(startPromise).rejects.toThrow("server failed while connecting");
    expect(ctx.errors).toEqual([]);
    expect(ctx.source.isRunning).toBe(false);

    resolveConnector?.(lateSocket);
    await tick();
    expect(lateSocket.destroyed).toBe(true);
  });

  test("removes this source's forward when a matching-token lease has different identity", async () => {
    const mismatchedLease = JSON.stringify({
      version: 1,
      socketName: "automobile_video_replacement",
      sessionToken: SESSION_TOKEN,
      pid: 5678,
      ownerPid: process.pid,
      deviceSerial: DEVICE.deviceId,
      forwardPort: 61234,
      startedAtMs: 95_000,
      heartbeatAtMs: 100_000,
      heartbeatElapsedRealtimeMs: 100_000,
    });
    const ctx = makeSource({ leaseOutput: mismatchedLease });
    await startReady(ctx);

    await ctx.source.stop();

    expect(ctx.commands).toContain(`forward --remove tcp:${FORWARD_PORT}`);
    expect(ctx.commands).not.toContain("shell kill -2 5678");
  });

  test("reconciles an expired owned lease with a matching forward", async () => {
    const staleLease = JSON.stringify({
      version: 1,
      socketName: "automobile_video_stale",
      sessionToken: "stale-session",
      pid: 987,
      ownerPid: 456,
      deviceSerial: DEVICE.deviceId,
      forwardPort: 61234,
      startedAtMs: -40_000,
      heartbeatAtMs: -31_000,
      heartbeatElapsedRealtimeMs: 60_000,
    });
    const ctx = makeSource({
      leaseOutput: staleLease,
      forwardListOutput: `${DEVICE.deviceId} tcp:61234 localabstract:automobile_video_stale\n`,
      processCommandLine:
        `app_process\u0000/\u0000${VIDEO_SERVER_MAIN_CLASS}\u0000--session-token\u0000stale-session`,
    });

    const startPromise = ctx.source.start();
    await tick();

    expect(ctx.commands).toContain("forward --remove tcp:61234");
    expect(ctx.commands).toContain("shell kill -2 987");
    expect(ctx.commands).toContain(`shell rm -f ${VIDEO_SERVER_LEASE_DIRECTORY}/stale-session.json`);

    ctx.processes[0].ready();
    await startPromise;
    await ctx.source.stop();
  });

  test("reconciles a stale lease when multiple lease records are listed", async () => {
    const staleLease = JSON.stringify({
      version: 1,
      socketName: "automobile_video_stale",
      sessionToken: "stale-session",
      pid: 987,
      ownerPid: 456,
      deviceSerial: DEVICE.deviceId,
      forwardPort: 61234,
      startedAtMs: -40_000,
      heartbeatAtMs: -31_000,
      heartbeatElapsedRealtimeMs: 60_000,
    });
    const freshLease = JSON.stringify({
      version: 1,
      socketName: "automobile_video_fresh",
      sessionToken: "fresh-session",
      pid: 988,
      ownerPid: 456,
      deviceSerial: DEVICE.deviceId,
      forwardPort: 61235,
      startedAtMs: 95_000,
      heartbeatAtMs: 95_000,
      heartbeatElapsedRealtimeMs: 95_000,
    });
    const ctx = makeSource({
      leaseOutput: `${staleLease}\n${freshLease}\n`,
      forwardListOutput: `${DEVICE.deviceId} tcp:61234 localabstract:automobile_video_stale\n`,
      processCommandLine:
        `app_process\u0000/\u0000${VIDEO_SERVER_MAIN_CLASS}\u0000--session-token\u0000stale-session`,
    });

    const startPromise = ctx.source.start();
    await tick();

    expect(ctx.commands.some(command => command.includes(`for f in ${VIDEO_SERVER_LEASE_DIRECTORY}/*.json`))).toBe(
      true
    );
    expect(ctx.commands).toContain("shell kill -2 987");
    expect(ctx.commands).not.toContain("shell kill -2 988");

    ctx.processes[0].ready();
    await startPromise;
    await ctx.source.stop();
  });

  test("does not remove a mismatched stale-session forward", async () => {
    const staleLease = JSON.stringify({
      version: 1,
      socketName: "automobile_video_stale",
      sessionToken: "stale-session",
      pid: 987,
      ownerPid: 456,
      deviceSerial: DEVICE.deviceId,
      forwardPort: 61234,
      startedAtMs: -40_000,
      heartbeatAtMs: -31_000,
      heartbeatElapsedRealtimeMs: 60_000,
    });
    const ctx = makeSource({
      leaseOutput: staleLease,
      forwardListOutput: `${DEVICE.deviceId} tcp:61234 localabstract:someone_elses_socket\n`,
      processCommandLine:
        `app_process\u0000/\u0000${VIDEO_SERVER_MAIN_CLASS}\u0000--session-token\u0000stale-session`,
    });

    const startPromise = ctx.source.start();
    await tick();

    expect(ctx.commands).not.toContain("forward --remove tcp:61234");
    expect(ctx.commands).toContain("shell kill -2 987");

    ctx.processes[0].ready();
    await startPromise;
    await ctx.source.stop();
  });

  test("refuses stale cleanup when the PID command line does not contain the lease token", async () => {
    const staleLease = JSON.stringify({
      version: 1,
      socketName: "automobile_video_stale",
      sessionToken: "stale-session",
      pid: 987,
      ownerPid: 456,
      deviceSerial: DEVICE.deviceId,
      forwardPort: 61234,
      startedAtMs: -40_000,
      heartbeatAtMs: -31_000,
      heartbeatElapsedRealtimeMs: 60_000,
    });
    const ctx = makeSource({
      leaseOutput: staleLease,
      forwardListOutput: `${DEVICE.deviceId} tcp:61234 localabstract:automobile_video_stale\n`,
      processCommandLine:
        `app_process\u0000/\u0000${VIDEO_SERVER_MAIN_CLASS}\u0000--session-token\u0000another-session`,
    });

    const startPromise = ctx.source.start();
    await tick();

    expect(ctx.commands).toContain("forward --remove tcp:61234");
    expect(ctx.commands).not.toContain("shell kill -2 987");

    ctx.processes[0].ready();
    await startPromise;
    await ctx.source.stop();
  });

  test("refuses stale cleanup when the lease token is not the --session-token value", async () => {
    const staleLease = JSON.stringify({
      version: 1,
      socketName: "automobile_video_stale",
      sessionToken: "stale-session",
      pid: 987,
      ownerPid: 456,
      deviceSerial: DEVICE.deviceId,
      forwardPort: 61234,
      startedAtMs: -40_000,
      heartbeatAtMs: -31_000,
      heartbeatElapsedRealtimeMs: 60_000,
    });
    const ctx = makeSource({
      leaseOutput: staleLease,
      forwardListOutput: `${DEVICE.deviceId} tcp:61234 localabstract:automobile_video_stale\n`,
      processCommandLine:
        `app_process\u0000/\u0000${VIDEO_SERVER_MAIN_CLASS}\u0000--session-token\u0000other-session\u0000--quality\u0000stale-session`,
    });

    const startPromise = ctx.source.start();
    await tick();

    expect(ctx.commands).toContain("forward --remove tcp:61234");
    expect(ctx.commands).not.toContain("shell kill -2 987");

    ctx.processes[0].ready();
    await startPromise;
    await ctx.source.stop();
  });

  test("uses device uptime instead of a lease wall-clock timestamp for expiry", async () => {
    const freshLeaseWithOldWallClock = JSON.stringify({
      version: 1,
      socketName: "automobile_video_fresh",
      sessionToken: "fresh-session",
      pid: 987,
      ownerPid: 456,
      deviceSerial: DEVICE.deviceId,
      forwardPort: 61234,
      startedAtMs: -1_000_000,
      heartbeatAtMs: -1_000_000,
      heartbeatElapsedRealtimeMs: 95_000,
    });
    const ctx = makeSource({
      leaseOutput: freshLeaseWithOldWallClock,
      deviceUptimeMs: 100_000,
    });

    const startPromise = ctx.source.start();
    await tick();

    expect(ctx.commands).not.toContain("forward --remove tcp:61234");
    expect(ctx.commands).not.toContain("shell kill -2 987");

    ctx.processes[0].ready();
    await startPromise;
    await ctx.source.stop();
  });

  test("reconciles a stale lease from before the device rebooted", async () => {
    const staleLeaseBeforeReboot = JSON.stringify({
      version: 1,
      socketName: "automobile_video_stale",
      sessionToken: "stale-session",
      pid: 987,
      ownerPid: 456,
      deviceSerial: DEVICE.deviceId,
      forwardPort: 61234,
      startedAtMs: -40_000,
      heartbeatAtMs: -31_000,
      heartbeatElapsedRealtimeMs: 120_000,
    });
    const ctx = makeSource({
      leaseOutput: staleLeaseBeforeReboot,
      deviceUptimeMs: 5_000,
      forwardListOutput: `${DEVICE.deviceId} tcp:61234 localabstract:automobile_video_stale\n`,
      processCommandLine:
        `app_process\u0000/\u0000${VIDEO_SERVER_MAIN_CLASS}\u0000--session-token\u0000stale-session`,
    });

    const startPromise = ctx.source.start();
    await tick();

    expect(ctx.commands).toContain("forward --remove tcp:61234");
    expect(ctx.commands).toContain("shell kill -2 987");
    expect(ctx.commands).toContain(`shell rm -f ${VIDEO_SERVER_LEASE_DIRECTORY}/stale-session.json`);

    ctx.processes[0].ready();
    await startPromise;
    await ctx.source.stop();
  });

  test("uses separate socket leases for separate device sources", async () => {
    const first = makeSource({ sessionTokenFactory: () => "first-session" });
    const second = makeSource({
      sessionTokenFactory: () => "second-session",
      device: { ...DEVICE, deviceId: "emulator-5556" },
    });

    const firstStart = first.source.start();
    const secondStart = second.source.start();
    await tick();
    first.processes[0].ready("first-session", `${VIDEO_SERVER_SOCKET_PREFIX}_firstsession`);
    second.processes[0].ready("second-session", `${VIDEO_SERVER_SOCKET_PREFIX}_secondsession`);
    await Promise.all([firstStart, secondStart]);

    expect(first.sessionSocket()).toBe(`${VIDEO_SERVER_SOCKET_PREFIX}_firstsession`);
    expect(second.sessionSocket()).toBe(`${VIDEO_SERVER_SOCKET_PREFIX}_secondsession`);

    await first.source.stop();
    await second.source.stop();
  });
});
