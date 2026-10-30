import type {
  AudioInjection,
  AudioStream,
  CaptureResult,
  PcmSink,
  InjectAudioOptions,
  InjectionResult,
} from "../../utils/android-cmdline-tools/emulatorGrpc/EmulatorAudioClient";
import {
  EmulatorAudioError,
  type EmulatorAudioErrorCode,
} from "../../utils/android-cmdline-tools/emulatorGrpc/EmulatorAudioError";
import { durationMs, resampleMono, toMono, type PcmAudio } from "../../utils/audio/pcm";
import { defaultTimer, type Timer } from "../../utils/SystemTimer";
import type { EmulatorAudioSession } from "./EmulatorAudioService";
import {
  startLoopbackHelper,
  type LoopbackHelperProcess,
  type LoopbackHelperSpawner,
  type LoopbackOperation,
  type RunningLoopbackHelper,
} from "./loopbackHelperProcess";

/** The helper's PCM range; anything outside is resampled to the top of it. */
const MIN_SAMPLE_RATE = 8_000;
const MAX_SAMPLE_RATE = 48_000;
const CAPTURE_SAMPLE_RATE = 48_000;
/** Writes are paced by the pipe; 100 ms chunks keep a stop prompt. */
const CHUNK_MS = 100;
/** Extra time past the requested capture before it counts as timed out. */
const CAPTURE_GRACE_MS = 5_000;
/** How long an open-ended capture may take to finish after stdin closes before it is killed. */
const STREAM_STOP_GRACE_MS = 2_000;
/** How long to wait, after the helper exits, for its stdout to deliver the last PCM. */
export const CAPTURE_DRAIN_MS = 1_000;

export interface HostLoopbackAudioSessionDeps {
  /** The helper executable, or undefined when none is configured. */
  helperPath: () => string | undefined;
  launchHelper: LoopbackHelperSpawner;
  timer?: Pick<Timer, "now" | "monotonicNow" | "setTimeout" | "clearTimeout">;
}

type EarlyEnd = Exclude<InjectionResult["reason"], "completed">;

function helperMissing(code: EmulatorAudioErrorCode, envName: string): EmulatorAudioError {
  return new EmulatorAudioError(
    code,
    "iOS Simulator audio needs the audio-loopback helper on a macOS host. Set " +
      `${envName} to the path of an audio-loopback-helper executable.`,
  );
}

function helperRate(sampleRate: number): number {
  return sampleRate < MIN_SAMPLE_RATE || sampleRate > MAX_SAMPLE_RATE
    ? MAX_SAMPLE_RATE
    : sampleRate;
}

function chunksOf(samples: Int16Array, framesPerChunk: number): Uint8Array[] {
  const chunks: Uint8Array[] = [];
  for (let start = 0; start < samples.length; start += framesPerChunk) {
    const part = samples.subarray(start, start + framesPerChunk);
    chunks.push(new Uint8Array(part.buffer, part.byteOffset, part.byteLength));
  }
  return chunks;
}

/** Resolves once `stdin` accepted the chunk, or when the injection ends while it waits. */
function write(
  stdin: LoopbackHelperProcess["stdin"],
  chunk: Uint8Array,
  ended: Promise<void>,
): Promise<void> {
  return new Promise<void>((resolve) => {
    void ended.then(resolve);
    if (stdin.write(chunk)) {
      resolve();
    } else {
      stdin.once("drain", () => resolve());
    }
  });
}

/**
 * An iOS Simulator's microphone and speaker through the host's CoreAudio loopback devices (#13628,
 * #13629). The simulator records from the host default input and plays to the host default output, so
 * the helper plays into the default input's loopback device and reads back the default output's. Those
 * devices are shared by every simulator on the host; the service allows one injection at a time.
 */
export class HostLoopbackAudioSession implements EmulatorAudioSession {
  private readonly timer: Pick<Timer, "now" | "monotonicNow" | "setTimeout" | "clearTimeout">;
  private readonly live = new Set<LoopbackHelperProcess>();

