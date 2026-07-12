import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import {
  PersistentEncoderH264Source,
  VIDEO_SERVER_SOCKET_NAME,
  type SocketConnector,
  type StreamSocket,
} from "../../../src/features/webrtc/PersistentEncoderH264Source";
import type { ProcessSpawner, SpawnedProcess } from "../../../src/features/webrtc/processSpawner";
import { VIDEO_SERVER_CODEC_ID_H264 } from "../../../src/features/webrtc/VideoServerStreamParser";
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

function makeSource(overrides: Record<string, unknown> = {}) {
  const commands: string[] = [];
  const processes: FakeProcess[] = [];
  const sockets: FakeSocket[] = [];
  const spawnArgs: string[][] = [];
  const chunks: Buffer[] = [];
  const errors: Error[] = [];
  const timer = new FakeTimer();

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
      } as unknown as ReturnType<AdbClientFactory["create"]>;
    },
  };

  const spawner: ProcessSpawner = (_command, args) => {
    spawnArgs.push(args);
    const proc = new FakeProcess();
    processes.push(proc);
    return proc;
  };

  const connector: SocketConnector = async () => {
    const socket = new FakeSocket();
    sockets.push(socket);
    return socket;
  };

  const source = new PersistentEncoderH264Source({
    device: DEVICE,
    onData: chunk => chunks.push(chunk),
    onError: error => errors.push(error),
    jarPath: "/tmp/automobile-video.jar",
    adbFactory,
    spawner,
    connector,
    timer,
    ...overrides,
  });

  return { source, commands, processes, sockets, spawnArgs, chunks, errors, timer };
}

/** Drive a successful start: launch -> ready -> forward -> connect. */
async function startReady(ctx: ReturnType<typeof makeSource>): Promise<void> {
  const startPromise = ctx.source.start();
  await tick(); // push + spawn
  ctx.processes[0].ready();
  await tick(); // ready resolves, forward + connect
  await startPromise;
}

describe("PersistentEncoderH264Source", () => {
  test("pushes the jar, launches the server with overrides, forwards, and forwards frames", async () => {
    const ctx = makeSource({ bitrateBps: 1_500_000, size: { width: 480, height: 1040 }, quality: "low" });
    await startReady(ctx);

    expect(ctx.commands.some(c => c.startsWith("push") && c.includes("/data/local/tmp/automobile-video.jar"))).toBe(true);
    expect(ctx.commands).toContain(`forward tcp:0 localabstract:${VIDEO_SERVER_SOCKET_NAME}`);

    const args = ctx.spawnArgs[0].join(" ");
    expect(args).toContain("-s emulator-5554");
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
