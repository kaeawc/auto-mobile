import { connect as netConnect } from "node:net";
import { ActionableError, type BootedDevice } from "../../models";
import { logger } from "../../utils/logger";
import { defaultIdGenerator } from "../../utils/IdGenerator";
import { shellQuote } from "../../utils/shellQuote";
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
const SESSION_READY_PATTERN = /^VIDEO_SESSION_READY token=([^ ]+) pid=(\d+) socket=([^ ]+)$/;
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
/**
 * Bounded time for a blocking launch-path ADB/socket call (push, forward, spawn,
 * initial connect). A wedged ADB/USB state must degrade to screenrecord, not hang
 * the stream lifecycle forever.
 */
export const DEFAULT_LAUNCH_COMMAND_TIMEOUT_MS = 20_000;
/**
 * Bounded time for a blocking teardown/cleanup ADB call. Teardown is best-effort:
 * a timeout is logged and skipped so `stop()` always settles and lease
 * reconciliation handles any orphaned device resources.
 */
export const DEFAULT_TEARDOWN_COMMAND_TIMEOUT_MS = 5_000;

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
  /**
   * Frame rate to request from the device encoder via `--fps`. When omitted the
   * video-server falls back to the quality preset's default (30fps). Decoupled
   * from `quality` so the host can lower the rate without also lowering
   * resolution/bitrate.
   */
  fps?: number;
  /** Local path to the built `automobile-video.jar`. Required to run. */
  jarPath: string;
  adbFactory?: AdbClientFactory;
  connector?: SocketConnector;
  timer?: Timer;
  /** How long to wait for the server to signal readiness (ms). */
  readyTimeoutMs?: number;
  /** Bounded time for a blocking launch-path ADB/socket call (ms). */
  commandTimeoutMs?: number;
  /** Bounded time for a blocking teardown/cleanup ADB call (ms). */
  teardownTimeoutMs?: number;
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

function hasValidLeaseHeartbeat(lease: Record<string, unknown>): boolean {
  const elapsedRealtimeMs = lease.heartbeatElapsedRealtimeMs;
  return elapsedRealtimeMs === undefined ||
    (isFiniteNumber(elapsedRealtimeMs) && elapsedRealtimeMs >= 0);
}