  constructor(
    private readonly deps: HostLoopbackAudioSessionDeps,
    private readonly envName: string,
  ) {
    this.timer = deps.timer ?? defaultTimer;
  }

  async injectAudio(source: PcmAudio, options: InjectAudioOptions = {}): Promise<AudioInjection> {
    const mono = toMono(source);
    const pcm =
      helperRate(mono.sampleRate) === mono.sampleRate
        ? mono
        : resampleMono(mono, helperRate(mono.sampleRate));
    const helper = await this.start("inject", ["play", "--sample-rate", String(pcm.sampleRate)]);
    let endReason: EarlyEnd | undefined;
    // Halted stops feeding: an early end, or the helper exiting (a crash must not leave a write waiting).
    let halted = false;
    let signalHalt: () => void = () => {};
    const ended = new Promise<void>((resolve) => {
      signalHalt = resolve;
    });
    const halt = () => {
      halted = true;
      signalHalt();
    };
    const end = (reason: EarlyEnd) => {
      if (endReason === undefined) {
        endReason = reason;
        halt();
        helper.process.kill("SIGTERM");
      }
    };
    const limit =
      options.maxDurationMs === undefined
        ? undefined
        : this.timer.setTimeout(() => end("max_duration"), options.maxDurationMs);
    let framesQueued = 0;
    let playbackStartMs: number | undefined;
    const feeding = this.feed(helper, pcm, options, ended, () => halted, {
      started: () => {
        playbackStartMs ??= this.timer.monotonicNow?.() ?? this.timer.now();
      },
      queued: (frames) => {
        framesQueued += frames;
      },
    });
    const done = (async (): Promise<InjectionResult> => {
      const exitCode = await helper.exited;
      halt();
      if (limit) {
        this.timer.clearTimeout(limit);
      }
      await feeding;
      const framesPlayed = this.framesPlayed(playbackStartMs, framesQueued, pcm.sampleRate);
      if (endReason) {
        return { framesQueued, framesPlayed, reason: endReason };
      }
      if (exitCode === 0) {
        return { framesQueued, framesPlayed, reason: "completed" };
      }
      throw helper.failure();
    })();
    return {
      durationMs: durationMs(pcm),
      sampleRate: pcm.sampleRate,
      done,
      stop: async () => {
        end("stopped");
        return done;
      },
    };
  }

  private framesPlayed(
    playbackStartMs: number | undefined,
    framesQueued: number,
    sampleRate: number,
  ): number {
    if (playbackStartMs === undefined) {
      return 0;
    }
    const now = this.timer.monotonicNow?.() ?? this.timer.now();
    const elapsedMs = Math.max(0, now - playbackStartMs);
    const rendered = Math.floor((elapsedMs * sampleRate) / 1000);
    return Math.min(framesQueued, rendered);
  }

