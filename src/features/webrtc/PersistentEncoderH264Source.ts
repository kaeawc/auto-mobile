import { ActionableError } from "../../models";
import { defaultAdbClientFactory } from "../../utils/android-cmdline-tools/AdbClientFactory";
import type { AdbProcess } from "../../utils/android-cmdline-tools/interfaces/AdbExecutor";
import { normalizeBackoff, type BackoffPolicy } from "../../utils/Backoff";
import { errorMessage } from "../../utils/describeUnknownError";
import { defaultIdGenerator } from "../../utils/IdGenerator";
import { logger } from "../../utils/logger";
import { raceWithDeadline } from "../../utils/raceWithDeadline";
import { defaultTimer, type Timer } from "../../utils/SystemTimer";
import type { H264CaptureSource, H264CaptureSourceTelemetry } from "./H264CaptureSource";
import {
  type ActiveVideoSessionRegistry,
  DEFAULT_LAUNCH_COMMAND_TIMEOUT_MS,
  DEFAULT_LOCAL_SOCKET_RECONNECT_RETRY_MS,
  DEFAULT_LOCAL_SOCKET_RECONNECT_WINDOW_MS,
  DEFAULT_MAX_SERVER_RELAUNCH_ATTEMPTS,
  DEFAULT_READY_TIMEOUT_MS,
  DEFAULT_SERVER_RELAUNCH_BACKOFF,
  DEFAULT_SERVER_RELAUNCH_HEALTHY_WINDOW_MS,
  DEFAULT_TEARDOWN_COMMAND_TIMEOUT_MS,
  defaultActiveVideoSessionRegistry,
  defaultConnector,
  makeOpaqueSocketName,
  type PersistentEncoderH264SourceOptions,
  type SocketConnector,
  type StreamSocket,
  VIDEO_SERVER_COMMAND_REQUEST_KEY_FRAME,
  type VideoServerSession,
} from "./persistentEncoderProtocol";
import {
  buildServerArgs,
  createSession,
  resolveHandshakeVersion,
  sendHandshake,
} from "./persistentEncoderSession";
import { withTimeout } from "./persistentEncoderTimeout";
import { VideoServerJarDeployment } from "./VideoServerJarDeployment";
import { VideoServerLeases } from "./VideoServerLeases";
import { VideoServerStartup } from "./VideoServerStartup";
import {
  VIDEO_SERVER_CODEC_ID_H264,
  VIDEO_SERVER_CODEC_ID_PCM16,
  VideoServerStreamParser,
  type VideoServerPacket,
  type VideoServerStreamHeader,
} from "./VideoServerStreamParser";
import type { VideoSourceAdb, VideoSourceAdbFactory } from "./videoSourceAdb";
export { InMemoryActiveVideoSessionRegistry } from "./InMemoryActiveVideoSessionRegistry";
export {
  type ActiveVideoSessionRegistry,
  type PersistentEncoderH264SourceOptions,
  type SocketConnector,
  type StreamSocket,
  VIDEO_SERVER_HANDSHAKE_VERSION,
  type VideoServerSession,
} from "./persistentEncoderProtocol";
export { VIDEO_SERVER_LEASE_DIRECTORY, VIDEO_SERVER_SOCKET_PREFIX } from "./VideoServerLeases";

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
  private readonly leases: VideoServerLeases;
  private readonly jar: VideoServerJarDeployment;
  private readonly startup: VideoServerStartup;

  private readonly options: PersistentEncoderH264SourceOptions;
  private readonly adbFactory: VideoSourceAdbFactory;
  private readonly connector: SocketConnector;
  private readonly timer: Timer;
  private readonly readyTimeoutMs: number;
  private readonly commandTimeoutMs: number;
  private readonly teardownTimeoutMs: number;
  private readonly localSocketReconnectWindowMs: number;
  private readonly localSocketReconnectRetryMs: number;
  private readonly sessionTokenFactory: () => string;
  private readonly socketNameFactory: () => string;
  private readonly activeVideoSessionRegistry: ActiveVideoSessionRegistry;
  private readonly maxServerRelaunchAttempts: number;
  private readonly serverRelaunchBackoff: BackoffPolicy;
  private readonly serverRelaunchHealthyWindowMs: number;

  private server: AdbProcess | null = null;
  private socket: StreamSocket | null = null;
  private forwardedPort: number | null = null;
  private session: VideoServerSession | null = null;
  private deviceProcessId: number | null = null;
  /**
   * Handshake protocol version negotiated from the device's readiness line
   * (issue #4729). `null` means the device advertised no `proto=` field (a
   * pre-handshake jar): the client then connects without sending a handshake so
   * streaming degrades gracefully instead of hard-breaking.
   */
  private negotiatedHandshakeVersion: number | null = null;
  private running = false;
  private teardownPromise: Promise<void> | null = null;
  private socketReconnectPromise: Promise<void> | null = null;
  private socketReconnectAbortController: AbortController | null = null;
  private telemetryInitialized = false;
  private lastEncodedFrameTimestampUs: number | null = null;
  private lastIdrTimestampUs: number | null = null;
  private idrRequestCount = 0;
  private idrCompletionCount = 0;
  private pendingIdrRequests = 0;
  private encodedAccessUnitCount = 0;
  private serverStartupInProgress: AdbProcess | null = null;
  private serverStartupFailure: { server: AdbProcess; error: Error } | null = null;
  private serverRelaunchAttempts = 0;
  /**
   * Timer-clock timestamp of the most recent successful (re)launch, or `null`
   * before the first one. Compared against {@link serverRelaunchHealthyWindowMs}
   * on the next post-start loss to decide whether that loss starts a fresh
   * relaunch budget (issue #7547).
   */
  private serverHealthySinceMs: number | null = null;
  private relaunching = false;
  private relaunchAbortController: AbortController | null = null;

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
    this.socketNameFactory =
      options.socketNameFactory ?? (() => makeOpaqueSocketName(defaultIdGenerator));
    this.activeVideoSessionRegistry =
      options.activeVideoSessionRegistry ?? defaultActiveVideoSessionRegistry;
    this.jar = new VideoServerJarDeployment(
      options,
      this.commandTimeoutMs,
      (operation, ms, label) => this.withTimeout(operation, ms, label),
    );
    const relaunchPolicy = PersistentEncoderH264Source.resolveRelaunchPolicy(options);
    this.maxServerRelaunchAttempts = relaunchPolicy.maxAttempts;
    this.serverRelaunchBackoff = relaunchPolicy.backoff;
    this.serverRelaunchHealthyWindowMs = relaunchPolicy.healthyWindowMs;
    this.leases = new VideoServerLeases(
      options,
      this.adbFactory,
      this.timer,
      this.activeVideoSessionRegistry,
      this.teardownTimeoutMs,
      (operation, ms, label) => this.withTimeout(operation, ms, label),
    );
    this.startup = new VideoServerStartup(
      options,
      this.timer,
      this.readyTimeoutMs,
      () => this.session,
    );
    this.validateTimings();
  }

  /**
   * Resolve the post-start relaunch policy from options, defaulting the budget,
   * backoff, and healthy-reset window. Extracted from the constructor so the
   * option-defaulting `??` branches do not count against the constructor's
   * complexity ratchet.
   */
  private static resolveRelaunchPolicy(options: PersistentEncoderH264SourceOptions): {
    maxAttempts: number;
    backoff: BackoffPolicy;
    healthyWindowMs: number;
  } {
    return {
      maxAttempts: options.maxServerRelaunchAttempts ?? DEFAULT_MAX_SERVER_RELAUNCH_ATTEMPTS,
      backoff: normalizeBackoff(options.serverRelaunchBackoff ?? DEFAULT_SERVER_RELAUNCH_BACKOFF),
      healthyWindowMs:
        options.serverRelaunchHealthyWindowMs ?? DEFAULT_SERVER_RELAUNCH_HEALTHY_WINDOW_MS,
    };
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
    if (!Number.isInteger(this.maxServerRelaunchAttempts) || this.maxServerRelaunchAttempts < 0) {
      throw new ActionableError("Server relaunch attempts must be a non-negative integer.");
    }
    if (this.serverRelaunchHealthyWindowMs <= 0) {
      throw new ActionableError("Server relaunch healthy window must be positive milliseconds.");
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
      this.serverHealthySinceMs = this.timer.now();
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
    // Cancel any in-flight relaunch wait/loop so stop() settles promptly instead
    // of blocking on a backoff delay or a relaunch launch attempt.
    this.relaunchAbortController?.abort();
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
  private withTimeout<T>(operation: Promise<T>, ms: number, label: string): Promise<T> {
    return withTimeout({ timer: this.timer }, operation, ms, label);
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

  private async prepareSession(adb: VideoSourceAdb): Promise<number | null> {
    if (!this.running) {
      return null;
    }
    const session = this.createSession();
    this.session = session;
    this.deviceProcessId = null;
    this.jar.remoteJarVerified = false;
    // Claim this session's socket name BEFORE reconcile opens/owns any forward,
    // so a sibling session's concurrent orphan sweep can never mistake our
    // about-to-be-created forward for a stranded one. Cleared in teardown().
    this.activeVideoSessionRegistry.add(this.options.device.deviceId, session.socketName);
    await this.leases.reconcileExpiredLeases(adb);
    if (!this.running) {
      return null;
    }
    await this.jar.ensureRemoteJar(adb);
    if (!this.running) {
      return null;
    }
    const forward = await this.withTimeout(
      adb.executeCommand(`forward tcp:0 localabstract:${session.socketName}`, {
        timeoutMs: this.commandTimeoutMs,
      }),
      this.commandTimeoutMs,
      "adb forward video-server socket",
    );
    const port = Number.parseInt(forward.stdout.trim(), 10);
    if (!Number.isInteger(port) || port <= 0) {
      throw new ActionableError(`adb forward returned an invalid port: "${forward.stdout.trim()}"`);
    }
    if (!this.running) {
      // This forward completed after stop() snapshotted its resources. It is
      // still ours only while it retains this session's destination.
      await this.leases.removeForwardIfMatching(adb, port, session.socketName);
      return null;
    }
    this.forwardedPort = port;
    return port;
  }

  private async spawnAndWaitForServer(adb: VideoSourceAdb): Promise<AdbProcess | null> {
    await this.jar.verifyRemoteJarBeforeLaunch(adb);
    if (!this.running) {
      return null;
    }
    const server = await this.withTimeout(
      adb.spawn(this.buildServerArgs()),
      this.commandTimeoutMs,
      "adb spawn video-server",
    );
    if (!this.running) {
      server.kill("SIGINT");
      return null;
    }
    this.server = server;
    this.startup.attachServerOutputObserver(server);
    server.stderr.on("data", (chunk: Buffer) => {
      const text = chunk.toString().trim();
      if (text) {
        logger.debug(`[PersistentEncoderH264Source] server stderr: ${text}`);
      }
    });

    const ready = await this.startup.waitForReady(server);
    this.deviceProcessId = ready.pid;
    this.negotiatedHandshakeVersion = resolveHandshakeVersion(ready.protocolVersion);
    this.serverStartupInProgress = server;
    this.watchServer(server);
    return this.running ? server : null;
  }

  private async connectToServer(server: AdbProcess, port: number): Promise<void> {
    this.throwIfServerStartupFailed(server);
    const streamingStarted = this.options.audioEnabled
      ? this.startup.waitForStreamingStarted(server)
      : null;
    // The waiter is installed before connecting so a fast server cannot print
    // the marker in the gap between client connect and the later startup await.
    streamingStarted?.catch((error) => {
      // Startup awaits this waiter separately; tracing here prevents an early unhandled rejection.
      logger.debug(
        `[PersistentEncoderH264Source] Audio startup waiter rejected: ${errorMessage(error)}`,
      );
    });

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
      const socket = await raceWithDeadline([connection, serverFailure], {
        timer: this.timer,
        label: "video-server connection",
      });
      connectionWon = true;
      if (!this.running) {
        socket.destroy();
        return;
      }
      this.socket = socket;
      // Authenticate the connection before anything reads the stream header.
      this.sendHandshake(socket);
      const startupAudioReady = this.options.audioEnabled
        ? this.startup.waitForStartupAudioReady()
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
      this.wireSocket(
        socket,
        (error) => {
          if (socketFailureMode === "startup") {
            rejectStartupSocketFailure?.(error);
            return;
          }
          this.reconnectSocket(socket, error);
        },
        (header) => this.startup.resolveStartupAudioHeader?.(header),
      );

      // For audio-enabled streams, REMOTE_SUBMIX initialization happens after the
      // socket client connects. Do not resolve start() until that succeeds, or an
      // unavailable audio source would look like a successful start followed by a
      // reconnect-looping post-start failure.
      if (this.options.audioEnabled) {
        await raceWithDeadline<[void | null, void | null] | null>(
          [
            Promise.all([streamingStarted, startupAudioReady]),
            Promise.resolve(startupSocketFailure),
          ],
          { timer: this.timer, label: "video-server audio startup" },
        );
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
        void connection.catch((error) => {
          // Teardown or server failure won the race, so cancellation of the losing connect is expected.
          logger.debug(
            `[PersistentEncoderH264Source] Losing connection rejected: ${errorMessage(error)}`,
          );
        });
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
      if (this.server !== server) {
        return;
      }
      this.startup.detachServerOutputObserver(server);
      this.server = null;
      if (this.serverStartupInProgress === server) {
        this.serverStartupFailure = {
          server,
          error: new Error(`video-server exited (code=${code}, signal=${signal})`),
        };
        return;
      }
      this.handlePostStartServerLoss(
        new Error(`video-server exited (code=${code}, signal=${signal})`),
      );
    });
    server.once("error", (error: Error) => {
      if (this.serverStartupInProgress === server) {
        this.serverStartupFailure = { server, error };
        return;
      }
      this.handlePostStartServerLoss(error);
    });
  }

  private buildServerArgs(): string[] {
    return buildServerArgs({
      session: this.session,
      forwardedPort: this.forwardedPort,
      options: this.options,
    });
  }

  private createSession(): VideoServerSession {
    return createSession({
      options: this.options,
      sessionTokenFactory: this.sessionTokenFactory.bind(this),
      socketNameFactory: this.socketNameFactory.bind(this),
    });
  }

  /**
   * Send the pre-stream token handshake as the FIRST bytes on a freshly-connected
   * socket, before the server emits (or the client reads) any stream header (issue
   * #4729). Skipped when the device advertised no handshake support
   * ({@link negotiatedHandshakeVersion} is `null`), so a new host degrades
   * gracefully against a pre-handshake device instead of hard-breaking the stream.
   * Called on every accept — the initial connect and each socket reconnect — because
   * the server requires the handshake on every `accept()`.
   */
  private sendHandshake(socket: StreamSocket): void {
    return sendHandshake(
      { session: this.session, negotiatedHandshakeVersion: this.negotiatedHandshakeVersion },
      socket,
    );
  }

  private wireSocket(
    socket: StreamSocket,
    onSocketFailure: (error: Error) => void,
    onStreamHeader?: (header: VideoServerStreamHeader) => void,
  ): void {
    const parser = new VideoServerStreamParser({
      onHeader: (header) => {
        onStreamHeader?.(header);
        // Every local client attach, including a replacement socket, triggers a
        // fresh encoder request. The video-server has already replayed cached
        // SPS/PPS + IDR; this makes the next frame current without a GOP wait.
        this.requestKeyFrame();
        logger.info(
          `[PersistentEncoderH264Source] stream ${header.width}x${header.height} codec=0x${header.codecId.toString(16)}`,
        );
      },
      onPacket: (packet) => {
        if (this.socket === socket) {
          if (packet.codecId === VIDEO_SERVER_CODEC_ID_H264) {
            this.deliverVideoPacket(packet);
          } else if (packet.codecId === VIDEO_SERVER_CODEC_ID_PCM16) {
            this.options.onAudioData?.(packet.data);
            this.startup.resolveStartupAudioPacket?.(packet);
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
    socket.on("data", (chunk) => {
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

  private deliverVideoPacket(packet: VideoServerPacket): void {
    this.observeVideoPacket(packet);
    // A CONFIG packet attests the current display rotation (issue #4786). Surface it before
    // the payload so the relay's rotation is current when the SPS/PPS reaches subscribers.
    if (packet.config && packet.rotation !== undefined) {
      this.options.onRotation?.(packet.rotation);
    }
    if (!packet.config && !packet.replayed) {
      this.options.onSourceFrame?.();
    }
    this.options.onData(packet.data);
    // Packets are length-framed on the wire, so the host knows where this access unit ends.
    this.options.onEncodedAccessUnit?.();
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
    if (!this.running || this.socket !== failedSocket || this.socketReconnectPromise !== null) {
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
        // The retained server requires the handshake on every accept, including reconnects.
        this.sendHandshake(socket);
        this.wireSocket(socket, (error) => this.reconnectSocket(socket, error));
        logger.info("[PersistentEncoderH264Source] reconnected to retained video-server socket");
        return;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
      }

      const remainingMs = deadline - this.timer.now();
      if (remainingMs <= 0) {
        break;
      }
      await this.waitForReconnectRetry(
        Math.min(this.localSocketReconnectRetryMs, remainingMs),
        signal,
      );
    }

    this.failReconnectIfServerRetained(signal, lastError);
  }

  /**
   * Terminal decision for the socket-reconnect loop. A socket-only drop against a
   * still-retained server that never reconnects is fatal. But an aborted signal
   * (teardown) or a `null` server (the server process itself exited) means this
   * path does not own the outcome: teardown or the post-start relaunch path
   * (handlePostStartServerLoss) does, so it must not also fail the source.
   */
  private failReconnectIfServerRetained(signal: AbortSignal, lastError: Error): void {
    if (signal.aborted || this.server === null) {
      return;
    }
    this.failIfRunning(
      new Error(
        `video-server socket did not reconnect within ${this.localSocketReconnectWindowMs}ms: ${lastError.message}`,
      ),
    );
  }

  private waitForReconnectRetry(ms: number, signal: AbortSignal): Promise<void> {
    if (signal.aborted) {
      return Promise.resolve();
    }

    return new Promise((resolve) => {
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
    reconnectSignal: AbortSignal,
  ): Promise<StreamSocket> {
    const remainingMs = deadline - this.timer.now();
    if (remainingMs <= 0) {
      throw new Error("video-server socket reconnect deadline elapsed");
    }

    const controller = new AbortController();
    const raceController = new AbortController();
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
    const rejectOnAbort = (): void =>
      raceController.abort(
        new Error(
          timedOut
            ? "video-server socket reconnect attempt timed out"
            : "video-server socket reconnect attempt aborted",
        ),
      );
    if (controller.signal.aborted) {
      rejectOnAbort();
    } else {
      controller.signal.addEventListener("abort", rejectOnAbort, { once: true });
    }

    try {
      return await raceWithDeadline(connection, {
        timer: this.timer,
        signal: raceController.signal,
        label: "video-server socket reconnect attempt",
      });
    } finally {
      this.timer.clearTimeout(timeout);
      reconnectSignal.removeEventListener("abort", abortForTeardown);
      controller.signal.removeEventListener("abort", rejectOnAbort);
      if (controller.signal.aborted) {
        // A connector that ignored cancellation may still resolve. Do not leave
        // that late local socket open after either deadline or source teardown.
        void connection.then(
          (socket) => socket.destroy(),
          () => {},
        );
      }
    }
  }

  /**
   * Handle a post-start loss of the on-device server process. Instead of failing
   * the source immediately, attempt a bounded, backed-off relaunch of the server
   * (issue #4742); when the relaunch budget is spent, hand the stream to
   * screenrecord (or fail via `onError` when no fallback is wired). Re-entrant
   * losses while a relaunch is already in flight are ignored — the in-flight
   * recovery owns the lifecycle.
   */
  private handlePostStartServerLoss(error: Error): void {
    if (!this.running || this.relaunching) {
      return;
    }
    this.resetRelaunchBudgetAfterHealthyRun();
    this.relaunching = true;
    this.relaunchAbortController = new AbortController();
    void this.recoverFromServerLoss(error).finally(() => {
      this.relaunching = false;
    });
  }

  private async recoverFromServerLoss(initialError: Error): Promise<void> {
    const signal = this.relaunchAbortController?.signal ?? new AbortController().signal;
    let lastError = initialError;
    while (this.canAttemptRelaunch(signal)) {
      this.serverRelaunchAttempts++;
      const outcome = await this.attemptRelaunch(this.serverRelaunchAttempts, lastError, signal);
      if (outcome.status !== "retry") {
        // "recovered" (streaming again) or "aborted" (stopped mid-relaunch):
        // either way the loop is done and no screenrecord fallback is warranted.
        return;
      }
      lastError = outcome.error;
    }
    if (this.running && !signal.aborted) {
      await this.fallBackAfterRelaunchExhausted(lastError);
    }
  }

  /**
   * A fresh post-start incident that arrives after the server has run
   * healthily for {@link serverRelaunchHealthyWindowMs} since its last
   * successful (re)launch starts a new relaunch budget (issue #7547) — mirrors
   * {@link AndroidH264Source}'s per-segment reset (issue #7548). Checked once
   * per incident (from {@link handlePostStartServerLoss}, which is re-entrancy
   * guarded), never per attempt inside the retry loop, so a device that keeps
   * losing its encoder within the window still exhausts the same budget.
   */
  private resetRelaunchBudgetAfterHealthyRun(): void {
    if (
      this.serverHealthySinceMs !== null &&
      this.timer.now() - this.serverHealthySinceMs >= this.serverRelaunchHealthyWindowMs
    ) {
      this.serverRelaunchAttempts = 0;
    }
  }

  private canAttemptRelaunch(signal: AbortSignal): boolean {
    return (
      this.running &&
      !signal.aborted &&
      this.serverRelaunchAttempts < this.maxServerRelaunchAttempts
    );
  }

  /**
   * Run one relaunch attempt: back off, tear down the dead session, then launch a
   * fresh one. A fresh launch (rather than reusing the retained forward in place)
   * lets the launch-path reconcile sweep any orphan forward/lease the dead server
   * left behind — reuse-in-place is the optional optimization the issue defers.
   */
  private async attemptRelaunch(
    attempt: number,
    lastError: Error,
    signal: AbortSignal,
  ): Promise<{ status: "recovered" | "aborted" | "retry"; error: Error }> {
    const delayMs = this.serverRelaunchBackoff.delayForAttempt(attempt);
    logger.warn(
      `[PersistentEncoderH264Source] on-device server lost post-start (${lastError.message}); ` +
        `relaunch attempt ${attempt}/${this.maxServerRelaunchAttempts} after ${delayMs}ms`,
    );
    await this.delayBeforeRelaunch(delayMs, signal);
    if (!this.running || signal.aborted) {
      return { status: "aborted", error: lastError };
    }
    await this.beginTeardown();
    if (!this.running || signal.aborted) {
      return { status: "aborted", error: lastError };
    }
    try {
      await this.launch();
      if (!this.running) {
        return { status: "aborted", error: lastError };
      }
      this.serverHealthySinceMs = this.timer.now();
      logger.info(
        `[PersistentEncoderH264Source] on-device server relaunched after ${attempt} attempt(s)`,
      );
      return { status: "recovered", error: lastError };
    } catch (error) {
      const relaunchError = error instanceof Error ? error : new Error(String(error));
      logger.warn(
        `[PersistentEncoderH264Source] relaunch attempt ${attempt} failed: ${relaunchError.message}`,
        error,
      );
      return { status: "retry", error: relaunchError };
    }
  }

  /**
   * Wait for the backoff interval before the next relaunch, resolving early if
   * the source is torn down. Zero/negative delays resolve immediately so a
   * disabled backoff does not schedule a needless timer. Deterministic under
   * `FakeTimer`.
   */
  private delayBeforeRelaunch(ms: number, signal: AbortSignal): Promise<void> {
    if (ms <= 0 || signal.aborted) {
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      const finish = (): void => {
        this.timer.clearTimeout(handle);
        signal.removeEventListener("abort", finish);
        resolve();
      };
      const handle = this.timer.setTimeout(finish, ms);
      signal.addEventListener("abort", finish, { once: true });
    });
  }

  /**
   * Relaunch budget spent: hand the stream to screenrecord via the injected
   * fallback (the same mechanism the initial-start path uses), or — when no
   * fallback is wired (e.g. the audio path) or the fallback itself fails —
   * surface the loss via `onError`.
   */
  private async fallBackAfterRelaunchExhausted(error: Error): Promise<void> {
    if (!this.running) {
      return;
    }
    const fallback = this.options.onScreenrecordFallback;
    if (!fallback) {
      this.failIfRunning(error);
      return;
    }
    logger.warn(
      `[PersistentEncoderH264Source] relaunch budget of ${this.maxServerRelaunchAttempts} spent; ` +
        `falling back to screenrecord: ${error.message}`,
    );
    // Stop feeding persistent data and release device resources, but do NOT fire
    // onError: the stream continues on the screenrecord source the fallback owns.
    this.running = false;
    await this.beginTeardown();
    try {
      await fallback(error);
    } catch (fallbackError) {
      this.options.onError?.(
        fallbackError instanceof Error ? fallbackError : new Error(String(fallbackError)),
      );
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
      this.startup.detachServerOutputObserver(server);
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
      await this.leases.cleanupOwnedSession(session, port, deviceProcessId);
      // Release the socket-name claim only after cleanup removed our forward, so
      // a sibling sweep cannot reclaim it during the stop()-during-spawn window.
      this.activeVideoSessionRegistry.remove(this.options.device.deviceId, session.socketName);
    } else if (port !== null) {
      logger.warn(
        `[PersistentEncoderH264Source] refusing forward cleanup port=${port}: session identity is unavailable`,
      );
    }
  }
}
