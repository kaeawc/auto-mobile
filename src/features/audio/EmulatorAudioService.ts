import { ActionableError } from "../../models/ActionableError";
import { errorMessage } from "../../models/describeUnknownError";
import { isAndroidEmulatorSerial } from "../../utils/androidSerial";
import { resolveIosDeviceKind } from "../../utils/ios-cmdline-tools/IosDeviceKind";
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

/**
 * How audio reaches the device: an emulator's own gRPC audio API, or for an iOS Simulator the host's
 * CoreAudio loopback devices, which every simulator on the host shares.
 */
export type AudioRoute = "emulator-grpc" | "host-loopback";

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
  route: AudioRoute;
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
  route: AudioRoute;
}

/** Largest source file read into memory: about 4.5 minutes of 48 kHz stereo 16-bit audio. */
export const MAX_AUDIO_SOURCE_BYTES = 50 * 1024 * 1024;
const DEFAULT_TONE_MS = 2_000;
/** A looping injection with no limit of its own stops after this long. */
export const DEFAULT_LOOP_MAX_DURATION_MS = 10 * 60 * 1000;
/** Ended injections kept so a late or repeated stop still returns the result. */
export const FINISHED_INJECTIONS_KEPT = 64;

interface ActiveInjection {
  deviceId: string;
  route: AudioRoute;
  /** The session that started the injection, if any. */
  owner?: string;
  injection: AudioInjection;
  result: Promise<StoppedInjection>;
}

export interface EmulatorAudioServiceDeps {
  discovery: EmulatorGrpcDiscovery;
  createSession: EmulatorAudioSessionFactory;
  /** A session over the host loopback devices, for iOS Simulators; absent where there is none. */
  createHostLoopbackSession?: () => EmulatorAudioSession;
  /**
   * Reads a regular file, refusing it once it exceeds `maxBytes`. The cap must hold for the read
   * itself, not a prior size check: a device file such as /dev/zero reports size 0.
   */
  readFile: (path: string, maxBytes: number) => Promise<Uint8Array>;
  ids: IdGenerator;
  /** Defaults to {@link MAX_AUDIO_SOURCE_BYTES}. */
  maxSourceBytes?: number;
}

function assertSameDevice(injectionId: string, owner: string, requested: string | undefined): void {
  if (requested !== undefined && owner !== requested) {
    throw new ActionableError(
      `Audio injection '${injectionId}' is on ${owner}, not ${requested}. Stop it on ${owner}.`,
    );
  }
}

export function audioSourceTooLarge(path: string, maxBytes: number): ActionableError {
  return new ActionableError(
    `Audio file ${path} is larger than the ${maxBytes}-byte limit. Use a shorter clip.`,
  );
}

function unsupported(code: EmulatorAudioErrorCode, reason: string): EmulatorAudioError {
  return new EmulatorAudioError(code, reason);
}

/**
 * Microphone injection and output capture for Android emulators over each emulator's own gRPC
 * endpoint, and for iOS Simulators over the host loopback devices (#13628, #13629). Tracks live injections by id so a stop is idempotent and a session
 * release can stop everything still playing into a device.
 */
export class EmulatorAudioService {
  private readonly active = new Map<string, ActiveInjection>();
  /** A host-loopback start is between its busy check and registration. */
  private hostLoopbackStarting = false;
  /** Settled results (success or failure) of ended injections, newest last. */
  private readonly finished = new Map<
    string,
    { deviceId: string; result: Promise<StoppedInjection> }
  >();

  constructor(private readonly deps: EmulatorAudioServiceDeps) {}

  async startInjection(
    deviceId: string,
    request: StartInjectionRequest,
  ): Promise<StartedInjection> {
    const route = await this.routeFor(deviceId, "audio_injection_unsupported");
    const release = this.reserveHostLoopback(route.route);
    let opened: { session: EmulatorAudioSession; injection: AudioInjection };
    try {
      opened = await this.openInjection(route.open, request);
    } finally {
      // Registered as active below with no await in between, so no second start slips through.
      release();
    }
    const { session, injection } = opened;
    const injectionId = this.deps.ids.next();
    const result = this.settle(injectionId, injection, session);
    this.active.set(injectionId, {
      deviceId,
      route: route.route,
      owner: request.sessionId,
      injection,
      result,
    });
    const retire = () => {
      this.active.delete(injectionId);
      this.finished.set(injectionId, { deviceId, result });
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
      route: route.route,
    };
  }

