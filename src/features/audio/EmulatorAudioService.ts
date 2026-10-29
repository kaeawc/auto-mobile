import { ActionableError } from "../../models/ActionableError";
import { errorMessage } from "../../models/describeUnknownError";
import { isAndroidEmulatorSerial } from "../../utils/androidSerial";
import type {
  AudioInjection,
  CaptureResult,
  InjectAudioOptions,
  InjectionResult,
} from "../../utils/android-cmdline-tools/emulatorGrpc/EmulatorAudioClient";
import {
  EmulatorAudioError,
  type EmulatorAudioErrorCode,
} from "../../utils/android-cmdline-tools/emulatorGrpc/EmulatorAudioError";
import type {
  EmulatorGrpcDiscovery,
  EmulatorGrpcEndpoint,
} from "../../utils/android-cmdline-tools/emulatorGrpc/emulatorGrpcDiscovery";
import {
  analyzeLevels,
  applyGainDb,
  parseWav,
  sineTone,
  type AudioLevels,
  type PcmAudio,
} from "../../utils/audio/pcm";
import type { IdGenerator } from "../../utils/IdGenerator";
import { logger } from "../../utils/logger";

/** The client calls the service needs; one client per injection or capture. */
export interface EmulatorAudioSession {
  injectAudio(source: PcmAudio, options?: InjectAudioOptions): Promise<AudioInjection>;
  captureAudio(options: { durationMs: number; sampleRate?: number }): Promise<CaptureResult>;
  close(): Promise<void>;
}

export type EmulatorAudioSessionFactory = (endpoint: EmulatorGrpcEndpoint) => EmulatorAudioSession;

export type AudioSource =
  | { kind: "file"; path: string }
  | { kind: "tone"; frequencyHz?: number; durationMs?: number };

export interface StartInjectionRequest extends InjectAudioOptions {
  source: AudioSource;
  gainDb?: number;
  /** The daemon session that started it; its release stops the injection. */
  sessionId?: string;
}

export interface StartedInjection {
  injectionId: string;
  deviceId: string;
  durationMs: number;
  sampleRate: number;
  route: "emulator-grpc";
}

export interface StoppedInjection extends InjectionResult {
  injectionId: string;
}

export interface CaptureRequest {
  durationMs: number;
  silenceThresholdDbfs?: number;
  sampleRate?: number;
}

export interface CapturedAudio extends AudioLevels {
  pcm: PcmAudio;
  /** True when the guest produced less audio than requested before the deadline. */
  timedOut: boolean;
  route: "emulator-grpc";
}

/** Largest source file read into memory: about 4.5 minutes of 48 kHz stereo 16-bit audio. */
export const MAX_AUDIO_SOURCE_BYTES = 50 * 1024 * 1024;
const DEFAULT_TONE_MS = 2_000;
/** A looping injection with no limit of its own stops after this long. */
export const DEFAULT_LOOP_MAX_DURATION_MS = 10 * 60 * 1000;
/** Finished injections kept so a late or repeated stop still returns the result. */
const FINISHED_INJECTIONS_KEPT = 64;

interface ActiveInjection {
  deviceId: string;
  /** The session that started the injection, if any. */
  owner?: string;
  injection: AudioInjection;
  result: Promise<StoppedInjection>;
}

export interface EmulatorAudioServiceDeps {
  discovery: EmulatorGrpcDiscovery;
  createSession: EmulatorAudioSessionFactory;
  readFile: (path: string) => Promise<Uint8Array>;
  fileSize: (path: string) => Promise<number>;
  ids: IdGenerator;
}

function unsupported(code: EmulatorAudioErrorCode, reason: string): EmulatorAudioError {
  return new EmulatorAudioError(code, reason);
}

/**
 * Microphone injection and output capture for Android emulators over each emulator's own gRPC
 * endpoint (#13628, #13629). Tracks live injections by id so a stop is idempotent and a session
 * release can stop everything still playing into a device.
 */
export class EmulatorAudioService {
  private readonly active = new Map<string, ActiveInjection>();
  /** Settled results (success or failure) of ended injections, newest last. */
  private readonly finished = new Map<string, Promise<StoppedInjection>>();

  constructor(private readonly deps: EmulatorAudioServiceDeps) {}

