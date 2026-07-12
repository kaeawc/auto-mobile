import { spawn as nodeSpawn } from "node:child_process";
import type { Readable } from "node:stream";
import { ActionableError, type BootedDevice } from "../../models";
import { logger } from "../../utils/logger";
import { defaultTimer, type Timer } from "../../utils/SystemTimer";
import {
  defaultAdbClientFactory,
  type AdbClientFactory,
} from "../../utils/android-cmdline-tools/AdbClientFactory";
import { ANDROID_SCREENRECORD_MAX_SECONDS } from "../video/androidScreenrecord";

/**
 * `screenrecord` enforces a 180s `--time-limit`. Start the next segment a few
 * seconds early so the H.264 stream stays continuous across the rotation
 * boundary. A fresh segment re-emits SPS/PPS + an IDR, which decoders handle.
 */
export const ANDROID_STREAM_SEGMENT_ROTATE_MS = (ANDROID_SCREENRECORD_MAX_SECONDS - 5) * 1000;

/** Minimal child-process surface the source needs, for injectable testing. */
export interface SpawnedProcess {
  stdout: Readable;
  stderr: Readable;
  kill(signal?: NodeJS.Signals): boolean;
  once(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): void;
  once(event: "error", listener: (error: Error) => void): void;
}

export type ProcessSpawner = (command: string, args: string[]) => SpawnedProcess;

const defaultSpawner: ProcessSpawner = (command, args) => {
  const child = nodeSpawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
  // eslint-disable-next-line auto-mobile/no-unknown-cast -- node's ChildProcessByStdio differs from our minimal SpawnedProcess on stdin/once() variance; the members we use (stdout/stderr/kill/once) match.
  return child as unknown as SpawnedProcess;
};

export interface AndroidH264SourceOptions {
  device: BootedDevice;
  /** Called with each chunk of the raw H.264 (Annex-B) elementary stream. */
  onData: (chunk: Buffer) => void;
  /** Called when the source fails fatally (all segments stopped unexpectedly). */
  onError?: (error: Error) => void;
  bitrateBps?: number;
  size?: { width: number; height: number };
  adbFactory?: AdbClientFactory;
  timer?: Timer;
  spawner?: ProcessSpawner;
  /** Override the per-segment time limit (seconds); capped at the screenrecord max. */
  segmentTimeLimitSeconds?: number;
  /** Override when to proactively rotate to the next segment (ms). */
  segmentRotateMs?: number;
}

/**
 * Produces a continuous H.264 Annex-B elementary stream from an Android device
 * by running `adb exec-out screenrecord --output-format=h264 -`. Because
 * `screenrecord` caps each run at 180s, segments are rotated automatically: a
 * new segment is started shortly before the current one hits the cap so the
 * downstream RTP writer keeps receiving frames. The source is device-facing but
 * fully injectable (adb factory, spawner, timer) for tests.
 */
export class AndroidH264Source {
  private readonly options: AndroidH264SourceOptions;
  private readonly adbFactory: AdbClientFactory;
  private readonly timer: Timer;
  private readonly spawner: ProcessSpawner;
  private readonly segmentTimeLimitSeconds: number;
  private readonly segmentRotateMs: number;

  private current: SpawnedProcess | null = null;
  private rotateHandle: NodeJS.Timeout | null = null;
  private running = false;
  private segmentCount = 0;

  constructor(options: AndroidH264SourceOptions) {
    this.options = options;
    this.adbFactory = options.adbFactory ?? defaultAdbClientFactory;
    this.timer = options.timer ?? defaultTimer;
    this.spawner = options.spawner ?? defaultSpawner;
    this.segmentTimeLimitSeconds = Math.min(
      options.segmentTimeLimitSeconds ?? ANDROID_SCREENRECORD_MAX_SECONDS,
      ANDROID_SCREENRECORD_MAX_SECONDS
    );
    this.segmentRotateMs = options.segmentRotateMs ?? ANDROID_STREAM_SEGMENT_ROTATE_MS;
  }

  get segmentsStarted(): number {
    return this.segmentCount;
  }

  get isRunning(): boolean {
    return this.running;
  }

  /** Start capturing. Spawns the first segment and arms segment rotation. */
  async start(): Promise<void> {
    if (this.running) {
      throw new ActionableError("Android H.264 source already started.");
    }
    this.running = true;
    await this.startSegment();
  }

