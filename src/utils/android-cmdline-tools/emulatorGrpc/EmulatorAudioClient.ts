import { errorMessage } from "../../../models/describeUnknownError";
import { durationMs, resampleMono, toMono, type PcmAudio } from "../../audio/pcm";
import { logger } from "../../logger";
import { defaultTimer, type Timer } from "../../SystemTimer";
import type { GrpcAuthorizer } from "./emulatorGrpcAuth";
import {
  decodeAudioPacket,
  EMULATOR_MAX_SAMPLING_RATE,
  encodeAudioFormat,
  encodeAudioPacket,
  type EmulatorAudioFormat,
} from "./emulatorAudioMessages";
import { captureError, injectionError } from "./EmulatorAudioError";
import { GrpcStatus } from "./grpcFraming";
import type { GrpcCall, GrpcTransport } from "./grpcTransport";
import { SilenceFiller } from "./SilenceFiller";

const SERVICE = "/android.emulation.control.EmulatorController";
export const INJECT_AUDIO_METHOD = `${SERVICE}/injectAudio`;
export const STREAM_AUDIO_METHOD = `${SERVICE}/streamAudio`;

/** Packet length for injection. The emulator buffers ~300ms and rejects oversized packets. */
const INJECT_PACKET_MS = 20;
/** How long capture waits past the requested duration before reporting what it has. */
const CAPTURE_GRACE_MS = 2_000;
/** Mono 16-bit PCM at a rate the emulator accepts, the one format injection sends. */
export function prepareForInjection(pcm: PcmAudio): PcmAudio {
  const mono = toMono(pcm);
  return mono.sampleRate > EMULATOR_MAX_SAMPLING_RATE
    ? resampleMono(mono, EMULATOR_MAX_SAMPLING_RATE)
    : mono;
}

function pcmBytes(samples: Int16Array): Uint8Array {
  const bytes = new Uint8Array(samples.length * 2);
  const view = new DataView(bytes.buffer);
  for (let index = 0; index < samples.length; index++) {
    view.setInt16(index * 2, samples[index], true);
  }
  return bytes;
}

function samplesFromBytes(bytes: Uint8Array): Int16Array {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const samples = new Int16Array(Math.floor(bytes.byteLength / 2));
  for (let index = 0; index < samples.length; index++) {
    samples[index] = view.getInt16(index * 2, true);
  }
  return samples;
}

export interface InjectAudioOptions {
  loop?: boolean;
  startDelayMs?: number;
  /** Stop after this long even when looping. */
  maxDurationMs?: number;
}

export interface InjectionResult {
  framesSent: number;
  /** Why streaming ended: the clip finished, `stop()` was called, or the max duration elapsed. */
  reason: "completed" | "stopped" | "max_duration";
}

export interface AudioInjection {
  readonly durationMs: number;
  readonly sampleRate: number;
  /** Settles when streaming ends; rejects with an {@link EmulatorAudioError} on a gRPC failure. */
  readonly done: Promise<InjectionResult>;
  /** Ends the stream early. Idempotent; resolves with the same result as `done`. */
  stop(): Promise<InjectionResult>;
}

type EarlyEnd = Exclude<InjectionResult["reason"], "completed">;

/** The one way an injection ends early: stop() or the max-duration deadline. */
interface InjectionControl {
  readonly endReason: EarlyEnd | undefined;
  /** Resolves when the injection is ended early. */
  readonly ended: Promise<void>;
  /** Records the first reason and cancels the call, which also fails a write parked on back-pressure. */
  end(reason: EarlyEnd): void;
}

function createInjectionControl(call: GrpcCall): InjectionControl {
  let endReason: EarlyEnd | undefined;
  let resolveEnded!: () => void;
  const ended = new Promise<void>((resolve) => {
    resolveEnded = resolve;
  });
  return {
    get endReason() {
      return endReason;
    },
    ended,
    end(reason) {
      if (endReason) {
        return;
      }
      endReason = reason;
      call.cancel();
      resolveEnded();
    },
  };
}

interface InjectionRun {
  call: GrpcCall;
  pcm: PcmAudio;
  options: InjectAudioOptions;
  control: InjectionControl;
  framesSent: number;
}

