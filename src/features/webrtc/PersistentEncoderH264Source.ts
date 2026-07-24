import { randomUUID } from "node:crypto";
import { connect as netConnect } from "node:net";
import { ActionableError, type BootedDevice } from "../../models";
import { logger } from "../../utils/logger";
import { defaultTimer, type Timer } from "../../utils/SystemTimer";
import {
  defaultAdbClientFactory,
  type AdbClientFactory,
} from "../../utils/android-cmdline-tools/AdbClientFactory";
import type { AdbProcess } from "../../utils/android-cmdline-tools/interfaces/AdbExecutor";
import type { H264CaptureSource, H264CaptureSourceTelemetry } from "./H264CaptureSource";
import {
  VIDEO_SERVER_CODEC_ID_H264,
  VIDEO_SERVER_CODEC_ID_PCM16,
  type VideoServerPacket,
  type VideoServerStreamHeader,
  VideoServerStreamParser,
} from "./VideoServerStreamParser";

/** Remote path the DEX jar is pushed to before launch. */
export const VIDEO_SERVER_REMOTE_JAR_PATH = "/data/local/tmp/automobile-video.jar";
/** Prefix for host-owned per-session LocalSocket names. */
export const VIDEO_SERVER_SOCKET_PREFIX = "automobile_video";
const VIDEO_SERVER_MAIN_CLASS = "dev.jasonpearson.automobile.video.VideoServer";
/** Device-side directory containing JSON lease files for owned capture sessions. */
export const VIDEO_SERVER_LEASE_DIRECTORY = "/data/local/tmp/automobile-video-sessions";
/** A device heartbeat older than this is eligible for owned stale cleanup. */
const STALE_LEASE_MS = 30_000;
/** Server stdout line that carries its validated app_process PID and token. */
const SESSION_READY_MARKER = "VIDEO_SESSION_READY";
/** Server stdout line printed after capture has fully started. */
const STREAMING_STARTED_MARKER = "Streaming started";

/**
 * Host→device command byte written back over the (bidirectional) socket to ask
 * the encoder for a fresh IDR. Keep in sync with
 * `VideoStreamProtocol.COMMAND_REQUEST_KEY_FRAME` in the Kotlin video-server.
 */
export const VIDEO_SERVER_COMMAND_REQUEST_KEY_FRAME = 0x01;
/** Retry a replaced local ADB socket without tearing down the device encoder. */
export const DEFAULT_LOCAL_SOCKET_RECONNECT_WINDOW_MS = 5_000;
export const DEFAULT_LOCAL_SOCKET_RECONNECT_RETRY_MS = 100;

/** Minimal socket surface the source needs, for injectable testing. */
export interface StreamSocket {
  on(event: "data", listener: (chunk: Buffer) => void): void;
  on(event: "error", listener: (error: Error) => void): void;
  on(event: "close", listener: () => void): void;
  /** Send bytes device-ward (e.g. a keyframe-request command). */
  write(chunk: Buffer): void;
  destroy(): void;
}

/** Connects to a forwarded local TCP port and resolves once connected. */
export type SocketConnector = (port: number, signal?: AbortSignal) => Promise<StreamSocket>;

export interface VideoServerSession {
  token: string;
  socketName: string;
  ownerPid: number;
  deviceSerial: string;
}

interface RawVideoServerLease {
  socketName: string;
  sessionToken: string;
  ownerPid: number;
  deviceSerial: string;
  pid: number;
  forwardPort: number;
  startedAtMs: number;
  heartbeatAtMs: number;
  heartbeatElapsedRealtimeMs?: number;
}

interface VideoServerLease extends VideoServerSession, Omit<RawVideoServerLease, "sessionToken"> {}

const defaultConnector: SocketConnector = (port, signal) =>
  new Promise<StreamSocket>((resolve, reject) => {
    const socket = netConnect(port, "127.0.0.1");
    let settled = false;
    const finish = (fn: () => void): void => {
      if (settled) {
        return;
      }
      settled = true;
      socket.off("connect", onConnect);
      socket.off("error", onError);
      signal?.removeEventListener("abort", onAbort);
      fn();
    };
    const onConnect = (): void => finish(() => resolve(socket));
    const onError = (error: Error): void => finish(() => reject(error));
    const onAbort = (): void =>
      finish(() => {
        socket.destroy();
        reject(new Error("video-server socket connection aborted"));
      });

    socket.once("connect", onConnect);
    socket.once("error", onError);
    if (signal?.aborted) {
      onAbort();
      return;
    }
    signal?.addEventListener("abort", onAbort, { once: true });
  });