  /** Stop capturing: cancels rotation and terminates the active segment. */
  async stop(): Promise<void> {
    if (!this.running) {
      return;
    }
    this.running = false;
    this.clearRotateTimer();

    const process = this.current;
    this.current = null;
    if (!process) {
      return;
    }

    // Terminate the host `adb exec-out` process; closing the exec stream stops
    // the device-side screenrecord for THIS session. We deliberately do NOT run a
    // device-wide `pkill screenrecord` (unlike the file-recording backend): it
    // would also kill a concurrent `videoRecording` on the same device. Since a
    // live stream writes no file, there is no moov atom to flush cleanly.
    process.kill("SIGINT");
  }

  private async startSegment(): Promise<void> {
    const adb = this.adbFactory.create(this.options.device);
    const adbPath = await adb.getAdbPathOnly();
    const baseArgs = this.options.device.deviceId ? ["-s", this.options.device.deviceId] : [];

    const args = [
      ...baseArgs,
      "exec-out",
      "screenrecord",
      "--output-format=h264",
      "--time-limit",
      String(this.segmentTimeLimitSeconds),
    ];
    if (this.options.bitrateBps && this.options.bitrateBps > 0) {
      args.push("--bit-rate", String(Math.round(this.options.bitrateBps)));
    }
    if (this.options.size) {
      args.push("--size", `${this.options.size.width}x${this.options.size.height}`);
    }
    args.push("-");

    logger.info(
      `[AndroidH264Source] starting screenrecord segment ${this.segmentCount + 1}: ${adbPath} ${args.join(" ")}`
    );

    const process = this.spawner(adbPath, args);
    this.current = process;
    this.segmentCount++;

    process.stdout.on("data", (chunk: Buffer) => {
      // Ignore residual output from a superseded/stopped segment: stop()/rotation
      // clears `current` before the old process finishes exiting, and stale frames
      // must not be written into a freshly reconnected WHIP session.
      if (this.current === process) {
        this.options.onData(chunk);
      }
    });
    process.stderr.on("data", (chunk: Buffer) => {
      const text = chunk.toString().trim();
      if (text) {
        logger.debug(`[AndroidH264Source] screenrecord stderr: ${text}`);
      }
    });
    process.once("error", (error: Error) => {
      logger.warn(`[AndroidH264Source] screenrecord process error: ${error.message}`);
      if (this.running) {
        this.running = false;
        this.clearRotateTimer();
        this.options.onError?.(error);
      }
    });
    process.once("exit", (code, signal) => {
      this.handleSegmentExit(process, code, signal);
    });

    this.armRotateTimer();
  }

  private handleSegmentExit(
    process: SpawnedProcess,
    code: number | null,
    signal: NodeJS.Signals | null
  ): void {
    if (this.current !== process) {
      // A superseded segment (already rotated away from) — ignore.
      return;
    }
    this.current = null;
    this.clearRotateTimer();

    if (!this.running) {
      return;
    }

    // Only rotate on an expected segment boundary: our own SIGINT (rotate timer)
    // or a clean time-limit exit (code 0). A non-zero exit means screenrecord
    // failed (e.g. unsupported --size, encoder error); surface it via onError so
    // the publisher can reconnect/fail instead of tight-looping a broken command.
    const isExpectedRotation = signal === "SIGINT" || code === 0;
    if (!isExpectedRotation) {
      logger.warn(
        `[AndroidH264Source] screenrecord failed (code=${code}, signal=${signal}); not rotating`
      );
      this.running = false;
      this.options.onError?.(new Error(`screenrecord exited with code ${code}`));
      return;
    }

    logger.info(
      `[AndroidH264Source] segment ${this.segmentCount} ended (code=${code}, signal=${signal}); rotating`
    );
    void this.startSegment().catch(error => {
      logger.warn(`[AndroidH264Source] failed to start next segment: ${error}`);
      this.running = false;
      this.options.onError?.(error instanceof Error ? error : new Error(String(error)));
    });
  }

  private armRotateTimer(): void {
    this.clearRotateTimer();
    this.rotateHandle = this.timer.setTimeout(() => {
      const process = this.current;
      if (!this.running || !process) {
        return;
      }
      logger.info(`[AndroidH264Source] rotating segment ${this.segmentCount} before time limit`);
      // Terminating triggers the exit handler, which starts the next segment.
      process.kill("SIGINT");
    }, this.segmentRotateMs);
  }

  private clearRotateTimer(): void {
    if (this.rotateHandle) {
      this.timer.clearTimeout(this.rotateHandle);
      this.rotateHandle = null;
    }
  }
}