export interface CaptureAudioOptions {
  durationMs: number;
  sampleRate?: number;
}

/** An open-ended capture; PCM is 16-bit little-endian mono at `sampleRate`. */
export interface AudioStream {
  readonly sampleRate: number;
  /**
   * Ends the capture and resolves once the last PCM was delivered. Idempotent. Rejects when the
   * capture delivered nothing because the device refused it.
   */
  stop(): Promise<void>;
}

export interface CaptureResult {
  pcm: PcmAudio;
  /** True when the guest produced fewer frames than requested before the deadline. */
  timedOut: boolean;
}

/**
 * The emulator's gRPC audio RPCs for one emulator. Each emulator has its own gRPC port, so
 * injection and capture are isolated per instance with no host audio stack involved.
 */
export class EmulatorAudioClient {
  constructor(
    private readonly transport: GrpcTransport,
    private readonly authorizer: GrpcAuthorizer,
    private readonly timer: Pick<Timer, "now" | "setTimeout" | "clearTimeout"> = defaultTimer,
  ) {}

  async injectAudio(source: PcmAudio, options: InjectAudioOptions = {}): Promise<AudioInjection> {
    const pcm = prepareForInjection(source);
    const call = await this.open(INJECT_AUDIO_METHOD);
    const control = createInjectionControl(call);
    const done = this.streamInjection(call, pcm, options, control);
    // Keep an unobserved failure from becoming an unhandled rejection; callers read it via done/stop.
    done.catch((error: unknown) =>
      logger.debug(`audio injection ended with ${errorMessage(error)}`),
    );
    return {
      durationMs: durationMs(pcm),
      sampleRate: pcm.sampleRate,
      done,
      stop: () => {
        control.end("stopped");
        return done;
      },
    };
  }

  async captureAudio(options: CaptureAudioOptions): Promise<CaptureResult> {
    const sampleRate = Math.min(
      options.sampleRate ?? EMULATOR_MAX_SAMPLING_RATE,
      EMULATOR_MAX_SAMPLING_RATE,
    );
    const format: EmulatorAudioFormat = {
      samplingRate: sampleRate,
      channels: "mono",
      format: "s16",
    };
    const call = await this.open(STREAM_AUDIO_METHOD);
    await call.write(encodeAudioFormat(format));
    call.end();
    const wanted = Math.round((options.durationMs / 1000) * sampleRate);
    // streamAudio can block forever on a silent guest, so the deadline cancels the call.
    let timedOut = false;
    const deadline = this.timer.setTimeout(() => {
      timedOut = true;
      call.cancel();
    }, options.durationMs + CAPTURE_GRACE_MS);
    const chunks: Int16Array[] = [];
    let collected = 0;
    try {
      for await (const message of call.messages()) {
        const samples = samplesFromBytes(decodeAudioPacket(message).audio);
        chunks.push(samples);
        collected += samples.length;
        if (collected >= wanted) {
          call.cancel();
          break;
        }
      }
    } finally {
      this.timer.clearTimeout(deadline);
    }
    const status = await call.status();
    if (
      collected === 0 &&
      !timedOut &&
      status.code !== GrpcStatus.OK &&
      status.code !== GrpcStatus.CANCELLED
    ) {
      throw captureError(status);
    }
    const samples = new Int16Array(Math.min(collected, wanted));
    let offset = 0;
    for (const chunk of chunks) {
      const take = chunk.subarray(0, samples.length - offset);
      samples.set(take, offset);
      offset += take.length;
    }
    return { pcm: { sampleRate, channels: 1, samples }, timedOut: timedOut && collected < wanted };
  }