  async captureAudio(options: { durationMs: number; sampleRate?: number }): Promise<CaptureResult> {
    const sampleRate = helperRate(options.sampleRate ?? CAPTURE_SAMPLE_RATE);
    const received: Uint8Array[] = [];
    const helper = await this.start(
      "capture",
      ["capture", "--duration-ms", String(options.durationMs), "--sample-rate", String(sampleRate)],
      (chunk) => {
        received.push(chunk);
      },
    );
    let timedOut = false;
    const deadline = this.timer.setTimeout(() => {
      timedOut = true;
      helper.process.kill("SIGTERM");
    }, options.durationMs + CAPTURE_GRACE_MS);
    const exitCode = await helper.exited;
    this.timer.clearTimeout(deadline);
    if (!timedOut && exitCode !== 0) {
      throw helper.failure();
    }
    await this.untilOutputEnded(helper);
    const bytes = Buffer.concat(received);
    const samples = new Int16Array(
      bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + (bytes.byteLength & ~1)),
    );
    const expected = Math.floor((options.durationMs * sampleRate) / 1000);
    return {
      pcm: { sampleRate, channels: 1, samples },
      timedOut: timedOut || samples.length < expected,
    };
  }

  async streamCapture(sink: PcmSink, options: { sampleRate?: number } = {}): Promise<AudioStream> {
    const sampleRate = helperRate(options.sampleRate ?? CAPTURE_SAMPLE_RATE);
    const helper = await this.start(
      "capture",
      ["capture", "--until-stopped", "--sample-rate", String(sampleRate)],
      sink,
    );
    // Closing stdin asks the helper to write its last buffer and exit; a kill is the fallback. Only
    // a clean exit whose output has ended is a complete capture: a signal (the fallback kill or a
    // crash) or a pipe still open after the drain wait means the tail may be missing (#15860).
    const stop = async (): Promise<void> => {
      helper.process.stdin.end();
      const kill = this.timer.setTimeout(
        () => helper.process.kill("SIGTERM"),
        STREAM_STOP_GRACE_MS,
      );
      const exitCode = await helper.exited;
      this.timer.clearTimeout(kill);
      const ended = await this.untilOutputEnded(helper);
      if (exitCode !== 0) {
        throw helper.failure();
      }
      if (!ended) {
        throw new EmulatorAudioError(
          "audio_loopback_failed",
          `The audio-loopback helper's output did not finish within ${CAPTURE_DRAIN_MS} ms of ` +
            "its exit, so the end of the capture may be missing.",
        );
      }
    };
    let stopping: Promise<void> | undefined;
    return {
      sampleRate,
      stop: () => {
        stopping ??= stop();
        return stopping;
      },
    };
  }

  /**
   * Waits for the last PCM after exit, bounded so a pipe that never closes cannot hang the call.
   * Resolves true when the output ended, false when the wait ran out.
   */
  private untilOutputEnded(helper: RunningLoopbackHelper): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      const handle = this.timer.setTimeout(() => resolve(false), CAPTURE_DRAIN_MS);
      void helper.outputEnded.then(() => {
        this.timer.clearTimeout(handle);
        resolve(true);
      });
    });
  }

  async close(): Promise<void> {
    for (const child of this.live) {
      child.kill("SIGTERM");
    }
    this.live.clear();
  }

  private async start(
    operation: LoopbackOperation,
    args: string[],
    onStdout?: PcmSink,
  ): Promise<RunningLoopbackHelper> {
    const path = this.deps.helperPath();
    if (!path) {
      throw helperMissing(
        operation === "inject" ? "audio_injection_unsupported" : "audio_capture_unsupported",
        this.envName,
      );
    }
    const helper = await startLoopbackHelper({
      launch: () => this.deps.launchHelper(path, args),
      operation,
      timer: this.timer,
      onStdout,
    });
    this.live.add(helper.process);
    void helper.exited.then(() => this.live.delete(helper.process));
    return helper;
  }

  /** Writes the clip (repeatedly when looping) after the start delay, then closes stdin. */
  private async feed(
    helper: RunningLoopbackHelper,
    pcm: PcmAudio,
    options: InjectAudioOptions,
    ended: Promise<void>,
    isEnded: () => boolean,
    progress: { started(): void; queued(frames: number): void },
  ): Promise<void> {
    const delayMs = options.startDelayMs;
    if (delayMs) {
      // Ends early when the injection does, so stop() never waits out a start delay.
      await new Promise<void>((resolve) => {
        const handle = this.timer.setTimeout(resolve, delayMs);
        void ended.then(() => {
          this.timer.clearTimeout(handle);
          resolve();
        });
      });
    }
    const framesPerChunk = Math.max(1, Math.round((pcm.sampleRate * CHUNK_MS) / 1000));
    const chunks = chunksOf(pcm.samples, framesPerChunk);
    const stdin = helper.process.stdin;
    if (chunks.length === 0) {
      stdin.end();
      return;
    }
    do {
      for (const chunk of chunks) {
        if (isEnded()) {
          return;
        }
        progress.started();
        await write(stdin, chunk, ended);
        progress.queued(chunk.byteLength / 2);
      }
    } while (options.loop && !isEnded());
    if (!isEnded()) {
      stdin.end();
    }
  }
}
