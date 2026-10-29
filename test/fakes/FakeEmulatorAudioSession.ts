import type { EmulatorAudioSession } from "../../src/features/audio/EmulatorAudioService";
import type {
  AudioInjection,
  InjectAudioOptions,
  InjectionResult,
} from "../../src/utils/android-cmdline-tools/emulatorGrpc/EmulatorAudioClient";
import type { EmulatorGrpcEndpoint } from "../../src/utils/android-cmdline-tools/emulatorGrpc/emulatorGrpcDiscovery";
import type { PcmAudio } from "../../src/utils/audio/pcm";

/** A scripted session: each injection settles when the test resolves or rejects it, or on stop. */
export class FakeEmulatorAudioSession implements EmulatorAudioSession {
  closed = 0;
  injected: PcmAudio[] = [];
  injectOptions: Array<InjectAudioOptions | undefined> = [];
  captureRequests: Array<{ durationMs: number; sampleRate?: number }> = [];
  settleInjection: ((result: InjectionResult) => void) | undefined;
  failInjection: ((error: Error) => void) | undefined;
  captureSamples: Int16Array = new Int16Array(0);
  captureTimedOut = false;

  constructor(readonly endpoint: EmulatorGrpcEndpoint) {}

  async injectAudio(source: PcmAudio, options?: InjectAudioOptions): Promise<AudioInjection> {
    this.injected.push(source);
    this.injectOptions.push(options);
    const done = new Promise<InjectionResult>((resolve, reject) => {
      this.settleInjection = resolve;
      this.failInjection = reject;
    });
    return {
      durationMs: 100,
      sampleRate: source.sampleRate,
      done,
      stop: async () => {
        this.settleInjection?.({ framesQueued: 7, framesPlayed: 0, reason: "stopped" });
        return done;
      },
    };
  }

  async captureAudio(options: { durationMs: number; sampleRate?: number }) {
    this.captureRequests.push(options);
    return {
      pcm: { sampleRate: options.sampleRate ?? 48_000, channels: 1, samples: this.captureSamples },
      timedOut: this.captureTimedOut,
    };
  }

  streamSink: ((pcm: Uint8Array) => void) | undefined;
  streamStops = 0;
  streamStopError: Error | undefined;

  async streamCapture(sink: (pcm: Uint8Array) => void, options: { sampleRate?: number } = {}) {
    this.streamSink = sink;
    return {
      sampleRate: options.sampleRate ?? 48_000,
      stop: async () => {
        this.streamStops++;
        if (this.streamStopError) {
          throw this.streamStopError;
        }
      },
    };
  }

  async close(): Promise<void> {
    this.closed++;
  }
}