  /**
   * Streams the emulator's audio output to `sink` until stopped, for recordings of any length. A
   * silent guest sends no packets, so its quiet stretches are filled with silence to keep the PCM
   * in step with the wall clock.
   */
  async streamCapture(
    sink: (pcm: Uint8Array) => void,
    options: { sampleRate?: number } = {},
  ): Promise<AudioStream> {
    const sampleRate = Math.min(
      options.sampleRate ?? EMULATOR_MAX_SAMPLING_RATE,
      EMULATOR_MAX_SAMPLING_RATE,
    );
    const call = await this.open(STREAM_AUDIO_METHOD);
    await call.write(
      encodeAudioFormat({ samplingRate: sampleRate, channels: "mono", format: "s16" }),
    );
    call.end();
    const filler = new SilenceFiller(sampleRate, () => this.timer.now() * 1000);
    let delivered = 0;
    const pump = (async () => {
      try {
        for await (const message of call.messages()) {
          const packet = decodeAudioPacket(message);
          const silence = filler.before(packet);
          if (silence) {
            sink(silence);
          }
          delivered += packet.audio.byteLength;
          sink(packet.audio);
        }
      } catch (error) {
        // The call status, read at stop, says whether this was the cancel or a failure.
        logger.debug(`audio stream ended: ${errorMessage(error)}`);
      }
    })();
    let stopping: Promise<void> | undefined;
    const stop = async (): Promise<void> => {
      call.cancel();
      await pump;
      if (delivered > 0) {
        return;
      }
      const status = await call.status();
      if (status.code !== GrpcStatus.OK && status.code !== GrpcStatus.CANCELLED) {
        throw captureError(status);
      }
    };
    return {
      sampleRate,
      stop: () => {
        stopping ??= stop();
        return stopping;
      },
    };
  }

  async close(): Promise<void> {
    this.transport.close();
    await this.authorizer.dispose();
  }

  private async open(method: string): Promise<GrpcCall> {
    const authorization = await this.authorizer.authorization(method);
    return this.transport.open(method, authorization ? { authorization } : {});
  }

  private async streamInjection(
    call: GrpcCall,
    pcm: PcmAudio,
    options: InjectAudioOptions,
    control: InjectionControl,
  ): Promise<InjectionResult> {
    const run: InjectionRun = { call, pcm, options, control, framesSent: 0 };
    // A timer, not a check between writes, so it also ends a write parked on back-pressure.
    const deadline =
      options.maxDurationMs === undefined
        ? undefined
        : this.timer.setTimeout(() => control.end("max_duration"), options.maxDurationMs);
    try {
      if (options.startDelayMs) {
        await this.delayUnlessEnded(options.startDelayMs, control);
      }
      await this.sendAll(run);
    } finally {
      if (deadline) {
        this.timer.clearTimeout(deadline);
      }
    }
    call.end();
    const status = await call.status();
    if (status.code !== GrpcStatus.OK && status.code !== GrpcStatus.CANCELLED) {
      throw injectionError(status);
    }
    return { framesSent: run.framesSent, reason: control.endReason ?? "completed" };
  }

  private async sendAll(run: InjectionRun): Promise<void> {
    try {
      let finished = false;
      do {
        finished = await this.sendPass(run);
      } while (finished && run.options.loop && run.pcm.samples.length > 0);
    } catch (error) {
      // A write fails once the server has closed or the stream was cancelled; the call status
      // and the end reason say which.
      logger.debug(`audio injection write ended: ${errorMessage(error)}`);
    }
  }

  /** Waits `ms`, or less when the injection ends first, so stop() never waits out a start delay. */
  private delayUnlessEnded(ms: number, control: InjectionControl): Promise<void> {
    return new Promise((resolve) => {
      const handle = this.timer.setTimeout(resolve, ms);
      void control.ended.then(() => {
        this.timer.clearTimeout(handle);
        resolve();
      });
    });
  }

  /** Sends the clip once; true when it finished, false when the injection ended first. */
  private async sendPass(run: InjectionRun): Promise<boolean> {
    const { pcm } = run;
    const format: EmulatorAudioFormat = {
      samplingRate: pcm.sampleRate,
      channels: "mono",
      format: "s16",
    };
    const packetSamples = Math.max(1, Math.round((INJECT_PACKET_MS / 1000) * pcm.sampleRate));
    for (let start = 0; start < pcm.samples.length; start += packetSamples) {
      if (run.control.endReason) {
        return false;
      }
      const audio = pcmBytes(pcm.samples.subarray(start, start + packetSamples));
      // Only the first packet's format is honored by the emulator.
      await run.call.write(
        encodeAudioPacket({
          format: run.framesSent === 0 ? format : undefined,
          timestampUs: this.timer.now() * 1000,
          audio,
        }),
      );
      run.framesSent += audio.byteLength / 2;
    }
    return true;
  }
}