export interface PersistentEncoderH264SourceOptions {
  device: BootedDevice;
  /** Called with each chunk of the raw H.264 (Annex-B) elementary stream. */
  onData: (chunk: Buffer) => void;
  /** Called with each chunk of 8 kHz mono PCM16LE audio when enabled. */
  onAudioData?: (chunk: Buffer) => void;
  /** Called when the source fails fatally after a successful start. */
  onError?: (error: Error) => void;
  bitrateBps?: number;
  size?: { width: number; height: number };
  audioEnabled?: boolean;
  quality?: "low" | "medium" | "high";
  /** Local path to the built `automobile-video.jar`. Required to run. */
  jarPath: string;
  adbFactory?: AdbClientFactory;
  connector?: SocketConnector;
  timer?: Timer;
  /** How long to wait for the server to signal readiness (ms). */
  readyTimeoutMs?: number;
  /** Bounded time to reconnect a dropped local socket before failing the source. */
  localSocketReconnectWindowMs?: number;
  /** Spacing between local socket reconnect attempts. */
  localSocketReconnectRetryMs?: number;
  /** Injectable session token source for deterministic tests. */
  sessionTokenFactory?: () => string;
}

const DEFAULT_READY_TIMEOUT_MS = 10_000;

function socketNameForToken(token: string): string {
  return `${VIDEO_SERVER_SOCKET_PREFIX}_${token.replaceAll("-", "")}`;
}