  /**
   * Ends an injection. Idempotent: a finished or already-stopped id returns its result. With
   * `deviceId`, an injection on another device is refused, so a caller authorized for one
   * emulator cannot stop audio on another by its id.
   */
  async stopInjection(injectionId: string, deviceId?: string): Promise<StoppedInjection> {
    const done = this.finished.get(injectionId);
    if (done) {
      assertSameDevice(injectionId, done.deviceId, deviceId);
      return done.result;
    }
    const active = this.active.get(injectionId);
    if (!active) {
      throw new ActionableError(
        `No audio injection '${injectionId}' on this server. Only the last ${FINISHED_INJECTIONS_KEPT} ` +
          "ended injections are kept, and a server restart forgets them all; start a new injection.",
      );
    }
    assertSameDevice(injectionId, active.deviceId, deviceId);
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

  /**
   * Stops the injections no session owns on a device, for a session acquiring it: a sessionless
   * feed must not reach the new holder's microphone. Undefined when there are none.
   */
  stopOwnerless(deviceId: string): Promise<number> | undefined {
    const ownerless = (entry: ActiveInjection) =>
      entry.deviceId === deviceId && entry.owner === undefined;
    return [...this.active.values()].some(ownerless) ? this.stopMatching(ownerless) : undefined;
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
    const route = await this.routeFor(deviceId, "audio_capture_unsupported");
    const session = route.open();
    try {
      const { pcm, timedOut } = await session.captureAudio({
        durationMs: request.durationMs,
        sampleRate: request.sampleRate,
      });
      const levels = analyzeLevels(pcm, { silenceThresholdDbfs: request.silenceThresholdDbfs });
      return { ...levels, pcm, timedOut, route: route.route };
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

  private async openInjection(
    open: () => EmulatorAudioSession,
    request: StartInjectionRequest,
  ): Promise<{ session: EmulatorAudioSession; injection: AudioInjection }> {
    const pcm = applyGainDb(await this.loadSource(request.source), request.gainDb ?? 0);
    const session = open();
    try {
      const injection = await session.injectAudio(pcm, {
        loop: request.loop,
        startDelayMs: request.startDelayMs,
        maxDurationMs:
          request.maxDurationMs ?? (request.loop ? DEFAULT_LOOP_MAX_DURATION_MS : undefined),
      });
      return { session, injection };
    } catch (error) {
      await session.close();
      throw error;
    }
  }

  /**
   * The host loopback devices feed every simulator on the host at once, so a second injection would
   * mix into the first one's microphone. Holds the route from the start until the injection is
   * registered; returns the release.
   */
  private reserveHostLoopback(route: AudioRoute): () => void {
    if (route !== "host-loopback") {
      return () => {};
    }
    const playing = [...this.active].find(([, entry]) => entry.route === "host-loopback");
    if (this.hostLoopbackStarting || playing) {
      const holder = playing
        ? `Audio injection '${playing[0]}' on ${playing[1].deviceId} is`
        : "Another injection is starting and";
      throw new EmulatorAudioError(
        "audio_injection_busy",
        `${holder} using the host loopback device, which every iOS Simulator on this host records ` +
          "from. Stop it before starting another.",
      );
    }
    this.hostLoopbackStarting = true;
    return () => {
      this.hostLoopbackStarting = false;
    };
  }

  private async routeFor(
    deviceId: string,
    code: EmulatorAudioErrorCode,
  ): Promise<{ route: AudioRoute; open: () => EmulatorAudioSession }> {
    const hostLoopback = this.deps.createHostLoopbackSession;
    if (hostLoopback && resolveIosDeviceKind({ deviceId }) === "simulator") {
      return { route: "host-loopback", open: hostLoopback };
    }
    const endpoint = await this.endpointFor(deviceId, code);
    return { route: "emulator-grpc", open: () => this.deps.createSession(endpoint) };
  }

  private async endpointFor(
    deviceId: string,
    code: EmulatorAudioErrorCode,
  ): Promise<EmulatorGrpcEndpoint> {
    if (!isAndroidEmulatorSerial(deviceId)) {
      throw unsupported(
        code,
        `Audio injection and capture support local Android emulators and iOS Simulators; '${deviceId}' is neither.`,
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
    const maxBytes = this.deps.maxSourceBytes ?? MAX_AUDIO_SOURCE_BYTES;
    const bytes = await this.deps.readFile(source.path, maxBytes);
    if (bytes.byteLength > maxBytes) {
      throw audioSourceTooLarge(source.path, maxBytes);
    }
    return parseWav(bytes);
  }
}
