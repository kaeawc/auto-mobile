import { connect as netConnect } from "node:net";
import { ActionableError, type BootedDevice } from "../../models";
import { logger } from "../../utils/logger";
import { defaultTimer, type Timer } from "../../utils/SystemTimer";
import {
  defaultAdbClientFactory,
  type AdbClientFactory,
} from "../../utils/android-cmdline-tools/AdbClientFactory";
import type { H264CaptureSource } from "./H264CaptureSource";
import { defaultProcessSpawner, type ProcessSpawner, type SpawnedProcess } from "./processSpawner";
import {
  VIDEO_SERVER_CODEC_ID_H264,
  VIDEO_SERVER_CODEC_ID_PCM16,
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

/** Minimal socket surface the source needs, for injectable testing. */
export interface StreamSocket {
  on(event: "data", listener: (chunk: Buffer) => void): void;
  on(event: "error", listener: (error: Error) => void): void;
  on(event: "close", listener: () => void): void;
  destroy(): void;
}

/** Connects to a forwarded local TCP port and resolves once connected. */
export type SocketConnector = (port: number) => Promise<StreamSocket>;

const defaultConnector: SocketConnector = port =>
  new Promise<StreamSocket>((resolve, reject) => {
    const socket = netConnect(port, "127.0.0.1");
    socket.once("connect", () => resolve(socket));
    socket.once("error", reject);
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
  spawner?: ProcessSpawner;
  connector?: SocketConnector;
  timer?: Timer;
  /** How long to wait for the server to signal readiness (ms). */
  readyTimeoutMs?: number;
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
 * (adb factory, spawner, socket connector, timer) for device-free unit tests.
 */
export class PersistentEncoderH264Source implements H264CaptureSource {
  private readonly options: PersistentEncoderH264SourceOptions;
  private readonly adbFactory: AdbClientFactory;
  private readonly spawner: ProcessSpawner;
  private readonly connector: SocketConnector;
  private readonly timer: Timer;
  private readonly readyTimeoutMs: number;

  private server: SpawnedProcess | null = null;
  private socket: StreamSocket | null = null;
  private forwardedPort: number | null = null;
  private running = false;

  constructor(options: PersistentEncoderH264SourceOptions) {
    this.options = options;
    this.adbFactory = options.adbFactory ?? defaultAdbClientFactory;
    this.spawner = options.spawner ?? defaultProcessSpawner;
    this.connector = options.connector ?? defaultConnector;
    this.timer = options.timer ?? defaultTimer;
    this.readyTimeoutMs = options.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS;
  }

  get isRunning(): boolean {
    return this.running;
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
      await this.teardown();
      throw error;
    }
  }

  async stop(): Promise<void> {
    if (!this.running) {
      return;
    }
    this.running = false;
    await this.teardown();
  }

  private async launch(): Promise<void> {
    const adb = this.adbFactory.create(this.options.device);
    const adbPath = await adb.getAdbPathOnly();
    if (!this.running) {
      return;
    }

    // Push the DEX jar (idempotent; overwrites any prior copy).
    await adb.executeCommand(`push "${this.options.jarPath}" ${VIDEO_SERVER_REMOTE_JAR_PATH}`);

    // Launch the persistent server as a long-lived process.
    const server = this.spawner(adbPath, this.buildServerArgs());
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

    const socket = await this.connector(port);
    if (!this.running) {
      socket.destroy();
      return;
    }
    this.socket = socket;
    this.wireSocket(socket);

    // For audio-enabled streams, REMOTE_SUBMIX initialization happens after the
    // socket client connects. Do not resolve start() until that succeeds, or an
    // unavailable audio source would look like a successful start followed by a
    // reconnect-looping post-start failure.
    if (this.options.audioEnabled) {
      await this.waitForStreamingStarted(server);
      if (!this.running) {
        return;
      }
    }

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
    const baseArgs = this.options.device.deviceId ? ["-s", this.options.device.deviceId] : [];
    const args = [
      ...baseArgs,
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

  private waitForReady(server: SpawnedProcess): Promise<void> {
    return this.waitForServerLine(
      server,
      READY_MARKER,
      `video-server did not become ready within ${this.readyTimeoutMs}ms`,
      "video-server exited before ready"
    );
  }

  private waitForStreamingStarted(server: SpawnedProcess): Promise<void> {
    return this.waitForServerLine(
      server,
      STREAMING_STARTED_MARKER,
      `video-server did not start streaming within ${this.readyTimeoutMs}ms`,
      "video-server exited before streaming started"
    );
  }

  private waitForServerLine(
    server: SpawnedProcess,
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

  private wireSocket(socket: StreamSocket): void {
    const parser = new VideoServerStreamParser({
      onHeader: header =>
        logger.info(
          `[PersistentEncoderH264Source] stream ${header.width}x${header.height} codec=0x${header.codecId.toString(16)}`
        ),
      onPacket: packet => {
        if (this.socket === socket) {
          if (packet.codecId === VIDEO_SERVER_CODEC_ID_H264) {
            this.options.onData(packet.data);
          } else if (packet.codecId === VIDEO_SERVER_CODEC_ID_PCM16) {
            this.options.onAudioData?.(packet.data);
          }
        }
      },
    });
    socket.on("data", chunk => parser.push(chunk));
    socket.on("error", error => this.failIfRunning(error));
    socket.on("close", () => this.failIfRunning(new Error("video-server socket closed")));
  }

  /** Surface a post-start fatal failure exactly once and stop feeding data. */
  private failIfRunning(error: Error): void {
    if (!this.running) {
      return;
    }
    this.running = false;
    this.socket = null;
    void this.teardown();
    this.options.onError?.(error);
  }

  private async teardown(): Promise<void> {
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