function isSafeSessionToken(value: string): boolean {
  return /^[A-Za-z0-9-]{8,80}$/.test(value);
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isVideoServerLease(value: unknown): value is RawVideoServerLease {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const lease = value as Record<string, unknown>;
  if (typeof lease.sessionToken !== "string" || !isSafeSessionToken(lease.sessionToken)) {return false;}
  if (typeof lease.socketName !== "string" || typeof lease.deviceSerial !== "string") {return false;}
  if (!isPositiveInteger(lease.ownerPid) || !isPositiveInteger(lease.pid)) {return false;}
  if (!isPositiveInteger(lease.forwardPort)) {return false;}
  if (!isFiniteNumber(lease.startedAtMs) || !isFiniteNumber(lease.heartbeatAtMs)) {
    return false;
  }
  return (
    lease.heartbeatElapsedRealtimeMs === undefined ||
    (isFiniteNumber(lease.heartbeatElapsedRealtimeMs) && lease.heartbeatElapsedRealtimeMs >= 0)
  );
}

function parseLeases(output: string): VideoServerLease[] {
  return output
    .split(/\r?\n/)
    .flatMap(line => {
      try {
        const parsed: unknown = JSON.parse(line);
        if (!isVideoServerLease(parsed)) {
          return [];
        }
        return [
          {
            ...parsed,
            token: parsed.sessionToken,
          },
        ];
      } catch (error) {
        logger.debug(`[PersistentEncoderH264Source] ignoring malformed video session lease: ${error}`);
        return [];
      }
    });
}

/**
 * Produces a continuous H.264 Annex-B elementary stream from a persistent
 * on-device MediaCodec encoder (the `android/video-server` DEX run via
 * `app_process`), instead of a time-limited `screenrecord`. Because the encoder
 * is long-lived there is no ~175s segment-rotation boundary and no per-rotation
 * SPS/PPS + IDR re-emission — a single continuous timestamp base.
 *
 * Lifecycle: push the jar, launch the server, wait for its readiness line,
 * `adb forward` an ephemeral local port to the server's abstract LocalSocket,
 * connect, and parse the binary framing into Annex-B payloads. Fully injectable
 * (ADB factory, socket connector, timer) for device-free unit tests.
 */
export class PersistentEncoderH264Source implements H264CaptureSource {
  private readonly options: PersistentEncoderH264SourceOptions;
  private readonly adbFactory: AdbClientFactory;
  private readonly connector: SocketConnector;
  private readonly timer: Timer;
  private readonly readyTimeoutMs: number;
  private readonly localSocketReconnectWindowMs: number;
  private readonly localSocketReconnectRetryMs: number;
  private readonly sessionTokenFactory: () => string;

  private server: AdbProcess | null = null;
  private socket: StreamSocket | null = null;
  private forwardedPort: number | null = null;
  private session: VideoServerSession | null = null;
  private deviceProcessId: number | null = null;
  private running = false;
  private teardownPromise: Promise<void> | null = null;
  private resolveStartupAudioHeader: ((header: VideoServerStreamHeader) => void) | undefined;
  private resolveStartupAudioPacket: ((packet: VideoServerPacket) => void) | undefined;
  private socketReconnectPromise: Promise<void> | null = null;
  private socketReconnectAbortController: AbortController | null = null;
  private telemetryInitialized = false;
  private lastEncodedFrameTimestampUs: number | null = null;
  private lastIdrTimestampUs: number | null = null;
  private idrRequestCount = 0;
  private idrCompletionCount = 0;
  private pendingIdrRequests = 0;
  private encodedAccessUnitCount = 0;
  private serverOutputObserver: ((chunk: Buffer) => void) | null = null;
  private serverOutputBuffer = "";
  private sawStreamingStarted = false;

  constructor(options: PersistentEncoderH264SourceOptions) {
    this.options = options;
    this.adbFactory = options.adbFactory ?? defaultAdbClientFactory;
    this.connector = options.connector ?? defaultConnector;
    this.timer = options.timer ?? defaultTimer;
    this.readyTimeoutMs = options.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS;
    this.localSocketReconnectWindowMs =
      options.localSocketReconnectWindowMs ?? DEFAULT_LOCAL_SOCKET_RECONNECT_WINDOW_MS;
    this.localSocketReconnectRetryMs =
      options.localSocketReconnectRetryMs ?? DEFAULT_LOCAL_SOCKET_RECONNECT_RETRY_MS;
    if (this.localSocketReconnectWindowMs <= 0 || this.localSocketReconnectRetryMs <= 0) {
      throw new ActionableError("Local socket reconnect timings must be positive milliseconds.");
    }
    this.sessionTokenFactory = options.sessionTokenFactory ?? randomUUID;
  }

  get isRunning(): boolean {
    return this.running;
  }

  getTelemetry(): H264CaptureSourceTelemetry {
    if (!this.telemetryInitialized) {
      return {
        lastEncodedFrameTimestampUs: null,
        lastIdrTimestampUs: null,
        idrRequestCount: null,
        idrCompletionCount: null,
        encodedAccessUnitCount: null,
      };
    }
    return {
      lastEncodedFrameTimestampUs: this.lastEncodedFrameTimestampUs,
      lastIdrTimestampUs: this.lastIdrTimestampUs,
      idrRequestCount: this.idrRequestCount,
      idrCompletionCount: this.idrCompletionCount,
      encodedAccessUnitCount: this.encodedAccessUnitCount,
    };
  }

  async start(): Promise<void> {
    if (this.running) {
      throw new ActionableError("Persistent encoder H.264 source already started.");
    }
    this.running = true;
    try {
      await this.launch();
    } catch (error) {
      // Startup failed before we produced anything: tear down and rethrow so the
      // caller (source factory) can fall back to screenrecord.
      this.running = false;
      await this.beginTeardown();
      throw error;
    }
  }

  async stop(): Promise<void> {
    if (!this.running) {
      await this.teardownPromise;
      return;
    }
    this.running = false;
    await this.beginTeardown();
  }

  /**
   * Ask the on-device encoder to emit a fresh IDR by sending the request-keyframe
   * command over the socket. The encoder (MediaCodec) honors it via
   * PARAMETER_KEY_REQUEST_SYNC_FRAME, so a late/recovering WHEP viewer decodes
   * without waiting for the periodic two-second I-frame interval. The publisher
   * throttles calls.
   */
  requestKeyFrame(): void {
    const socket = this.socket;
    if (!this.running || !socket) {
      return;
    }
    this.telemetryInitialized = true;
    this.idrRequestCount++;
    this.pendingIdrRequests++;
    try {
      socket.write(Buffer.from([VIDEO_SERVER_COMMAND_REQUEST_KEY_FRAME]));
    } catch (error) {
      this.pendingIdrRequests--;
      // Best-effort: a dropped socket surfaces via its own error/close handler.
      logger.debug(`[PersistentEncoderH264Source] keyframe request write failed: ${error}`);
    }
  }

  private async launch(): Promise<void> {
    const adb = this.adbFactory.create(this.options.device);
    const port = await this.prepareSession(adb);
    if (port === null) {
      return;
    }
    const server = await this.spawnAndWaitForServer(adb);
    if (!server) {
      return;
    }
    await this.connectToServer(server, port);
  }

  private async prepareSession(adb: ReturnType<AdbClientFactory["create"]>): Promise<number | null> {
    if (!this.running) {return null;}
    const session = this.createSession();
    this.session = session;
    this.deviceProcessId = null;
    await this.reconcileExpiredLeases(adb);
    if (!this.running) {return null;}
    await adb.executeCommand(`push "${this.options.jarPath}" ${VIDEO_SERVER_REMOTE_JAR_PATH}`);
    if (!this.running) {return null;}
    const forward = await adb.executeCommand(
      `forward tcp:0 localabstract:${session.socketName}`
    );
    const port = Number.parseInt(forward.stdout.trim(), 10);
    if (!Number.isInteger(port) || port <= 0) {
      throw new ActionableError(`adb forward returned an invalid port: "${forward.stdout.trim()}"`);
    }
    this.forwardedPort = port;
    return port;
  }

  private async spawnAndWaitForServer(
    adb: ReturnType<AdbClientFactory["create"]>
  ): Promise<AdbProcess | null> {
    const server = await adb.spawn(this.buildServerArgs());
    if (!this.running) {
      server.kill("SIGINT");
      return null;
    }
    this.server = server;
    this.attachServerOutputObserver(server);
    server.stderr.on("data", (chunk: Buffer) => {
      const text = chunk.toString().trim();
      if (text) {
        logger.debug(`[PersistentEncoderH264Source] server stderr: ${text}`);
      }
    });

    this.deviceProcessId = await this.waitForReady(server);
    return this.running ? server : null;
  }

  private async connectToServer(server: AdbProcess, port: number): Promise<void> {
    const streamingStarted = this.options.audioEnabled
      ? this.waitForStreamingStarted(server)
      : null;
    // The waiter is installed before connecting so a fast server cannot print
    // the marker in the gap between client connect and the later startup await.
    streamingStarted?.catch(() => {});

    const socket = await this.connector(port);
    if (!this.running) {
      socket.destroy();
      return;
    }
    this.socket = socket;
    const startupAudioReady = this.options.audioEnabled
      ? this.waitForStartupAudioReady()
      : null;
    let socketFailureMode: "startup" | "post-start" = this.options.audioEnabled
      ? "startup"
      : "post-start";
    let rejectStartupSocketFailure: ((error: Error) => void) | undefined;
    const startupSocketFailure = this.options.audioEnabled
      ? new Promise<never>((_, reject) => {
        rejectStartupSocketFailure = reject;
      })
      : null;
    this.wireSocket(socket, error => {
      if (socketFailureMode === "startup") {
        rejectStartupSocketFailure?.(error);
        return;
      }
      this.reconnectSocket(socket, error);
    }, header => this.resolveStartupAudioHeader?.(header));

    // For audio-enabled streams, REMOTE_SUBMIX initialization happens after the
    // socket client connects. Do not resolve start() until that succeeds, or an
    // unavailable audio source would look like a successful start followed by a
    // reconnect-looping post-start failure.
    if (this.options.audioEnabled) {
      await Promise.race([
        Promise.all([streamingStarted, startupAudioReady]),
        startupSocketFailure,
      ]);
      if (!this.running) {
        return;
      }
    }
    socketFailureMode = "post-start";
    this.watchServer(server);
  }

  private watchServer(server: AdbProcess): void {
    server.once("exit", (code, signal) => {
      if (this.server !== server) {return;}
      this.detachServerOutputObserver(server);
      this.server = null;
      this.failIfRunning(new Error(`video-server exited (code=${code}, signal=${signal})`));
    });
    server.once("error", (error: Error) => this.failIfRunning(error));
  }

  private buildServerArgs(): string[] {
    const session = this.session;
    if (!session || this.forwardedPort === null) {
      throw new Error("Video server session was not initialized.");
    }
    const args = [
      "shell",
      `CLASSPATH=${VIDEO_SERVER_REMOTE_JAR_PATH}`,
      "app_process",
      "/",
      VIDEO_SERVER_MAIN_CLASS,
      "--quality",
      this.options.quality ?? "medium",
      "--socket-name",
      session.socketName,
      "--session-token",
      session.token,
      "--owner-pid",
      String(session.ownerPid),
      "--device-serial",
      session.deviceSerial,
      "--forward-port",
      String(this.forwardedPort),
    ];
    if (this.options.bitrateBps && this.options.bitrateBps > 0) {
      args.push("--bit-rate", String(Math.round(this.options.bitrateBps)));
    }
    if (this.options.size) {
      args.push("--size", `${this.options.size.width}x${this.options.size.height}`);
    }
    if (this.options.audioEnabled) {
      args.push("--audio");
    }
    return args;
  }

  private createSession(): VideoServerSession {
    const token = this.sessionTokenFactory();
    if (!isSafeSessionToken(token)) {
      throw new Error("Video server session token factory returned an unsafe token.");
    }
    return {
      token,
      socketName: socketNameForToken(token),
      ownerPid: process.pid,
      deviceSerial: this.options.device.deviceId,
    };
  }

  private waitForReady(server: AdbProcess): Promise<number> {
    const token = this.session?.token;
    if (!token) {
      throw new Error("Video server session token was unavailable.");
    }
    return new Promise<number>((resolve, reject) => {
      let settled = false;
      let stdoutBuffer = "";
      const finish = (fn: () => void): void => {
        if (settled) {
          return;
        }
        settled = true;
        this.timer.clearTimeout(timeout);
        server.stdout.off("data", onData);
        server.removeListener("exit", onExit);
        server.removeListener("error", onError);
        fn();
      };
      const timeout = this.timer.setTimeout(() => {
        finish(() =>
          reject(
            new ActionableError(
              `video-server did not become session-ready within ${this.readyTimeoutMs}ms. ` +
              "Set AUTOMOBILE_VIDEO_SERVER_JAR to a current automobile-video.jar."
            )
          )
        );
      }, this.readyTimeoutMs);
      const onData = (chunk: Buffer): void => {
        if (settled) {
          return;
        }
        stdoutBuffer += chunk.toString();
        for (const line of stdoutBuffer.split(/\r?\n/)) {
          const match = new RegExp(`^${SESSION_READY_MARKER} token=([^ ]+) pid=(\\d+) socket=([^ ]+)$`).exec(line);
          if (!match) {
            continue;
          }
          if (match[1] !== token || match[3] !== this.session?.socketName) {
            finish(() =>
              reject(
                new ActionableError(
                  `video-server session readiness token mismatch (expected=${token}, got=${match[1]})`
                )
              )
            );
            return;
          }
          const pid = Number.parseInt(match[2], 10);
          if (!Number.isInteger(pid) || pid <= 0) {
            finish(() => reject(new ActionableError("video-server returned an invalid session PID")));
            return;
          }
          finish(() => resolve(pid));
          return;
        }
      };
      const onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
        finish(() => reject(new Error(`video-server exited before ready (code=${code}, signal=${signal})`)));
      };
      const onError = (error: Error): void => finish(() => reject(error));

      server.stdout.on("data", onData);
      server.once("exit", onExit);
      server.once("error", onError);
    });
  }

  private waitForStreamingStarted(server: AdbProcess): Promise<void> {
    if (this.sawStreamingStarted) {
      return Promise.resolve();
    }
    return this.waitForServerLine(
      server,
      STREAMING_STARTED_MARKER,
      `video-server did not start streaming within ${this.readyTimeoutMs}ms`,
      "video-server exited before streaming started"
    );
  }

  private waitForStartupAudioReady(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      let muxAudioHeaderSeen = false;
      const timeout = this.timer.setTimeout(() => {
        finish(() =>
          reject(
            new ActionableError(
              `video-server did not produce PCM audio within ${this.readyTimeoutMs}ms`
            )
          )
        );
      }, this.readyTimeoutMs);

      const finish = (fn: () => void): void => {
        if (settled) {
          return;
        }
        settled = true;
        this.timer.clearTimeout(timeout);
        this.resolveStartupAudioHeader = undefined;
        this.resolveStartupAudioPacket = undefined;
        fn();
      };

      this.resolveStartupAudioHeader = header => {
        if (header.muxed === true && header.audio === true) {
          muxAudioHeaderSeen = true;
          return;
        }
        finish(() => {
          reject(
            new ActionableError(
              "Audio was requested, but video-server did not advertise muxed PCM audio. Rebuild or provide a current automobile-video.jar."
            )
          );
        });
      };

      this.resolveStartupAudioPacket = packet => {
        if (
          muxAudioHeaderSeen &&
          packet.codecId === VIDEO_SERVER_CODEC_ID_PCM16 &&
          packet.data.length > 0
        ) {
          finish(resolve);
        }
      };
    });
  }

  private waitForServerLine(
    server: AdbProcess,
    marker: string,
    timeoutMessage: string,
    exitMessagePrefix: string
  ): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      let stdoutBuffer = "";
      const finish = (fn: () => void): void => {
        if (settled) {
          return;
        }
        settled = true;
        this.timer.clearTimeout(timeout);
        server.stdout.off("data", onData);
        server.removeListener("exit", onExit);
        server.removeListener("error", onError);
        fn();
      };
      const timeout = this.timer.setTimeout(() => {
        finish(() => reject(new ActionableError(timeoutMessage)));
      }, this.readyTimeoutMs);

      const onData = (chunk: Buffer): void => {
        if (settled) {
          return; // stop accumulating once ready (or failed)
        }
        stdoutBuffer += chunk.toString();
        if (stdoutBuffer.includes(marker)) {
          finish(resolve);
        }
      };
      const onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
        finish(() =>
          reject(new Error(`${exitMessagePrefix} (code=${code}, signal=${signal})`))
        );
      };
      const onError = (error: Error): void => finish(() => reject(error));

      server.stdout.on("data", onData);
      server.once("exit", onExit);
      server.once("error", onError);
    });
  }

  private wireSocket(
    socket: StreamSocket,
    onSocketFailure: (error: Error) => void,
    onStreamHeader?: (header: VideoServerStreamHeader) => void
  ): void {
    const parser = new VideoServerStreamParser({
      onHeader: header => {
        onStreamHeader?.(header);
        // Every local client attach, including a replacement socket, triggers a
        // fresh encoder request. The video-server has already replayed cached
        // SPS/PPS + IDR; this makes the next frame current without a GOP wait.
        this.requestKeyFrame();
        logger.info(
          `[PersistentEncoderH264Source] stream ${header.width}x${header.height} codec=0x${header.codecId.toString(16)}`
        );
      },
      onPacket: packet => {
        if (this.socket === socket) {
          if (packet.codecId === VIDEO_SERVER_CODEC_ID_H264) {
            this.observeVideoPacket(packet);
            this.options.onData(packet.data);
          } else if (packet.codecId === VIDEO_SERVER_CODEC_ID_PCM16) {
            this.options.onAudioData?.(packet.data);
            this.resolveStartupAudioPacket?.(packet);
          }
        }
      },
    });
    socket.on("data", chunk => parser.push(chunk));
    let failed = false;
    const reportFailure = (error: Error): void => {
      if (failed || this.socket !== socket) {
        return;
      }
      failed = true;
      onSocketFailure(error);
    };
    socket.on("error", reportFailure);
    socket.on("close", () => reportFailure(new Error("video-server socket closed")));
  }

  private observeVideoPacket(packet: VideoServerPacket): void {
    if (packet.config) {
      return;
    }
    this.telemetryInitialized = true;
    if (packet.replayed) {
      // The cached IDR makes the replacement client decodable, but it was emitted
      // before this request. Preserve its timestamp only when no live observation
      // exists; it cannot complete a pending encoder IDR request or increment the
      // newly encoded access-unit counter.
      this.lastEncodedFrameTimestampUs ??= packet.ptsUs;
      if (packet.keyFrame) {
        this.lastIdrTimestampUs ??= packet.ptsUs;
      }
      return;
    }
    this.lastEncodedFrameTimestampUs = packet.ptsUs;
    this.encodedAccessUnitCount++;
    if (!packet.keyFrame) {
      return;
    }
    this.lastIdrTimestampUs = packet.ptsUs;
    if (this.pendingIdrRequests > 0) {
      this.pendingIdrRequests--;
      this.idrCompletionCount++;
    }
  }

  private reconnectSocket(failedSocket: StreamSocket, error: Error): void {
    if (
      !this.running ||
      this.socket !== failedSocket ||
      this.socketReconnectPromise !== null
    ) {
      return;
    }
    this.socket = null;
    failedSocket.destroy();
    const controller = new AbortController();
    this.socketReconnectAbortController = controller;
    this.socketReconnectPromise = this.tryReconnectSocket(error, controller.signal).finally(() => {
      if (this.socketReconnectAbortController === controller) {
        this.socketReconnectAbortController = null;
      }
      this.socketReconnectPromise = null;
    });
  }

  private async tryReconnectSocket(initialError: Error, signal: AbortSignal): Promise<void> {
    const port = this.forwardedPort;
    if (port === null) {
      this.failIfRunning(initialError);
      return;
    }

    const deadline = this.timer.now() + this.localSocketReconnectWindowMs;
    let lastError = initialError;
    while (this.running && this.server !== null && !signal.aborted) {
      try {
        const socket = await this.connectBeforeDeadline(port, deadline, signal);
        if (!this.running || this.server === null || signal.aborted) {
          socket.destroy();
          return;
        }
        this.socket = socket;
        this.wireSocket(socket, error => this.reconnectSocket(socket, error));
        logger.info("[PersistentEncoderH264Source] reconnected to retained video-server socket");
        return;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
      }

      const remainingMs = deadline - this.timer.now();
      if (remainingMs <= 0) {
        break;
      }
      await this.waitForReconnectRetry(Math.min(this.localSocketReconnectRetryMs, remainingMs), signal);
    }

    if (signal.aborted) {
      return;
    }
    this.failIfRunning(
      new Error(
        `video-server socket did not reconnect within ${this.localSocketReconnectWindowMs}ms: ${lastError.message}`
      )
    );
  }

  private waitForReconnectRetry(ms: number, signal: AbortSignal): Promise<void> {
    if (signal.aborted) {
      return Promise.resolve();
    }

    return new Promise(resolve => {
      let finished = false;
      const finish = (): void => {
        if (finished) {
          return;
        }
        finished = true;
        this.timer.clearTimeout(timeout);
        signal.removeEventListener("abort", finish);
        resolve();
      };

      const timeout = this.timer.setTimeout(finish, ms);
      signal.addEventListener("abort", finish, { once: true });
    });
  }

  private async connectBeforeDeadline(
    port: number,
    deadline: number,
    reconnectSignal: AbortSignal
  ): Promise<StreamSocket> {
    const remainingMs = deadline - this.timer.now();
    if (remainingMs <= 0) {
      throw new Error("video-server socket reconnect deadline elapsed");
    }

    const controller = new AbortController();
    let timedOut = false;
    const abortForTeardown = (): void => controller.abort();
    if (reconnectSignal.aborted) {
      abortForTeardown();
    } else {
      reconnectSignal.addEventListener("abort", abortForTeardown, { once: true });
    }
    const connection = this.connector(port, controller.signal);
    const timeout = this.timer.setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, remainingMs);
    const timeoutFailure = new Promise<never>((_, reject) => {
      const rejectOnAbort = (): void =>
        reject(
          new Error(
            timedOut
              ? "video-server socket reconnect attempt timed out"
              : "video-server socket reconnect attempt aborted"
          )
        );
      if (controller.signal.aborted) {
        rejectOnAbort();
      } else {
        controller.signal.addEventListener("abort", rejectOnAbort, { once: true });
      }
    });

    try {
      return await Promise.race([connection, timeoutFailure]);
    } finally {
      this.timer.clearTimeout(timeout);
      reconnectSignal.removeEventListener("abort", abortForTeardown);
      if (controller.signal.aborted) {
        // A connector that ignored cancellation may still resolve. Do not leave
        // that late local socket open after either deadline or source teardown.
        void connection.then(socket => socket.destroy(), () => {});
      }
    }
  }

  /** Surface a post-start fatal failure exactly once and stop feeding data. */
  private failIfRunning(error: Error): void {
    if (!this.running) {
      return;
    }
    this.running = false;
    void this.beginTeardown();
    this.options.onError?.(error);
  }

  private beginTeardown(): Promise<void> {
    this.teardownPromise ??= this.teardown().finally(() => {
      this.teardownPromise = null;
    });
    return this.teardownPromise;
  }

  private async teardown(): Promise<void> {
    const reconnectAbortController = this.socketReconnectAbortController;
    this.socketReconnectAbortController = null;
    reconnectAbortController?.abort();

    const socket = this.socket;
    this.socket = null;
    socket?.destroy();

    const server = this.server;
    this.server = null;
    if (server) {
      this.detachServerOutputObserver(server);
    }
    // Terminating the host `adb shell` process closes the exec stream, which
    // stops the device-side server for THIS session. We deliberately do NOT run
    // a device-wide `pkill` (unlike the file-recording backend): it would also
    // kill a concurrent `videoRecording` on the same device.
    server?.kill("SIGINT");

    const session = this.session;
    const port = this.forwardedPort;
    const deviceProcessId = this.deviceProcessId;
    this.forwardedPort = null;
    this.deviceProcessId = null;
    this.session = null;
    if (session) {
      await this.cleanupOwnedSession(session, port, deviceProcessId);
    } else if (port !== null) {
      await this.removeForward(port);
    }
  }

  private async reconcileExpiredLeases(adb: ReturnType<AdbClientFactory["create"]>): Promise<void> {
    let leases: VideoServerLease[];
    try {
      const result = await adb.executeCommand(`shell cat ${VIDEO_SERVER_LEASE_DIRECTORY}/*.json`);
      leases = parseLeases(result.stdout);
    } catch (error) {
      logger.debug(`[PersistentEncoderH264Source] unable to read video session leases: ${error}`);
      return;
    }

    if (leases.length === 0) {
      return;
    }
    const deviceElapsedRealtimeMs = await this.readDeviceElapsedRealtimeMs(adb);
    if (deviceElapsedRealtimeMs === null) {
      logger.warn("[PersistentEncoderH264Source] unable to read device uptime; skipping stale-session cleanup");
      return;
    }

    for (const lease of leases) {
      const heartbeatElapsedRealtimeMs = lease.heartbeatElapsedRealtimeMs;
      if (
        lease.deviceSerial !== this.options.device.deviceId ||
        heartbeatElapsedRealtimeMs === undefined
      ) {
        continue;
      }
      const ageMs = deviceElapsedRealtimeMs - heartbeatElapsedRealtimeMs;
      if (ageMs < STALE_LEASE_MS) {
        continue;
      }
      logger.info(
        `[PersistentEncoderH264Source] stale-session-cleanup token=${lease.token} ageMs=${ageMs}`
      );
      await this.removeForwardIfMatching(adb, lease.forwardPort, lease.socketName);
      await this.terminateProcessIfMatching(adb, lease);
      await this.removeLeaseIfMatching(adb, lease);
    }
  }

  private async cleanupOwnedSession(
    session: VideoServerSession,
    port: number | null,
    expectedProcessId: number | null
  ): Promise<void> {
    const adb = this.adbFactory.create(this.options.device);
    const lease = await this.readLease(adb, session.token);
    if (
      lease &&
      lease.token === session.token &&
      lease.socketName === session.socketName &&
      lease.ownerPid === session.ownerPid &&
      lease.deviceSerial === session.deviceSerial &&
      lease.pid === expectedProcessId
    ) {
      await this.removeForwardIfMatching(adb, lease.forwardPort, lease.socketName);
      await this.terminateProcessIfMatching(adb, lease);
      await this.removeLeaseIfMatching(adb, lease);
      return;
    }
    if (lease) {
      logger.warn(
        `[PersistentEncoderH264Source] refusing owned-session process cleanup token=${session.token}: lease identity or PID mismatch`
      );
      await this.removeForwardIfMatching(adb, lease.forwardPort, session.socketName);
      return;
    }
    if (port !== null) {
      await this.removeForward(port);
    }
  }

  private async readLease(
    adb: ReturnType<AdbClientFactory["create"]>,
    token: string
  ): Promise<VideoServerLease | null> {
    try {
      const result = await adb.executeCommand(`shell cat ${VIDEO_SERVER_LEASE_DIRECTORY}/${token}.json`);
      return parseLeases(result.stdout).find(lease => lease.token === token) ?? null;
    } catch (error) {
      logger.debug(`[PersistentEncoderH264Source] unable to read owned video session lease: ${error}`);
      return null;
    }
  }

  private async terminateProcessIfMatching(
    adb: ReturnType<AdbClientFactory["create"]>,
    lease: VideoServerLease
  ): Promise<void> {
    try {
      const commandLine = await adb.executeCommand(`shell cat /proc/${lease.pid}/cmdline`);
      const argv = commandLine.stdout.split("\u0000");
      const ownsSession = argv.some(
        (argument, index) =>
          argument === "--session-token" && argv[index + 1] === lease.token
      );
      if (
        !argv.includes(VIDEO_SERVER_MAIN_CLASS) ||
        !ownsSession
      ) {
        logger.warn(
          `[PersistentEncoderH264Source] refusing stale-session process cleanup token=${lease.token}: PID/token mismatch`
        );
        return;
      }
      await adb.executeCommand(`shell kill -2 ${lease.pid}`);
    } catch (error) {
      logger.debug(
        `[PersistentEncoderH264Source] stale-session process cleanup skipped token=${lease.token}: ${error}`
      );
    }
  }

  private async removeForwardIfMatching(
    adb: ReturnType<AdbClientFactory["create"]>,
    port: number,
    socketName: string
  ): Promise<void> {
    try {
      const listed = await adb.executeCommand("forward --list");
      const expectedPort = `tcp:${port}`;
      const expectedDestination = `localabstract:${socketName}`;
      const matches = listed.stdout.split(/\r?\n/).some(line => {
        const fields = line.trim().split(/\s+/);
        return fields.includes(expectedPort) && fields.includes(expectedDestination);
      });
      if (!matches) {
        logger.warn(
          `[PersistentEncoderH264Source] refusing stale-session forward cleanup port=${port}: destination mismatch`
        );
        return;
      }
      await adb.executeCommand(`forward --remove tcp:${port}`);
    } catch (error) {
      logger.debug(`[PersistentEncoderH264Source] forward --remove failed: ${error}`);
    }
  }

  private async removeLeaseIfMatching(
    adb: ReturnType<AdbClientFactory["create"]>,
    lease: VideoServerLease
  ): Promise<void> {
    const current = await this.readLease(adb, lease.token);
    if (
      current?.token !== lease.token ||
      current.socketName !== lease.socketName ||
      current.pid !== lease.pid
    ) {
      return;
    }
    try {
      await adb.executeCommand(`shell rm -f ${VIDEO_SERVER_LEASE_DIRECTORY}/${lease.token}.json`);
    } catch (error) {
      logger.debug(`[PersistentEncoderH264Source] stale-session lease cleanup failed: ${error}`);
    }
  }

  private async removeForward(port: number): Promise<void> {
    try {
      const adb = this.adbFactory.create(this.options.device);
      await adb.executeCommand(`forward --remove tcp:${port}`);
    } catch (error) {
      logger.debug(`[PersistentEncoderH264Source] forward --remove failed: ${error}`);
    }
  }

  private attachServerOutputObserver(server: AdbProcess): void {
    this.serverOutputBuffer = "";
    this.sawStreamingStarted = false;
    const observer = (chunk: Buffer): void => {
      this.serverOutputBuffer += chunk.toString();
      const lines = this.serverOutputBuffer.split(/\r?\n/);
      this.serverOutputBuffer = lines.pop() ?? "";
      if (lines.includes(STREAMING_STARTED_MARKER)) {
        this.sawStreamingStarted = true;
      }
    };
    this.serverOutputObserver = observer;
    server.stdout.on("data", observer);
  }

  private detachServerOutputObserver(server: AdbProcess): void {
    if (this.serverOutputObserver) {
      server.stdout.off("data", this.serverOutputObserver);
    }
    this.serverOutputObserver = null;
    this.serverOutputBuffer = "";
    this.sawStreamingStarted = false;
  }

  private async readDeviceElapsedRealtimeMs(
    adb: ReturnType<AdbClientFactory["create"]>
  ): Promise<number | null> {
    try {
      const result = await adb.executeCommand("shell cat /proc/uptime");
      const uptimeSeconds = Number.parseFloat(result.stdout.trim().split(/\s+/, 1)[0] ?? "");
      if (Number.isFinite(uptimeSeconds) && uptimeSeconds >= 0) {
        return Math.floor(uptimeSeconds * 1_000);
      }
    } catch (error) {
      logger.debug(`[PersistentEncoderH264Source] unable to read device uptime: ${error}`);
    }
    return null;
  }
}
