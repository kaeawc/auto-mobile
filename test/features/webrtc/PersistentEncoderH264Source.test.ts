import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { createHash } from "node:crypto";
import { PassThrough } from "node:stream";
import {
  InMemoryActiveVideoSessionRegistry,
  PersistentEncoderH264Source,
  VIDEO_SERVER_HANDSHAKE_VERSION,
  VIDEO_SERVER_LEASE_DIRECTORY,
  VIDEO_SERVER_SOCKET_PREFIX,
  type ActiveVideoSessionRegistry,
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

const DEVICE: BootedDevice = {
  deviceId: "emulator-5554",
  platform: "android",
  name: "t",
} as BootedDevice;
const FORWARD_PORT = "45999";
const REMOTE_JAR_PATH = "/data/local/tmp/automobile-video.jar";
// Host-known expected integrity of the local jar the source would push (issue #4733).
const EXPECTED_JAR_SHA256 = "a".repeat(64);
const EXPECTED_JAR_SIZE = 2_500_000;
// Combined `sha256sum` + `wc -c` probe stdout the on-device jar-hash helper parses.
const remoteJarProbeOutput = (sha256: string, size: number): string =>
  `${sha256}  ${REMOTE_JAR_PATH}\n${size}\n`;
const SESSION_TOKEN = "session-0001";
const SESSION_SOCKET = `${VIDEO_SERVER_SOCKET_PREFIX}_session0001`;
const VIDEO_SERVER_MAIN_CLASS = "dev.jasonpearson.automobile.video.VideoServer";
// SHA-256 hex of a session token, matching the device's `sessionTokenSha256Hex` (issue #4731). The
// lease persists only this hash, so fixtures build `sessionTokenHash` from it.
const hashToken = (token: string): string =>
  createHash("sha256").update(token, "ascii").digest("hex");
// Flush the nextTick + microtask queues so the source's async launch steps and
// the PassThrough `data` emissions settle (no fake timer involved here).
const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

class FakeProcess extends EventEmitter implements SpawnedProcess {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  killed: string[] = [];
  kill(signal?: NodeJS.Signals): boolean {
    this.killed.push(signal ?? "SIGTERM");
    return true;
  }
  ready(
    token: string = SESSION_TOKEN,
    socketName: string = SESSION_SOCKET,
    pid: number = 1234,
    proto: number | null = VIDEO_SERVER_HANDSHAKE_VERSION,
  ): void {
    const protoSuffix = proto === null ? "" : ` proto=${proto}`;
    this.stdout.write(
      Buffer.from(
        `VIDEO_SESSION_READY token=${token} pid=${pid} socket=${socketName}${protoSuffix}\n`,
      ),
    );
    this.stdout.write(
      Buffer.from(`Waiting for client connection on localabstract:${socketName}\n`),
    );
  }
  readyAndStreamingStarted(): void {
    this.stdout.write(
      Buffer.from(
        `VIDEO_SESSION_READY token=${SESSION_TOKEN} pid=1234 socket=${SESSION_SOCKET}\n` +
          "Streaming started\n",
      ),
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

/** Expected pre-stream handshake frame (issue #4729): MAGIC + VERSION + LEN + token. */
function handshakeFrame(
  token: string = SESSION_TOKEN,
  version: number = VIDEO_SERVER_HANDSHAKE_VERSION,
): Buffer {
  const tokenBytes = Buffer.from(token, "ascii");
  const frame = Buffer.alloc(6 + tokenBytes.length);
  Buffer.from([0x41, 0x56, 0x4d, 0x48]).copy(frame, 0);
  frame.writeUInt8(version, 4);
  frame.writeUInt8(tokenBytes.length, 5);
  tokenBytes.copy(frame, 6);
  return frame;
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
    `app_process\u0000/\u0000${VIDEO_SERVER_MAIN_CLASS}\u0000--socket-name\u0000automobile_video_stale`;

  // Command substrings whose ADB call should hang forever, exercising the
  // injected withTimeout bound under FakeTimer (never a real wait).
  const hangCommands = (overrides.hangCommands as string[] | undefined) ?? [];
  const neverResolves = <T>(): Promise<T> => new Promise<T>(() => {});

  // Models the on-device jar (issue #4733): the remote copy matches the expected
  // host bytes only after a push has landed, unless a test opts into a specific
  // pre-push state (already-matching, always-mismatching, or a raw probe string).
  let pushed = false;
  const remoteJarProbeStdout = (): string => {
    if (overrides.remoteJarProbe !== undefined) {
      return overrides.remoteJarProbe as string;
    }
    if (overrides.remoteJarAlwaysMismatch === true) {
      return remoteJarProbeOutput("b".repeat(64), 999);
    }
    if (overrides.remoteJarMatchesBeforePush === true) {
      return remoteJarProbeOutput(EXPECTED_JAR_SHA256, EXPECTED_JAR_SIZE);
    }
    if (pushed) {
      return remoteJarProbeOutput(EXPECTED_JAR_SHA256, EXPECTED_JAR_SIZE);
    }
    // A valid-but-different remote jar before the push (vs. an absent/unreadable
    // one, the default empty probe) — both must push, but this exercises the
    // "differs" branch specifically.
    return overrides.remoteJarDiffersBeforePush === true
      ? remoteJarProbeOutput("c".repeat(64), 42)
      : "";
  };

  const adbFactory: AdbClientFactory = {
    create() {
      return {
        getAdbPathOnly: async () => "adb",
        executeCommand: (command: string) => {
          commands.push(command);
          if (hangCommands.some((sub) => command.includes(sub))) {
            return neverResolves<{ stdout: string; stderr: string; exitCode: number }>();
          }
          if (command.startsWith("push")) {
            pushed = true;
            return Promise.resolve({ stdout: "", stderr: "", exitCode: 0 });
          }
          if (command.includes("sha256sum") && command.includes("automobile-video.jar")) {
            return Promise.resolve({ stdout: remoteJarProbeStdout(), stderr: "", exitCode: 0 });
          }
          if (command.startsWith("forward tcp:0")) {
            forwardedSocket = command.split("localabstract:")[1] ?? null;
            if (forwardResult) {
              return forwardResult;
            }
            return Promise.resolve({ stdout: `${FORWARD_PORT}\n`, stderr: "", exitCode: 0 });
          }
          return Promise.resolve(resolveCommand(command));
        },
        spawn: async (args: string[]) => {
          spawnArgs.push(args);
          if (overrides.spawnHang === true) {
            return neverResolves<FakeProcess>();
          }
          const process = new FakeProcess();
          processes.push(process);
          return process;
        },
      } as unknown as ReturnType<AdbClientFactory["create"]>;
    },
  };

  function resolveCommand(command: string): { stdout: string; stderr: string; exitCode: number } {
    if (command === "forward --list") {
      const stdout =
        (overrides.forwardListOutput as string | undefined) ??
        (forwardedSocket
          ? `${DEVICE.deviceId} tcp:${FORWARD_PORT} localabstract:${forwardedSocket}\n`
          : "");
      return { stdout, stderr: "", exitCode: 0 };
    }
    if (command.includes("stat -c")) {
      // The orphan-file sweep listing (`NOW <epoch>` + `<mtime> <path>` rows).
      return {
        stdout: (overrides.leaseFileListing as string | undefined) ?? "",
        stderr: "",
        exitCode: 0,
      };
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
  }

  const connector: SocketConnector = async () => {
    const socket = new FakeSocket();
    sockets.push(socket);
    (overrides.connectorHook as ((socket: FakeSocket) => void) | undefined)?.(socket);
    return socket;
  };

  // Default to a fresh registry per source so the process-lived singleton never
  // leaks socket-name claims across tests; individual tests may inject a shared
  // one to exercise sibling-session behavior.
  const activeVideoSessionRegistry =
    (overrides.activeVideoSessionRegistry as ActiveVideoSessionRegistry | undefined) ??
    new InMemoryActiveVideoSessionRegistry();

  const source = new PersistentEncoderH264Source({
    device: DEVICE,
    onData: (chunk) => chunks.push(chunk),
    onAudioData: (chunk) => audioChunks.push(chunk),
    onError: (error) => errors.push(error),
    jarPath: "/tmp/automobile-video.jar",
    // Host-known expected jar integrity (issue #4733) via a fake so no real file
    // is hashed; individual tests override for override/build-path coverage.
    jarIntegrityProvider: {
      computeLocalJarIntegrity: async () =>
        (overrides.expectedJarIntegrity as { sha256: string; size: number } | undefined) ?? {
          sha256: EXPECTED_JAR_SHA256,
          size: EXPECTED_JAR_SIZE,
        },
    },
    adbFactory,
    connector,
    timer,
    sessionTokenFactory: () => SESSION_TOKEN,
    // Decoupled from the token (issue #4729): a deterministic opaque socket name so
    // existing forward/socket-name assertions stay stable while the production
    // default derives it from the canonical IdGenerator.
    socketNameFactory: () => SESSION_SOCKET,
    ...overrides,
    activeVideoSessionRegistry,
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
    activeVideoSessionRegistry,
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

describe("PersistentEncoderH264Source on-device jar integrity (issue #4733)", () => {
  const pushCommands = (ctx: ReturnType<typeof makeSource>): string[] =>
    ctx.commands.filter((c) => c.startsWith("push") && c.includes(REMOTE_JAR_PATH));
  const probeCommands = (ctx: ReturnType<typeof makeSource>): string[] =>
    ctx.commands.filter((c) => c.includes("sha256sum") && c.includes("automobile-video.jar"));

  test("skips the push when the on-device jar already matches the expected bytes", async () => {
    const ctx = makeSource({ remoteJarMatchesBeforePush: true });
    await startReady(ctx);

    // Byte-identical remote copy: no USB push, and the pre-push match doubles as
    // the pre-launch integrity gate (a single probe on the happy path).
    expect(pushCommands(ctx)).toHaveLength(0);
    expect(probeCommands(ctx)).toHaveLength(1);
    // Launch still proceeds.
    expect(ctx.spawnArgs).toHaveLength(1);

    await ctx.source.stop();
  });

  test("pushes when the on-device jar differs, then launches after re-verify", async () => {
    // A valid-but-different remote jar pre-push; the fake device updates to the
    // expected bytes once the push lands, so the pre-launch verify passes.
    const ctx = makeSource({ remoteJarDiffersBeforePush: true });
    await startReady(ctx);

    expect(pushCommands(ctx)).toHaveLength(1);
    // Two probes: the pre-push comparison and the post-push pre-launch verify.
    expect(probeCommands(ctx)).toHaveLength(2);
    expect(ctx.spawnArgs).toHaveLength(1);

    await ctx.source.stop();
  });

  test("pushes when the remote jar cannot be hashed (uncertainty), never skips", async () => {
    // Perma-empty probe => integrity unknown at both the pre-push comparison and
    // the pre-launch verify. Uncertainty never skips the push; and because the
    // push overwrote the remote with trusted bytes, the unverifiable pre-launch
    // check degrades-and-proceeds (device may lack sha256sum/wc) rather than
    // regressing to screenrecord.
    const ctx = makeSource({ remoteJarProbe: "" });
    await startReady(ctx);

    expect(pushCommands(ctx).length).toBeGreaterThanOrEqual(1);
    expect(ctx.spawnArgs).toHaveLength(1);

    await ctx.source.stop();
  });

  test("does not skip the push when only the size matches but the hash differs", async () => {
    // A same-size, different-bytes remote jar (a targeted swap) must still push.
    const ctx = makeSource({
      remoteJarProbe: remoteJarProbeOutput("d".repeat(64), EXPECTED_JAR_SIZE),
    });
    // The pre-push probe (wrong hash) forces a push; after the push the fake would
    // keep returning the override, so this scenario also refuses at pre-launch —
    // exactly the tamper guard. Assert the push happened.
    let thrown: unknown;
    try {
      await ctx.source.start();
    } catch (error) {
      thrown = error;
    }
    expect(pushCommands(ctx)).toHaveLength(1);
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toContain("failed integrity verification");

    await ctx.source.stop();
  });

  test("refuses to launch when the post-push on-device jar fails integrity verification", async () => {
    // The remote jar never matches, even after the push: a tamper/TOCTOU signal.
    const ctx = makeSource({ remoteJarAlwaysMismatch: true });
    const errors: Error[] = [];

    let thrown: unknown;
    try {
      await ctx.source.start();
    } catch (error) {
      thrown = error;
    }
    // start() tears down and rethrows so the factory can fall back to screenrecord.
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toContain("failed integrity verification");
    // app_process must NOT have been spawned.
    expect(ctx.spawnArgs).toHaveLength(0);
    expect(ctx.source.isRunning).toBe(false);
    void errors;
  });
});

describe("PersistentEncoderH264Source", () => {
  test("pushes the jar, launches the server with overrides, forwards, and forwards frames", async () => {
    const ctx = makeSource({
      bitrateBps: 1_500_000,
      size: { width: 480, height: 1040 },
      quality: "low",
      fps: 24,
    });
    await startReady(ctx);

    expect(
      ctx.commands.some(
        (c) => c.startsWith("push") && c.includes("/data/local/tmp/automobile-video.jar"),
      ),
    ).toBe(true);
    expect(ctx.commands).toContain(`forward tcp:0 localabstract:${SESSION_SOCKET}`);

    const args = ctx.spawnArgs[0].join(" ");
    expect(args).not.toContain("-s emulator-5554");
    expect(args).toContain("CLASSPATH=/data/local/tmp/automobile-video.jar app_process /");
    expect(args).toContain("--quality low");
    expect(args).toContain("--bit-rate 1500000");
    expect(args).toContain("--fps 24");
    expect(args).toContain("--size 480x1040");
    expect(args).toContain(`--session-token ${SESSION_TOKEN}`);
    expect(args).toContain(`--socket-name ${SESSION_SOCKET}`);

    // A stream header + one packet: only the packet payload reaches onData.
    ctx.sockets[0].feed(streamHeader(480, 1040));
    ctx.sockets[0].feed(framedPacket(Buffer.from([0, 0, 0, 1, 0x67])));
    expect(ctx.chunks).toEqual([Buffer.from([0, 0, 0, 1, 0x67])]);

    await ctx.source.stop();
  });

  test("surfaces the attested rotation from a config packet via onRotation (issue #4786)", async () => {
    const rotations: number[] = [];
    const ctx = makeSource({ onRotation: (rotation: number) => rotations.push(rotation) });
    await startReady(ctx);

    const FLAG_CONFIG = 1n << 63n;
    const rotationBits = (rotation: number): bigint => (BigInt(rotation) & 0b11n) << 59n;
    ctx.sockets[0].feed(streamHeader(480, 1040));
    // Config packet attesting rotation 3, then a non-config frame that must NOT report rotation.
    ctx.sockets[0].feed(
      framedPacket(Buffer.from([0, 0, 0, 1, 0x67]), FLAG_CONFIG | rotationBits(3)),
    );
    ctx.sockets[0].feed(framedPacket(Buffer.from([0, 0, 0, 1, 0x65])));

    expect(rotations).toEqual([3]);
    // The config payload still flows to onData unchanged.
    expect(ctx.chunks[0]).toEqual(Buffer.from([0, 0, 0, 1, 0x67]));

    await ctx.source.stop();
  });

  test("omits --fps when no frame rate is requested, letting the preset default apply", async () => {
    const ctx = makeSource();
    await startReady(ctx);

    const args = ctx.spawnArgs[0].join(" ");
    expect(args).not.toContain("--fps");

    await ctx.source.stop();
  });

  test("requestKeyFrame sends the request-keyframe command byte to the device", async () => {
    const ctx = makeSource();
    await startReady(ctx);

    expect(ctx.source.requestKeyFrame()).toBe(true);
    // The handshake frame is written first on connect (issue #4729), then the command byte.
    expect(ctx.sockets[0].written).toEqual([handshakeFrame(), Buffer.from([0x01])]);

    await ctx.source.stop();
    // After stop, no socket is available; the request is a safe no-op.
    expect(ctx.source.requestKeyFrame()).toBe(false);
    expect(ctx.sockets[0].written).toEqual([handshakeFrame(), Buffer.from([0x01])]);
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
      framedPacket(Buffer.from([0, 0, 0, 1, 0x65, 0x80]), 0x4000000000000000n | 123n),
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
      framedPacket(Buffer.from([0, 0, 0, 1, 0x65, 0x80]), 0x6000000000000000n | 123n),
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
    expect(ctx.commands.some((c) => c.includes("pkill"))).toBe(false);
  });

  test("removes a forward created after stop races startup", async () => {
    let resolveForward!: (result: { stdout: string; stderr: string; exitCode: number }) => void;
    const forwardResult = new Promise<{ stdout: string; stderr: string; exitCode: number }>(
      (resolve) => {
        resolveForward = resolve;
      },
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
    await expect(startPromise).rejects.toThrow(
      /did not become session-ready.*AUTOMOBILE_VIDEO_SERVER_JAR/,
    );
    // A startup failure must NOT be reported via onError (that path is for
    // post-start failures / reconnect); it surfaces as the rejection.
    expect(ctx.errors).toEqual([]);
    expect(ctx.processes[0].killed).toContain("SIGINT");
    expect(ctx.commands).toContain(`forward --remove tcp:${FORWARD_PORT}`);
  });

  test("rejects start (for fallback) when the server exits after readiness before socket connection", async () => {
    const ctx = makeSource();
    const startPromise = ctx.source.start();
    await tick(); // push + spawn
    ctx.processes[0].ready();
    queueMicrotask(() => ctx.processes[0].exit(1, null));

    await expect(startPromise).rejects.toThrow(/video-server exited \(code=1, signal=null\)/);
    expect(ctx.errors).toEqual([]);
    expect(ctx.source.isRunning).toBe(false);
    expect(ctx.commands).toContain(`forward --remove tcp:${FORWARD_PORT}`);
  });

  test("cleans up a matching lease when stop wins before PID handoff", async () => {
    const lease = JSON.stringify({
      version: 1,
      socketName: SESSION_SOCKET,
      sessionTokenHash: hashToken(SESSION_TOKEN),
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
      processCommandLine: `app_process\u0000/\u0000${VIDEO_SERVER_MAIN_CLASS}\u0000--socket-name\u0000${SESSION_SOCKET}`,
    });

    const startPromise = ctx.source.start();
    await tick(); // startup reached the server, but it has not emitted readiness.
    await ctx.source.stop();
    ctx.processes[0].exit();
    await expect(startPromise).rejects.toThrow(/exited before ready/);

    expect(ctx.commands).toContain("shell kill -2 1234");
    expect(ctx.commands).toContain(
      `shell rm -f ${VIDEO_SERVER_LEASE_DIRECTORY}/${SESSION_SOCKET}.json`,
    );
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
      Buffer.from(`VIDEO_SESSION_READY token=${SESSION_TOKEN} pid=1234 socket=${socketPrefix}`),
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
    // The reconnected socket re-sends the handshake before the keyframe request (issue #4729).
    expect(ctx.sockets[1].written).toEqual([handshakeFrame(), Buffer.from([0x01])]);

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
        return new Promise<StreamSocket>((resolve) => {
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
        return new Promise<StreamSocket>((resolve) => {
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

  test("surfaces a post-start server exit via onError when relaunch is disabled", async () => {
    const ctx = makeSource({ maxServerRelaunchAttempts: 0 });
    await startReady(ctx);
    ctx.processes[0].exit(137, "SIGKILL");
    await tick();
    expect(ctx.errors).toHaveLength(1);
    expect(ctx.errors[0].message).toContain("video-server exited");
    expect(ctx.source.isRunning).toBe(false);
  });

  test("relaunches the on-device server after a single transient post-start exit", async () => {
    const ctx = makeSource({ serverRelaunchBackoff: 500, maxServerRelaunchAttempts: 3 });
    await startReady(ctx);

    ctx.processes[0].exit(137, "SIGKILL");
    await tick();
    // Backoff has not elapsed: no relaunch spawn yet, and the source is not failed.
    expect(ctx.processes).toHaveLength(1);
    expect(ctx.errors).toEqual([]);

    ctx.timer.advanceTime(500);
    await tick();
    await tick(); // teardown of the dead session + fresh launch + spawn
    expect(ctx.processes).toHaveLength(2);

    ctx.processes[1].ready();
    await tick();
    await tick(); // readiness resolves, forward + reconnect

    expect(ctx.source.isRunning).toBe(true);
    expect(ctx.errors).toEqual([]);

    // Streaming resumes on the relaunched server's socket.
    const latestSocket = ctx.sockets[ctx.sockets.length - 1];
    latestSocket.feed(streamHeader(480, 1040));
    latestSocket.feed(framedPacket(Buffer.from([0, 0, 0, 1, 0x67])));
    expect(ctx.chunks).toEqual([Buffer.from([0, 0, 0, 1, 0x67])]);

    await ctx.source.stop();
  });

  test("falls back to screenrecord after repeated post-start exits exhaust the relaunch budget", async () => {
    const fellBackWith: Error[] = [];
    const ctx = makeSource({
      serverRelaunchBackoff: 0,
      maxServerRelaunchAttempts: 2,
      onScreenrecordFallback: async (error: Error) => {
        fellBackWith.push(error);
      },
    });
    await startReady(ctx);

    // Relaunch 1: exit -> recovered on a fresh server.
    ctx.processes[0].exit(1, null);
    await tick();
    await tick();
    ctx.processes[1].ready();
    await tick();
    await tick();
    expect(ctx.source.isRunning).toBe(true);

    // Relaunch 2: exit -> recovered again (budget now spent).
    ctx.processes[1].exit(1, null);
    await tick();
    await tick();
    ctx.processes[2].ready();
    await tick();
    await tick();
    expect(ctx.source.isRunning).toBe(true);
    expect(ctx.processes).toHaveLength(3);

    // Third exit: budget spent -> screenrecord fallback, NOT onError.
    ctx.processes[2].exit(1, null);
    await tick();
    await tick();

    expect(fellBackWith).toHaveLength(1);
    expect(fellBackWith[0].message).toContain("video-server exited");
    expect(ctx.errors).toEqual([]);
    expect(ctx.processes).toHaveLength(3); // no further relaunch attempt
    expect(ctx.source.isRunning).toBe(false);
  });

  test("surfaces onError only after the relaunch budget is spent when no fallback is wired", async () => {
    const ctx = makeSource({ serverRelaunchBackoff: 0, maxServerRelaunchAttempts: 1 });
    await startReady(ctx);

    // Relaunch 1 recovers.
    ctx.processes[0].exit(1, null);
    await tick();
    await tick();
    ctx.processes[1].ready();
    await tick();
    await tick();
    expect(ctx.source.isRunning).toBe(true);
    expect(ctx.errors).toEqual([]);

    // Budget spent: the next exit surfaces via onError.
    ctx.processes[1].exit(1, null);
    await tick();
    await tick();
    expect(ctx.errors).toHaveLength(1);
    expect(ctx.errors[0].message).toContain("video-server exited");
    expect(ctx.source.isRunning).toBe(false);
    expect(ctx.processes).toHaveLength(2);
  });

  test("stopping during a relaunch backoff cancels the relaunch without failing", async () => {
    const ctx = makeSource({ serverRelaunchBackoff: 5000, maxServerRelaunchAttempts: 3 });
    await startReady(ctx);

    ctx.processes[0].exit(1, null);
    await tick();
    expect(ctx.processes).toHaveLength(1); // waiting out the backoff

    await ctx.source.stop();
    // The backoff never elapses; the relaunch is aborted and no new server spawns.
    ctx.timer.advanceTime(5000);
    await tick();
    expect(ctx.processes).toHaveLength(1);
    expect(ctx.errors).toEqual([]);
    expect(ctx.source.isRunning).toBe(false);
  });

  test("handles a server error while socket connection is pending", async () => {
    const lateSocket = new FakeSocket();
    let resolveConnector: ((socket: StreamSocket) => void) | undefined;
    const ctx = makeSource({
      connector: () =>
        new Promise<StreamSocket>((resolve) => {
          resolveConnector = resolve;
        }),
    });

    const startPromise = ctx.source.start();
    await tick();
    ctx.processes[0].ready();
    await tick();

    expect(ctx.processes[0].listenerCount("error")).toBeGreaterThan(0);
    expect(() =>
      ctx.processes[0].emit("error", new Error("server failed while connecting")),
    ).not.toThrow();
    await expect(startPromise).rejects.toThrow("server failed while connecting");
    expect(ctx.errors).toEqual([]);
    expect(ctx.source.isRunning).toBe(false);

    resolveConnector?.(lateSocket);
    await tick();
    expect(lateSocket.destroyed).toBe(true);
  });

  test("removes this source's forward when the lease for this socket has a different session identity", async () => {
    // The lease file is named by our socket, but its persisted token hash belongs to a different
    // session (a socket-name reuse). Ownership fails the hash check (issue #4731), so we clean only
    // our own forward and never kill the other session's process.
    const mismatchedLease = JSON.stringify({
      version: 2,
      socketName: SESSION_SOCKET,
      sessionTokenHash: hashToken("someone-elses-token"),
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
    expect(ctx.commands).not.toContain("forward --remove tcp:61234");
    expect(ctx.commands).not.toContain("shell kill -2 5678");
  });

  test("does not remove a replacement forward after this session's lease disappears", async () => {
    const ctx = makeSource({
      forwardListOutput: `${DEVICE.deviceId} tcp:${FORWARD_PORT} localabstract:someone_elses_socket\n`,
    });
    await startReady(ctx);

    await ctx.source.stop();

    expect(ctx.commands).toContain("forward --list");
    expect(ctx.commands).not.toContain(`forward --remove tcp:${FORWARD_PORT}`);
  });

  test("reconciles an expired owned lease with a matching forward", async () => {
    const staleLease = JSON.stringify({
      version: 1,
      socketName: "automobile_video_stale",
      sessionTokenHash: hashToken("stale-session"),
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
      processCommandLine: `app_process\u0000/\u0000${VIDEO_SERVER_MAIN_CLASS}\u0000--socket-name\u0000automobile_video_stale`,
    });

    const startPromise = ctx.source.start();
    await tick();

    expect(ctx.commands).toContain("forward --remove tcp:61234");
    expect(ctx.commands).toContain("shell kill -2 987");
    expect(ctx.commands).toContain(
      `shell rm -f ${VIDEO_SERVER_LEASE_DIRECTORY}/automobile_video_stale.json`,
    );

    ctx.processes[0].ready();
    await startPromise;
    await ctx.source.stop();
  });

  test("reconciles a stale lease when multiple lease records are listed", async () => {
    const staleLease = JSON.stringify({
      version: 1,
      socketName: "automobile_video_stale",
      sessionTokenHash: hashToken("stale-session"),
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
      sessionTokenHash: hashToken("fresh-session"),
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
      processCommandLine: `app_process\u0000/\u0000${VIDEO_SERVER_MAIN_CLASS}\u0000--socket-name\u0000automobile_video_stale`,
    });

    const startPromise = ctx.source.start();
    await tick();

    expect(
      ctx.commands.some((command) =>
        command.includes(`for f in ${VIDEO_SERVER_LEASE_DIRECTORY}/*.json`),
      ),
    ).toBe(true);
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
      sessionTokenHash: hashToken("stale-session"),
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
      processCommandLine: `app_process\u0000/\u0000${VIDEO_SERVER_MAIN_CLASS}\u0000--socket-name\u0000automobile_video_stale`,
    });

    const startPromise = ctx.source.start();
    await tick();

    expect(ctx.commands).not.toContain("forward --remove tcp:61234");
    expect(ctx.commands).toContain("shell kill -2 987");

    ctx.processes[0].ready();
    await startPromise;
    await ctx.source.stop();
  });

  test("sweeps an orphaned forward whose lease is gone after a simulated daemon SIGKILL", async () => {
    // Device server self-expired: it deleted its own lease, so no lease names
    // this forward — the lease-driven loop can never reclaim it (issue #4753).
    const orphanSocket = `${VIDEO_SERVER_SOCKET_PREFIX}_orphaned`;
    const ctx = makeSource({
      leaseOutput: "",
      forwardListOutput: `${DEVICE.deviceId} tcp:52001 localabstract:${orphanSocket}\n`,
    });

    const startPromise = ctx.source.start();
    await tick();

    expect(ctx.commands).toContain("forward --remove tcp:52001");

    ctx.processes[0].ready();
    await startPromise;
    await ctx.source.stop();
  });

  test("does not sweep a concurrently-starting session's forward (forward exists, lease not yet written)", async () => {
    // A sibling session claimed its socket name before opening its forward; its
    // lease has not landed yet. The sweep must leave that forward alone.
    const registry = new InMemoryActiveVideoSessionRegistry();
    const concurrentSocket = `${VIDEO_SERVER_SOCKET_PREFIX}_concurrent`;
    registry.add(DEVICE.deviceId, concurrentSocket);
    const ctx = makeSource({
      activeVideoSessionRegistry: registry,
      leaseOutput: "",
      forwardListOutput: `${DEVICE.deviceId} tcp:52002 localabstract:${concurrentSocket}\n`,
    });

    const startPromise = ctx.source.start();
    await tick();

    expect(ctx.commands).toContain("forward --list");
    expect(ctx.commands).not.toContain("forward --remove tcp:52002");

    ctx.processes[0].ready();
    await startPromise;
    await ctx.source.stop();
  });

  test("never touches a forward whose destination is not an automobile_video socket", async () => {
    const ctx = makeSource({
      leaseOutput: "",
      forwardListOutput: `${DEVICE.deviceId} tcp:52003 localabstract:some_other_service\n`,
    });

    const startPromise = ctx.source.start();
    await tick();

    expect(ctx.commands).toContain("forward --list");
    expect(ctx.commands).not.toContain("forward --remove tcp:52003");

    ctx.processes[0].ready();
    await startPromise;
    await ctx.source.stop();
  });

  test("does not sweep a forward that is still backed by a live lease", async () => {
    const liveLease = JSON.stringify({
      version: 1,
      socketName: "automobile_video_live",
      sessionTokenHash: hashToken("live-session"),
      pid: 4321,
      ownerPid: 456,
      deviceSerial: DEVICE.deviceId,
      forwardPort: 52004,
      startedAtMs: 95_000,
      heartbeatAtMs: 100_000,
      heartbeatElapsedRealtimeMs: 95_000,
    });
    const ctx = makeSource({
      leaseOutput: liveLease,
      forwardListOutput: `${DEVICE.deviceId} tcp:52004 localabstract:automobile_video_live\n`,
    });

    const startPromise = ctx.source.start();
    await tick();

    expect(ctx.commands).not.toContain("forward --remove tcp:52004");

    ctx.processes[0].ready();
    await startPromise;
    await ctx.source.stop();
  });

  test("clears the session's socket claim on teardown so a later orphan can be swept", async () => {
    const registry = new InMemoryActiveVideoSessionRegistry();
    const ctx = makeSource({ activeVideoSessionRegistry: registry });

    await startReady(ctx);
    expect(registry.active(DEVICE.deviceId).has(SESSION_SOCKET)).toBe(true);

    await ctx.source.stop();
    expect(registry.active(DEVICE.deviceId).has(SESSION_SOCKET)).toBe(false);
  });

  test("refuses stale cleanup when the PID command line does not contain the lease socket name", async () => {
    const staleLease = JSON.stringify({
      version: 1,
      socketName: "automobile_video_stale",
      sessionTokenHash: hashToken("stale-session"),
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
      processCommandLine: `app_process\u0000/\u0000${VIDEO_SERVER_MAIN_CLASS}\u0000--socket-name\u0000automobile_video_other`,
    });

    const startPromise = ctx.source.start();
    await tick();

    expect(ctx.commands).toContain("forward --remove tcp:61234");
    expect(ctx.commands).not.toContain("shell kill -2 987");

    ctx.processes[0].ready();
    await startPromise;
    await ctx.source.stop();
  });

  test("refuses stale cleanup when the lease socket name is not the --socket-name value", async () => {
    const staleLease = JSON.stringify({
      version: 1,
      socketName: "automobile_video_stale",
      sessionTokenHash: hashToken("stale-session"),
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
      processCommandLine: `app_process\u0000/\u0000${VIDEO_SERVER_MAIN_CLASS}\u0000--socket-name\u0000automobile_video_other\u0000--quality\u0000automobile_video_stale`,
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
      sessionTokenHash: hashToken("fresh-session"),
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
      sessionTokenHash: hashToken("stale-session"),
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
      processCommandLine: `app_process\u0000/\u0000${VIDEO_SERVER_MAIN_CLASS}\u0000--socket-name\u0000automobile_video_stale`,
    });

    const startPromise = ctx.source.start();
    await tick();

    expect(ctx.commands).toContain("forward --remove tcp:61234");
    expect(ctx.commands).toContain("shell kill -2 987");
    expect(ctx.commands).toContain(
      `shell rm -f ${VIDEO_SERVER_LEASE_DIRECTORY}/automobile_video_stale.json`,
    );

    ctx.processes[0].ready();
    await startPromise;
    await ctx.source.stop();
  });

  test("reconciles a lease with valid wall clock but no elapsed-realtime via the wall-clock fallback", async () => {
    // heartbeatElapsedRealtimeMs absent (validator tolerates it). FakeTimer.now()
    // is 0, so heartbeatAtMs=-400_000 => 400s wall age >= 5min threshold => stale.
    const leaseNoElapsed = JSON.stringify({
      version: 1,
      socketName: "automobile_video_stale",
      sessionTokenHash: hashToken("stale-session"),
      pid: 987,
      ownerPid: 456,
      deviceSerial: DEVICE.deviceId,
      forwardPort: 61234,
      startedAtMs: -400_000,
      heartbeatAtMs: -400_000,
    });
    const ctx = makeSource({
      leaseOutput: leaseNoElapsed,
      forwardListOutput: `${DEVICE.deviceId} tcp:61234 localabstract:automobile_video_stale\n`,
      processCommandLine: `app_process\u0000/\u0000${VIDEO_SERVER_MAIN_CLASS}\u0000--socket-name\u0000automobile_video_stale`,
    });

    const startPromise = ctx.source.start();
    await tick();

    expect(ctx.commands).toContain("shell kill -2 987");
    expect(ctx.commands).toContain(
      `shell rm -f ${VIDEO_SERVER_LEASE_DIRECTORY}/automobile_video_stale.json`,
    );

    ctx.processes[0].ready();
    await startPromise;
    await ctx.source.stop();
  });

  test("does NOT reconcile a lease with no elapsed-realtime whose wall clock is recent", async () => {
    // heartbeatAtMs=-1_000 => 1s wall age (now()=0) << 5min threshold => keep.
    const freshNoElapsed = JSON.stringify({
      version: 1,
      socketName: "automobile_video_fresh",
      sessionTokenHash: hashToken("fresh-session"),
      pid: 987,
      ownerPid: 456,
      deviceSerial: DEVICE.deviceId,
      forwardPort: 61234,
      startedAtMs: -1_000,
      heartbeatAtMs: -1_000,
    });
    const ctx = makeSource({ leaseOutput: freshNoElapsed });

    const startPromise = ctx.source.start();
    await tick();

    expect(ctx.commands).not.toContain("shell kill -2 987");
    expect(ctx.commands).not.toContain("forward --remove tcp:61234");

    ctx.processes[0].ready();
    await startPromise;
    await ctx.source.stop();
  });

  test("reconciles a previous-boot lease written under a renumbered emulator serial", async () => {
    // Serial differs (emulator-5556 vs the device's emulator-5554), but a
    // negative elapsed age proves it predates the current boot => reclaim.
    const staleLeaseOldSerial = JSON.stringify({
      version: 1,
      socketName: "automobile_video_stale",
      sessionTokenHash: hashToken("stale-session"),
      pid: 987,
      ownerPid: 456,
      deviceSerial: "emulator-5556",
      forwardPort: 61234,
      startedAtMs: -40_000,
      heartbeatAtMs: -31_000,
      heartbeatElapsedRealtimeMs: 120_000,
    });
    const ctx = makeSource({
      leaseOutput: staleLeaseOldSerial,
      deviceUptimeMs: 5_000,
      forwardListOutput: `${DEVICE.deviceId} tcp:61234 localabstract:automobile_video_stale\n`,
      processCommandLine: `app_process\u0000/\u0000${VIDEO_SERVER_MAIN_CLASS}\u0000--socket-name\u0000automobile_video_stale`,
    });

    const startPromise = ctx.source.start();
    await tick();

    expect(ctx.commands).toContain("forward --remove tcp:61234");
    expect(ctx.commands).toContain("shell kill -2 987");
    expect(ctx.commands).toContain(
      `shell rm -f ${VIDEO_SERVER_LEASE_DIRECTORY}/automobile_video_stale.json`,
    );

    ctx.processes[0].ready();
    await startPromise;
    await ctx.source.stop();
  });

  test("does NOT reconcile a same-boot lease under a different serial", async () => {
    // Positive, fresh elapsed age (not previous-boot) + a different serial is
    // too ambiguous to reclaim.
    const freshOtherSerial = JSON.stringify({
      version: 1,
      socketName: "automobile_video_other",
      sessionTokenHash: hashToken("other-session"),
      pid: 987,
      ownerPid: 456,
      deviceSerial: "emulator-5556",
      forwardPort: 61234,
      startedAtMs: 95_000,
      heartbeatAtMs: 95_000,
      heartbeatElapsedRealtimeMs: 95_000,
    });
    const ctx = makeSource({ leaseOutput: freshOtherSerial, deviceUptimeMs: 100_000 });

    const startPromise = ctx.source.start();
    await tick();

    expect(ctx.commands).not.toContain("shell kill -2 987");

    ctx.processes[0].ready();
    await startPromise;
    await ctx.source.stop();
  });

  test("sweeps an unparseable *.json and an orphaned *.json.tmp older than the age threshold", async () => {
    // Directory has a corrupt .json (not a valid lease => not in known tokens)
    // and an orphaned .json.tmp. Device clock is 1_000_000s; both files are old.
    const oldMtime = 1_000_000 - 600; // 600s old >= 5min threshold
    const ctx = makeSource({
      leaseOutput: "not-json-at-all\n",
      leaseFileListing:
        `NOW 1000000\n` +
        `${oldMtime} ${VIDEO_SERVER_LEASE_DIRECTORY}/corrupt.json\n` +
        `${oldMtime} ${VIDEO_SERVER_LEASE_DIRECTORY}/leftover.json.tmp\n`,
    });

    const startPromise = ctx.source.start();
    await tick();

    expect(ctx.commands).toContain(`shell rm -f ${VIDEO_SERVER_LEASE_DIRECTORY}/corrupt.json`);
    expect(ctx.commands).toContain(`shell rm -f ${VIDEO_SERVER_LEASE_DIRECTORY}/leftover.json.tmp`);

    ctx.processes[0].ready();
    await startPromise;
    await ctx.source.stop();
  });

  test("leaves young unparseable/.tmp files and valid leases alone during the sweep", async () => {
    const youngMtime = 1_000_000 - 10; // 10s old << 5min threshold
    const validLease = JSON.stringify({
      version: 1,
      socketName: "automobile_video_fresh",
      sessionTokenHash: hashToken("fresh-session"),
      pid: 988,
      ownerPid: 456,
      deviceSerial: DEVICE.deviceId,
      forwardPort: 61235,
      startedAtMs: 95_000,
      heartbeatAtMs: 95_000,
      heartbeatElapsedRealtimeMs: 95_000,
    });
    const ctx = makeSource({
      leaseOutput: validLease,
      deviceUptimeMs: 100_000,
      leaseFileListing:
        `NOW 1000000\n` +
        `${youngMtime} ${VIDEO_SERVER_LEASE_DIRECTORY}/corrupt.json\n` +
        `${youngMtime} ${VIDEO_SERVER_LEASE_DIRECTORY}/leftover.json.tmp\n` +
        `990000 ${VIDEO_SERVER_LEASE_DIRECTORY}/automobile_video_fresh.json\n`,
    });

    const startPromise = ctx.source.start();
    await tick();

    expect(ctx.commands).not.toContain(`shell rm -f ${VIDEO_SERVER_LEASE_DIRECTORY}/corrupt.json`);
    expect(ctx.commands).not.toContain(
      `shell rm -f ${VIDEO_SERVER_LEASE_DIRECTORY}/leftover.json.tmp`,
    );
    // A valid, current lease file is never swept even though its mtime is old.
    expect(ctx.commands).not.toContain(
      `shell rm -f ${VIDEO_SERVER_LEASE_DIRECTORY}/automobile_video_fresh.json`,
    );

    ctx.processes[0].ready();
    await startPromise;
    await ctx.source.stop();
  });

  test("uses separate socket leases for separate device sources", async () => {
    // Socket name is now decoupled from the token (issue #4729), so each source is
    // given its own opaque name explicitly rather than deriving it from the token.
    const first = makeSource({
      sessionTokenFactory: () => "first-session",
      socketNameFactory: () => `${VIDEO_SERVER_SOCKET_PREFIX}_firstsession`,
    });
    const second = makeSource({
      sessionTokenFactory: () => "second-session",
      socketNameFactory: () => `${VIDEO_SERVER_SOCKET_PREFIX}_secondsession`,
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

  describe("bounded ADB/socket timeouts", () => {
    const COMMAND_TIMEOUT_MS = 20_000;
    const TEARDOWN_TIMEOUT_MS = 5_000;

    // Let the pending withTimeout promise register its FakeTimer setTimeout
    // before advancing fake time, so the deadline actually fires.
    async function fireTimeout(ctx: ReturnType<typeof makeSource>, ms: number): Promise<void> {
      await tick();
      ctx.timer.advanceTime(ms);
      await tick();
    }

    async function expectStartRejects(overrides: Record<string, unknown>): Promise<Error> {
      const ctx = makeSource(overrides);
      const startPromise = ctx.source.start();
      const settled = startPromise.then(
        () => null,
        (error) => error as Error,
      );
      await fireTimeout(ctx, COMMAND_TIMEOUT_MS);
      const error = await settled;
      expect(error).toBeInstanceOf(Error);
      // The source tore itself down so the factory can fall back to screenrecord.
      expect(ctx.source.isRunning).toBe(false);
      return error as Error;
    }

    test("a hung adb push makes start() reject within the launch timeout", async () => {
      const error = await expectStartRejects({ hangCommands: ['push "'] });
      expect(error.message).toContain("adb push video-server jar");
    });

    test("a hung adb forward makes start() reject within the launch timeout", async () => {
      const error = await expectStartRejects({ forwardResult: new Promise(() => {}) });
      expect(error.message).toContain("adb forward video-server socket");
    });

    test("a hung adb spawn makes start() reject within the launch timeout", async () => {
      const error = await expectStartRejects({ spawnHang: true });
      expect(error.message).toContain("adb spawn video-server");
    });

    test("a hung initial socket connect makes start() reject within the launch timeout", async () => {
      const ctx = makeSource({ connector: (() => new Promise(() => {})) as SocketConnector });
      const startPromise = ctx.source.start();
      const settled = startPromise.then(
        () => null,
        (error) => error as Error,
      );
      await tick(); // push + spawn
      ctx.processes[0].ready();
      await tick(); // ready resolves, forward + connect begins (and hangs)
      ctx.timer.advanceTime(COMMAND_TIMEOUT_MS);
      await tick();
      const error = await settled;
      expect(error).toBeInstanceOf(Error);
      expect(ctx.source.isRunning).toBe(false);
    });

    test("a hung teardown command still lets stop() resolve within the timeout", async () => {
      // readLease's `shell cat <lease>.json` is only hit during cleanup, so it
      // hangs teardown without affecting the successful start.
      const ctx = makeSource({
        hangCommands: [`shell cat ${VIDEO_SERVER_LEASE_DIRECTORY}/${SESSION_SOCKET}.json`],
      });
      await startReady(ctx);

      const stopPromise = ctx.source.stop();
      const settled = stopPromise.then(
        () => "resolved",
        () => "rejected",
      );
      await fireTimeout(ctx, TEARDOWN_TIMEOUT_MS);
      expect(await settled).toBe("resolved");
      // stop() always winds the source down even when cleanup could not complete.
      expect(ctx.source.isRunning).toBe(false);
    });

    test("rejects construction with a non-positive command timeout", () => {
      expect(() => makeSource({ commandTimeoutMs: 0 })).toThrow();
      expect(() => makeSource({ teardownTimeoutMs: -1 })).toThrow();
    });
  });

  describe("token handshake and opaque socket name (issue #4729)", () => {
    test("names the abstract socket opaquely, decoupled from the session token", async () => {
      const OPAQUE = `${VIDEO_SERVER_SOCKET_PREFIX}_deadbeefcafef00d`;
      const ctx = makeSource({
        sessionTokenFactory: () => "secret-token-1234",
        socketNameFactory: () => OPAQUE,
      });
      const startPromise = ctx.source.start();
      await tick();
      ctx.processes[0].ready("secret-token-1234", OPAQUE);
      await tick();
      await startPromise;

      expect(ctx.sessionSocket()).toBe(OPAQUE);
      expect(ctx.commands).toContain(`forward tcp:0 localabstract:${OPAQUE}`);
      const args = ctx.spawnArgs[0].join(" ");
      expect(args).toContain(`--socket-name ${OPAQUE}`);
      expect(args).toContain("--session-token secret-token-1234");
      // The /proc/net/unix disclosure fix: the socket name must not embed the token.
      expect(ctx.sessionSocket()).not.toContain("secret-token-1234");

      await ctx.source.stop();
    });

    test("sends the token handshake as the first bytes on connect", async () => {
      const ctx = makeSource();
      await startReady(ctx);

      // The handshake is written on connect, before any stream header is read.
      expect(ctx.sockets[0].written).toEqual([handshakeFrame()]);

      await ctx.source.stop();
    });

    test("skips the handshake and still streams when the device advertises no proto", async () => {
      const ctx = makeSource();
      const startPromise = ctx.source.start();
      await tick();
      // A pre-handshake device omits `proto=` on its readiness line.
      ctx.processes[0].ready(SESSION_TOKEN, SESSION_SOCKET, 1234, null);
      await tick();
      await startPromise;

      expect(ctx.sockets[0].written).toEqual([]);
      // Streaming still works (graceful degrade; UID gating remains the barrier).
      ctx.sockets[0].feed(streamHeader(480, 1040));
      ctx.sockets[0].feed(framedPacket(Buffer.from([0x09])));
      expect(ctx.chunks).toEqual([Buffer.from([0x09])]);

      await ctx.source.stop();
    });
  });
});