  async startInjection(
    deviceId: string,
    request: StartInjectionRequest,
  ): Promise<StartedInjection> {
    const endpoint = await this.endpointFor(deviceId, "audio_injection_unsupported");
    const pcm = applyGainDb(await this.loadSource(request.source), request.gainDb ?? 0);
    const session = this.deps.createSession(endpoint);
    let injection: AudioInjection;
    try {
      injection = await session.injectAudio(pcm, {
        loop: request.loop,
        startDelayMs: request.startDelayMs,
        maxDurationMs:
          request.maxDurationMs ?? (request.loop ? DEFAULT_LOOP_MAX_DURATION_MS : undefined),
      });
    } catch (error) {
      await session.close();
      throw error;
    }
    const injectionId = this.deps.ids.next();
    const result = this.settle(injectionId, injection, session);
    this.active.set(injectionId, { deviceId, owner: request.sessionId, injection, result });
    const retire = () => {
      this.active.delete(injectionId);
      this.finished.set(injectionId, result);
      while (this.finished.size > FINISHED_INJECTIONS_KEPT) {
        this.finished.delete(this.finished.keys().next().value as string);
      }
    };
    // A failure is reported to whoever stops the injection; here it is only recorded.
    result.then(retire, (error: unknown) => {
      logger.warn(`Audio injection ${injectionId} on ${deviceId} failed: ${errorMessage(error)}`);
      retire();
    });
    return {
      injectionId,
      deviceId,
      durationMs: injection.durationMs,
      sampleRate: injection.sampleRate,
      route: "emulator-grpc",
    };
  }

  /** Ends an injection. Idempotent: a finished or already-stopped id returns its result. */
  async stopInjection(injectionId: string): Promise<StoppedInjection> {
    const done = this.finished.get(injectionId);
    if (done) {
      return done;
    }
    const active = this.active.get(injectionId);
    if (!active) {
      throw new ActionableError(
        `No audio injection '${injectionId}'. It may belong to a server that has since restarted; start a new injection.`,
      );
    }
    await active.injection.stop().catch((error: unknown) => {
      // The settled result below carries the failure to the caller.
      logger.debug(`audio injection ${injectionId} stop: ${errorMessage(error)}`);
    });
    return active.result;
  }

  /** Stops every injection on a device. Never throws. */
  stopDevice(deviceId: string): Promise<number> {
    return this.stopMatching((entry) => entry.deviceId === deviceId);
  }

  /**
   * Stops the injections a session started on a device, for session release. Undefined when it
   * owns none, so release registers no cleanup.
   */
  stopOwnedBy(deviceId: string, sessionId: string): Promise<number> | undefined {
    const owned = (entry: ActiveInjection) =>
      entry.deviceId === deviceId && entry.owner === sessionId;
    return [...this.active.values()].some(owned) ? this.stopMatching(owned) : undefined;
  }

  private async stopMatching(match: (entry: ActiveInjection) => boolean): Promise<number> {
    const ids = [...this.active].filter(([, entry]) => match(entry)).map(([id]) => id);
    await Promise.all(
      ids.map((id) =>
        this.stopInjection(id).catch((error: unknown) => {
          logger.warn(`Failed to stop audio injection ${id}: ${errorMessage(error)}`);
        }),
      ),
    );
    return ids.length;
  }

  activeInjectionIds(deviceId: string): string[] {
    return [...this.active].filter(([, entry]) => entry.deviceId === deviceId).map(([id]) => id);
  }

  async capture(deviceId: string, request: CaptureRequest): Promise<CapturedAudio> {
    const endpoint = await this.endpointFor(deviceId, "audio_capture_unsupported");
    const session = this.deps.createSession(endpoint);
    try {
      const { pcm, timedOut } = await session.captureAudio({
        durationMs: request.durationMs,
        sampleRate: request.sampleRate,
      });
      const levels = analyzeLevels(pcm, { silenceThresholdDbfs: request.silenceThresholdDbfs });
      return { ...levels, pcm, timedOut, route: "emulator-grpc" };
    } finally {
      await session.close();
    }
  }

  private async settle(
    injectionId: string,
    injection: AudioInjection,
    session: EmulatorAudioSession,
  ): Promise<StoppedInjection> {
    try {
      return { injectionId, ...(await injection.done) };
    } finally {
      await session.close();
    }
  }

  private async endpointFor(
    deviceId: string,
    code: EmulatorAudioErrorCode,
  ): Promise<EmulatorGrpcEndpoint> {
    if (!isAndroidEmulatorSerial(deviceId)) {
      throw unsupported(
        code,
        `Audio injection and capture use the Android emulator's gRPC audio API; '${deviceId}' is not a local emulator.`,
      );
    }
    const consolePort = Number.parseInt(deviceId.slice("emulator-".length), 10);
    const endpoint = await this.deps.discovery.findByConsolePort(consolePort);
    if (!endpoint) {
      throw unsupported(
        code,
        `Emulator ${deviceId} does not advertise a gRPC endpoint. Use an emulator build with gRPC ` +
          "enabled (the default on recent builds) running on this host.",
      );
    }
    return endpoint;
  }

  private async loadSource(source: AudioSource): Promise<PcmAudio> {
    if (source.kind === "tone") {
      return sineTone({
        frequencyHz: source.frequencyHz,
        durationMs: source.durationMs ?? DEFAULT_TONE_MS,
      });
    }
    const size = await this.deps.fileSize(source.path);
    if (size > MAX_AUDIO_SOURCE_BYTES) {
      throw new ActionableError(
        `Audio file ${source.path} is ${size} bytes; the limit is ${MAX_AUDIO_SOURCE_BYTES}. Use a shorter clip.`,
      );
    }
    return parseWav(await this.deps.readFile(source.path));
  }
}
