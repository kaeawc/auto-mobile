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
/** Abstract LocalSocket name the server binds (matches VideoServer.SOCKET_NAME). */
export const VIDEO_SERVER_SOCKET_NAME = "automobile_video";
const VIDEO_SERVER_MAIN_CLASS = "dev.jasonpearson.automobile.video.VideoServer";
/** Server stdout line printed once it is ready to accept the socket client. */
const READY_MARKER = "Waiting for client connection";
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
}

const DEFAULT_READY_TIMEOUT_MS = 10_000;

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

  private server: AdbProcess | null = null;
  private socket: StreamSocket | null = null;
  private forwardedPort: number | null = null;
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
    if (!this.running) {
      return;
    }

    // Push the DEX jar (idempotent; overwrites any prior copy).
    await adb.executeCommand(`push "${this.options.jarPath}" ${VIDEO_SERVER_REMOTE_JAR_PATH}`);
    if (!this.running) {
      return;
    }

    // Launch the persistent server as a long-lived process.
    const server = await adb.spawn(this.buildServerArgs());
    if (!this.running) {
      server.kill("SIGINT");
      return;
    }
    this.server = server;
    server.stderr.on("data", (chunk: Buffer) => {
      const text = chunk.toString().trim();
      if (text) {
        logger.debug(`[PersistentEncoderH264Source] server stderr: ${text}`);
      }
    });

    // Wait until the server has bound its LocalSocket and is ready for a client.
    // Readiness owns the startup window: a server crash here must REJECT start()
    // (so the factory falls back), not fire onError (which would trigger a
    // pointless reconnect against a source that never came up).
    await this.waitForReady(server);
    if (!this.running) {
      return;
    }

    // Forward an ephemeral local port to the server's abstract socket and connect.
    const forward = await adb.executeCommand(
      `forward tcp:0 localabstract:${VIDEO_SERVER_SOCKET_NAME}`
    );
    const port = Number.parseInt(forward.stdout.trim(), 10);
    if (!Number.isInteger(port) || port <= 0) {
      throw new ActionableError(`adb forward returned an invalid port: "${forward.stdout.trim()}"`);
    }
    this.forwardedPort = port;

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

    // Now that the source is live, a later server exit or socket drop IS a fatal
    // post-start failure: surface it via onError so the publisher reconnects.
    server.once("exit", (code, signal) => {
      if (this.server !== server) {
        return; // superseded / already torn down
      }
      this.server = null;
      this.failIfRunning(new Error(`video-server exited (code=${code}, signal=${signal})`));
    });
    server.once("error", (error: Error) => this.failIfRunning(error));
  }

  private buildServerArgs(): string[] {
    const args = [
      "shell",
      `CLASSPATH=${VIDEO_SERVER_REMOTE_JAR_PATH}`,
      "app_process",
      "/",
      VIDEO_SERVER_MAIN_CLASS,
      "--quality",
      this.options.quality ?? "medium",
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

  private waitForReady(server: AdbProcess): Promise<void> {
    return this.waitForServerLine(
      server,
      READY_MARKER,
      `video-server did not become ready within ${this.readyTimeoutMs}ms`,
      "video-server exited before ready"
    );
  }

  private waitForStreamingStarted(server: AdbProcess): Promise<void> {
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
    socket.on("error", onSocketFailure);
    socket.on("close", () => onSocketFailure(new Error("video-server socket closed")));
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
    // Terminating the host `adb shell` process closes the exec stream, which
    // stops the device-side server for THIS session. We deliberately do NOT run
    // a device-wide `pkill` (unlike the file-recording backend): it would also
    // kill a concurrent `videoRecording` on the same device.
    server?.kill("SIGINT");

    const port = this.forwardedPort;
    this.forwardedPort = null;
    if (port !== null) {
      try {
        const adb = this.adbFactory.create(this.options.device);
        await adb.executeCommand(`forward --remove tcp:${port}`);
      } catch (error) {
        // Best-effort: the forward is torn down with the device/adb server anyway.
        logger.debug(`[PersistentEncoderH264Source] forward --remove failed: ${error}`);
      }
    }
  }
}