function isVideoServerLease(value: unknown): value is RawVideoServerLease {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const lease = value as Record<string, unknown>;
  return [
    typeof lease.sessionToken === "string",
    typeof lease.sessionToken === "string" && isSafeSessionToken(lease.sessionToken),
    typeof lease.socketName === "string",
    typeof lease.deviceSerial === "string",
    isPositiveInteger(lease.ownerPid),
    isPositiveInteger(lease.pid),
    isPositiveInteger(lease.forwardPort),
    isFiniteNumber(lease.startedAtMs),
    isFiniteNumber(lease.heartbeatAtMs),
    hasValidLeaseHeartbeat(lease),
  ].every(Boolean);
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
  private readonly commandTimeoutMs: number;
  private readonly teardownTimeoutMs: number;
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
  private serverStartupInProgress: AdbProcess | null = null;
  private serverStartupFailure: { server: AdbProcess; error: Error } | null = null;

  constructor(options: PersistentEncoderH264SourceOptions) {
    this.options = options;
    this.adbFactory = options.adbFactory ?? defaultAdbClientFactory;
    this.connector = options.connector ?? defaultConnector;
    this.timer = options.timer ?? defaultTimer;
    this.readyTimeoutMs = options.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS;
    this.commandTimeoutMs = options.commandTimeoutMs ?? DEFAULT_LAUNCH_COMMAND_TIMEOUT_MS;
    this.teardownTimeoutMs = options.teardownTimeoutMs ?? DEFAULT_TEARDOWN_COMMAND_TIMEOUT_MS;
    this.localSocketReconnectWindowMs =
      options.localSocketReconnectWindowMs ?? DEFAULT_LOCAL_SOCKET_RECONNECT_WINDOW_MS;
    this.localSocketReconnectRetryMs =
      options.localSocketReconnectRetryMs ?? DEFAULT_LOCAL_SOCKET_RECONNECT_RETRY_MS;
    this.sessionTokenFactory = options.sessionTokenFactory ?? (() => defaultIdGenerator.next());
    this.validateTimings();
  }

  /**
   * Fail fast on non-positive timing options. Extracted from the constructor so the constructor
   * stays under the cyclomatic-complexity ratchet; every branch here is a validation guard, not
   * constructor control flow.
   */
  private validateTimings(): void {
    if (this.commandTimeoutMs <= 0 || this.teardownTimeoutMs <= 0) {
      throw new ActionableError("Video server command timeouts must be positive milliseconds.");
    }
    if (this.localSocketReconnectWindowMs <= 0 || this.localSocketReconnectRetryMs <= 0) {
      throw new ActionableError("Local socket reconnect timings must be positive milliseconds.");
    }
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
    this.serverStartupInProgress = null;
    this.serverStartupFailure = null;
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
  requestKeyFrame(): boolean {
    const socket = this.socket;
    if (!this.running || !socket) {
      return false;
    }
    this.telemetryInitialized = true;
    this.idrRequestCount++;
    this.pendingIdrRequests++;
    try {
      socket.write(Buffer.from([VIDEO_SERVER_COMMAND_REQUEST_KEY_FRAME]));
      return true;
    } catch (error) {
      this.pendingIdrRequests--;
      // Best-effort: a dropped socket surfaces via its own error/close handler.
      logger.debug(`[PersistentEncoderH264Source] keyframe request write failed: ${error}`);
      return false;
    }
  }

  /**
   * Race `operation` against a deadline driven by the injected `Timer`, so a
   * wedged ADB/USB state cannot block the persistent-encoder lifecycle forever.
   * On timeout the returned promise rejects with an `ActionableError`; launch-path
   * callers let it propagate (falling back to screenrecord) while teardown-path
   * callers catch it and continue. Deterministic under `FakeTimer` in tests.
   */
  private withTimeout<T>(operation: Promise<T>, ms: number, label: string): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      let settled = false;
      const timeout = this.timer.setTimeout(() => {
        if (settled) {
          return;
        }
        settled = true;
        logger.warn(`[PersistentEncoderH264Source] ${label} timed out after ${ms}ms`);
        reject(new ActionableError(`${label} did not complete within ${ms}ms`));
      }, ms);
      operation.then(
        value => {
          if (settled) {
            return;
          }
          settled = true;
          this.timer.clearTimeout(timeout);
          resolve(value);
        },
        error => {
          if (settled) {
            return;
          }
          settled = true;
          this.timer.clearTimeout(timeout);
          reject(error instanceof Error ? error : new Error(String(error)));
        }
      );
    });
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
    await this.withTimeout(
      adb.executeCommand(`push "${this.options.jarPath}" ${VIDEO_SERVER_REMOTE_JAR_PATH}`),
      this.commandTimeoutMs,
      "adb push video-server jar"
    );
    if (!this.running) {return null;}
    const forward = await this.withTimeout(
      adb.executeCommand(`forward tcp:0 localabstract:${session.socketName}`),
      this.commandTimeoutMs,
      "adb forward video-server socket"
    );
    const port = Number.parseInt(forward.stdout.trim(), 10);
    if (!Number.isInteger(port) || port <= 0) {
      throw new ActionableError(`adb forward returned an invalid port: "${forward.stdout.trim()}"`);
    }
    if (!this.running) {
      // This forward completed after stop() snapshotted its resources. It is
      // still ours only while it retains this session's destination.
      await this.removeForwardIfMatching(adb, port, session.socketName);
      return null;
    }
    this.forwardedPort = port;
    return port;
  }

  private async spawnAndWaitForServer(
    adb: ReturnType<AdbClientFactory["create"]>
  ): Promise<AdbProcess | null> {
    const server = await this.withTimeout(
      adb.spawn(this.buildServerArgs()),
      this.commandTimeoutMs,
      "adb spawn video-server"
    );
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
    this.serverStartupInProgress = server;
    this.watchServer(server);
    return this.running ? server : null;
  }

  private async connectToServer(server: AdbProcess, port: number): Promise<void> {
    this.throwIfServerStartupFailed(server);
    const streamingStarted = this.options.audioEnabled
      ? this.waitForStreamingStarted(server)
      : null;
    // The waiter is installed before connecting so a fast server cannot print
    // the marker in the gap between client connect and the later startup await.
    streamingStarted?.catch(() => {});

    // Give the first connect the same deadline+abort treatment the reconnect path
    // uses. A half-open forward with a live server would otherwise hang here
    // forever (the race below only settles on server failure, not a stuck connect).
    const connectController = new AbortController();
    const connectDeadline = this.timer.now() + this.commandTimeoutMs;
    const connection = this.connectBeforeDeadline(port, connectDeadline, connectController.signal);
    let connectionWon = false;
    let rejectServerFailure!: (error: Error) => void;
    const serverFailure = new Promise<never>((_, reject) => {
      rejectServerFailure = reject;
    });
    const onServerExit = (code: number | null, signal: NodeJS.Signals | null): void => {
      rejectServerFailure(new Error(`video-server exited (code=${code}, signal=${signal})`));
    };
    const onServerError = (error: Error): void => {
      rejectServerFailure(error);
    };
    server.once("exit", onServerExit);
    server.once("error", onServerError);
    try {
      const socket = await Promise.race([connection, serverFailure]);
      connectionWon = true;
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
    } finally {
      server.removeListener("exit", onServerExit);
      server.removeListener("error", onServerError);
      if (!connectionWon) {
        // Server failure (or teardown) won the race: cancel the bounded connect
        // so a late-resolving local socket is destroyed rather than leaked.
        connectController.abort();
        void connection.catch(() => {});
      }
      if (this.serverStartupInProgress === server) {
        this.serverStartupInProgress = null;
      }
    }
  }

  private throwIfServerStartupFailed(server: AdbProcess): void {
    const failure = this.serverStartupFailure;
    if (failure?.server === server) {
      throw failure.error;
    }
  }

  private watchServer(server: AdbProcess): void {
    server.once("exit", (code, signal) => {
      if (this.server !== server) {return;}
      this.detachServerOutputObserver(server);
      this.server = null;
      if (this.serverStartupInProgress === server) {
        this.serverStartupFailure = {
          server,
          error: new Error(`video-server exited (code=${code}, signal=${signal})`),
        };
        return;
      }
      this.failIfRunning(new Error(`video-server exited (code=${code}, signal=${signal})`));
    });
    server.once("error", (error: Error) => {
      if (this.serverStartupInProgress === server) {
        this.serverStartupFailure = { server, error };
        return;
      }
      this.failIfRunning(error);
    });
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
    if (Number.isInteger(this.options.fps) && (this.options.fps as number) > 0) {
      args.push("--fps", String(this.options.fps));
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
        const lines = stdoutBuffer.split(/\r?\n/);
        stdoutBuffer = lines.pop() ?? "";
        for (const line of lines) {
          const match = SESSION_READY_PATTERN.exec(line);
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
    let failed = false;
    const reportFailure = (error: Error): void => {
      if (failed || this.socket !== socket) {
        return;
      }
      failed = true;
      onSocketFailure(error);
    };
    socket.on("data", chunk => {
      try {
        parser.push(chunk);
      } catch (error) {
        // A bounded parse error (over-cap size/trackCount, i.e. a framing
        // desync) surfaces here instead of the parser buffering forever. Route
        // it through the same failure path as a socket error so the source
        // triggers its bounded reconnect/fallback.
        reportFailure(error instanceof Error ? error : new Error(String(error)));
      }
    });
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
      logger.warn(
        `[PersistentEncoderH264Source] refusing forward cleanup port=${port}: session identity is unavailable`
      );
    }
  }

  private async reconcileExpiredLeases(adb: ReturnType<AdbClientFactory["create"]>): Promise<void> {
    let leases: VideoServerLease[];
    try {
      const leaseListCommand =
        `for f in ${VIDEO_SERVER_LEASE_DIRECTORY}/*.json; do ` +
        '[ -f "$f" ] || continue; cat "$f"; printf "\\n"; done';
      const result = await this.withTimeout(
        adb.executeCommand(`shell sh -c ${shellQuote(leaseListCommand)}`),
        this.teardownTimeoutMs,
        "adb read video session leases"
      );
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
      // elapsedRealtime resets when Android reboots. A negative age therefore
      // proves this persisted lease belongs to a previous boot.
      if (ageMs >= 0 && ageMs < STALE_LEASE_MS) {
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
    if (lease && this.isOwnedSessionLease(lease, session, expectedProcessId)) {
      await this.removeForwardIfMatching(adb, lease.forwardPort, lease.socketName);
      await this.removeOwnedForward(adb, port, session.socketName, lease.forwardPort);
      await this.terminateProcessIfMatching(adb, lease);
      await this.removeLeaseIfMatching(adb, lease);
      return;
    }
    if (lease) {
      logger.warn(
        `[PersistentEncoderH264Source] refusing owned-session process cleanup token=${session.token}: lease identity or PID mismatch`
      );
      await this.removeOwnedForward(adb, port, session.socketName);
      return;
    }
    await this.removeOwnedForward(adb, port, session.socketName);
  }

  private isOwnedSessionLease(
    lease: VideoServerLease,
    session: VideoServerSession,
    expectedProcessId: number | null
  ): boolean {
    // A cancellation can arrive after the server persisted its lease but before
    // VIDEO_SESSION_READY handed its PID back to the host. The lease identity
    // plus terminateProcessIfMatching's argv check still make owned cleanup safe.
    return lease.token === session.token &&
      lease.socketName === session.socketName &&
      lease.ownerPid === session.ownerPid &&
      lease.deviceSerial === session.deviceSerial &&
      (expectedProcessId === null || lease.pid === expectedProcessId);
  }

  private async removeOwnedForward(
    adb: ReturnType<AdbClientFactory["create"]>,
    port: number | null,
    socketName: string,
    exceptPort?: number
  ): Promise<void> {
    if (port !== null && port !== exceptPort) {
      await this.removeForwardIfMatching(adb, port, socketName);
    }
  }

  private async readLease(
    adb: ReturnType<AdbClientFactory["create"]>,
    token: string
  ): Promise<VideoServerLease | null> {
    try {
      const result = await this.withTimeout(
        adb.executeCommand(`shell cat ${VIDEO_SERVER_LEASE_DIRECTORY}/${token}.json`),
        this.teardownTimeoutMs,
        "adb read owned video session lease"
      );
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
      const commandLine = await this.withTimeout(
        adb.executeCommand(`shell cat /proc/${lease.pid}/cmdline`),
        this.teardownTimeoutMs,
        "adb read video-server process cmdline"
      );
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
      await this.withTimeout(
        adb.executeCommand(`shell kill -2 ${lease.pid}`),
        this.teardownTimeoutMs,
        "adb terminate video-server process"
      );
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
      const listed = await this.withTimeout(
        adb.executeCommand("forward --list"),
        this.teardownTimeoutMs,
        "adb forward --list"
      );
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
      await this.withTimeout(
        adb.executeCommand(`forward --remove tcp:${port}`),
        this.teardownTimeoutMs,
        "adb forward --remove"
      );
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
      await this.withTimeout(
        adb.executeCommand(`shell rm -f ${VIDEO_SERVER_LEASE_DIRECTORY}/${lease.token}.json`),
        this.teardownTimeoutMs,
        "adb remove video session lease"
      );
    } catch (error) {
      logger.debug(`[PersistentEncoderH264Source] stale-session lease cleanup failed: ${error}`);
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
      const result = await this.withTimeout(
        adb.executeCommand("shell cat /proc/uptime"),
        this.teardownTimeoutMs,
        "adb read device uptime"
      );
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
