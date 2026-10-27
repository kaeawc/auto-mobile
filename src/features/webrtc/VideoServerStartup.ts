import { ActionableError } from "../../models";
import type { AdbProcess } from "../../utils/android-cmdline-tools/interfaces/AdbExecutor";
import { type Timer } from "../../utils/SystemTimer";
import type {
  PersistentEncoderH264SourceOptions,
  VideoServerSession,
} from "./PersistentEncoderH264Source";
import {
  VIDEO_SERVER_CODEC_ID_PCM16,
  type VideoServerPacket,
  type VideoServerStreamHeader,
} from "./VideoServerStreamParser";

// The optional trailing `proto=<v>` is the handshake version negotiation channel
// (issue #4729): a pre-handshake device omits it, a handshake-capable device
// advertises it. Non-greedy socket capture so the optional group binds correctly.
const SESSION_READY_PATTERN =
  /^VIDEO_SESSION_READY token=([^ ]+) pid=(\d+) socket=([^ ]+?)(?: proto=(\d+))?$/;

/** Server stdout line printed after capture has fully started. */
const STREAMING_STARTED_MARKER = "Streaming started";

const VIDEO_STATS_PATTERN = /(?:^|\s)dropped=(\d+)(?:\s|$)/;
export class VideoServerStartup {
  resolveStartupAudioHeader: ((header: VideoServerStreamHeader) => void) | undefined;
  resolveStartupAudioPacket: ((packet: VideoServerPacket) => void) | undefined;
  private serverOutputObserver: ((chunk: Buffer) => void) | null = null;
  private serverOutputBuffer = "";
  private sawStreamingStarted = false;
  constructor(
    private readonly options: PersistentEncoderH264SourceOptions,
    private readonly timer: Timer,
    private readonly readyTimeoutMs: number,
    private readonly session: () => VideoServerSession | null,
  ) {}

  waitForReady(server: AdbProcess): Promise<{ pid: number; protocolVersion: number | null }> {
    const token = this.session()?.token;
    if (!token) {
      throw new Error("Video server session token was unavailable.");
    }
    return new Promise<{ pid: number; protocolVersion: number | null }>((resolve, reject) => {
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
                "Set AUTOMOBILE_VIDEO_SERVER_JAR to a current automobile-video.jar.",
            ),
          ),
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
          if (match[1] !== token || match[3] !== this.session()?.socketName) {
            finish(() =>
              reject(
                new ActionableError(
                  `video-server session readiness token mismatch (expected=${token}, got=${match[1]})`,
                ),
              ),
            );
            return;
          }
          const pid = Number.parseInt(match[2], 10);
          if (!Number.isInteger(pid) || pid <= 0) {
            finish(() =>
              reject(new ActionableError("video-server returned an invalid session PID")),
            );
            return;
          }
          const protocolVersion = match[4] !== undefined ? Number.parseInt(match[4], 10) : null;
          finish(() => resolve({ pid, protocolVersion }));
          return;
        }
      };
      const onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
        finish(() =>
          reject(new Error(`video-server exited before ready (code=${code}, signal=${signal})`)),
        );
      };
      const onError = (error: Error): void => finish(() => reject(error));

      server.stdout.on("data", onData);
      server.once("exit", onExit);
      server.once("error", onError);
    });
  }

  waitForStreamingStarted(server: AdbProcess): Promise<void> {
    if (this.sawStreamingStarted) {
      return Promise.resolve();
    }
    return this.waitForServerLine(
      server,
      STREAMING_STARTED_MARKER,
      `video-server did not start streaming within ${this.readyTimeoutMs}ms`,
      "video-server exited before streaming started",
    );
  }

  waitForStartupAudioReady(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      let muxAudioHeaderSeen = false;
      const timeout = this.timer.setTimeout(() => {
        finish(() =>
          reject(
            new ActionableError(
              `video-server did not produce PCM audio within ${this.readyTimeoutMs}ms`,
            ),
          ),
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

      this.resolveStartupAudioHeader = (header) => {
        if (header.muxed === true && header.audio === true) {
          muxAudioHeaderSeen = true;
          return;
        }
        finish(() => {
          reject(
            new ActionableError(
              "Audio was requested, but video-server did not advertise muxed PCM audio. Rebuild or provide a current automobile-video.jar.",
            ),
          );
        });
      };

      this.resolveStartupAudioPacket = (packet) => {
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
    exitMessagePrefix: string,
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
        finish(() => reject(new Error(`${exitMessagePrefix} (code=${code}, signal=${signal})`)));
      };
      const onError = (error: Error): void => finish(() => reject(error));

      server.stdout.on("data", onData);
      server.once("exit", onExit);
      server.once("error", onError);
    });
  }

  attachServerOutputObserver(server: AdbProcess): void {
    this.serverOutputBuffer = "";
    this.sawStreamingStarted = false;
    const observer = (chunk: Buffer): void => {
      this.serverOutputBuffer += chunk.toString();
      const lines = this.serverOutputBuffer.split(/\r?\n/);
      this.serverOutputBuffer = lines.pop() ?? "";
      if (lines.includes(STREAMING_STARTED_MARKER)) {
        this.sawStreamingStarted = true;
      }
      for (const line of lines) {
        if (!line.startsWith("VIDEO_STATS ")) {
          continue;
        }
        const match = VIDEO_STATS_PATTERN.exec(line);
        const droppedFrames = match ? Number(match[1]) : NaN;
        if (Number.isSafeInteger(droppedFrames) && droppedFrames >= 0) {
          this.options.onDroppedFrames?.(droppedFrames);
        }
      }
    };
    this.serverOutputObserver = observer;
    server.stdout.on("data", observer);
  }

  detachServerOutputObserver(server: AdbProcess): void {
    if (this.serverOutputObserver) {
      server.stdout.off("data", this.serverOutputObserver);
    }
    this.serverOutputObserver = null;
    this.serverOutputBuffer = "";
    this.sawStreamingStarted = false;
  }
}
