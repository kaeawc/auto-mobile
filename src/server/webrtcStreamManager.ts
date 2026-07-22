import { ActionableError, type BootedDevice } from "../models";
import { logger } from "../utils/logger";
import { defaultIdGenerator, type IdGenerator } from "../utils/IdGenerator";
import { defaultTimer } from "../utils/SystemTimer";
import {
  createH264CaptureSource,
  resolveVideoServerJar,
  WebRtcPublisher,
  resolveWebRtcStreamingConfig,
  type H264CaptureSource,
  type H264CaptureSourceOptions,
  type WebRtcPublisherConfig,
  type WebRtcPublisherDeps,
  type WebRtcStreamDescriptor,
  type WebRtcStreamingOverrides,
} from "../features/webrtc";

export interface StartWebRtcStreamRequest {
  device: BootedDevice;
  streamId?: string;
  overrides?: WebRtcStreamingOverrides;
}

interface WebRtcStreamRecord {
  streamId: string;
  device: BootedDevice;
  publisher: WebRtcPublisher;
  source: H264CaptureSource | null;
  /** Persistent-encoder jar resolved once at stream start; null → screenrecord. */
  jarPath: string | null;
  bitrateBps?: number;
  size?: { width: number; height: number };
  audioEnabled: boolean;
  startedAt: string;
  /** Reservation token for a start that has not returned to its caller yet. */
  startToken: symbol;
}

export interface WebRtcStreamManagerDependencies {
  idGenerator: IdGenerator;
  createPublisher: (config: WebRtcPublisherConfig, deps: WebRtcPublisherDeps) => WebRtcPublisher;
  createSource: (options: H264CaptureSourceOptions, jarPath: string | null) => H264CaptureSource;
  /**
   * Resolve the Android persistent-encoder jar once, off the frame path. Returns
   * the verified path, or null to degrade to screenrecord; throws on a fatal
   * fail-mode (checksum mismatch, or REQUIRE with nothing available). Non-Android
   * devices resolve to null.
   */
  resolveVideoJar: (device: BootedDevice) => Promise<string | null>;
  now: () => Date;
}

const defaultDependencies: WebRtcStreamManagerDependencies = {
  idGenerator: defaultIdGenerator,
  createPublisher: (config, deps) => new WebRtcPublisher(config, deps),
  createSource: (options, jarPath) => createH264CaptureSource(options, jarPath),
  resolveVideoJar: device =>
    device.platform === "android" ? resolveVideoServerJar() : Promise.resolve(null),
  now: () => new Date(),
};

let dependencies: WebRtcStreamManagerDependencies = { ...defaultDependencies };
const streams = new Map<string, WebRtcStreamRecord>();
const startingDeviceIds = new Map<string, symbol>();
const startingStreamIds = new Map<string, symbol>();
const INITIAL_AUDIO_SOURCE_START_TIMEOUT_MS = 30_000;

/** Override manager dependencies (tests). */
export function setWebRtcStreamManagerDependencies(
  overrides: Partial<WebRtcStreamManagerDependencies>
): void {
  dependencies = { ...dependencies, ...overrides };
}

/** Reset manager state and dependencies (tests). */
export function resetWebRtcStreamManager(): void {
  streams.clear();
  startingDeviceIds.clear();
  startingStreamIds.clear();
  dependencies = { ...defaultDependencies };
}

function activeStreamForDevice(deviceId: string): WebRtcStreamRecord | undefined {
  for (const record of streams.values()) {
    if (record.device.deviceId === deviceId) {
      return record;
    }
  }
  return undefined;
}

/** Run an action against the current record for a stream id, if it still exists. */
async function withRecord(
  streamId: string,
  action: (record: WebRtcStreamRecord) => Promise<void>
): Promise<void> {
  const record = streams.get(streamId);
  if (record) {
    await action(record);
  }
}

/** Stop and clear the capture source for a stream (before each (re)establish). */
async function stopSource(record: WebRtcStreamRecord): Promise<void> {
  if (record.source) {
    await record.source.stop().catch(error => {
      logger.debug(`[WebRtcStream] source stop failed: ${error}`);
    });
    record.source = null;
  }
}

/**
 * Start the capture source once the peer connection is live, routing its H.264
 * output into the publisher. Starting only after `connected` ensures the first
 * SPS/PPS + keyframe is sent over an established connection rather than dropped.
 * A capture failure is surfaced to the publisher so the reconnect loop runs
 * instead of leaving the viewer on a frozen frame.
 */
async function startSource(record: WebRtcStreamRecord): Promise<boolean> {
  await stopSource(record);
  // stopWebRtcStream() may have deleted (or replaced) this record while we were
  // awaiting the source stop above. Starting capture now would spawn a
  // screenrecord process attached to a record no later stop/list can reach,
  // leaking it. Bail if we no longer own the stream.
  if (streams.get(record.streamId) !== record) {
    return false;
  }
  const source = dependencies.createSource(
    {
      device: record.device,
      onData: chunk => record.publisher.writeH264Chunk(chunk),
      onAudioData: chunk => record.publisher.writePcmAudioChunk(chunk),
      onError: () => {
        record.publisher.notifySourceFailed();
      },
      bitrateBps: record.bitrateBps,
      size: record.size,
      audioEnabled: record.audioEnabled,
    },
    record.jarPath
  );
  record.source = source;
  await source.start();
  // The stream may have been stopped while the source was starting. stop() only
  // reaches record.source, which was still null when it ran, so stop the source
  // we just spawned to avoid an orphaned screenrecord process.
  if (streams.get(record.streamId) !== record) {
    record.source = null;
    await source.stop().catch(() => {});
    return false;
  }
  return true;
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeout = defaultTimer.setTimeout(() => reject(new ActionableError(message)), timeoutMs);
  });
  return Promise.race([promise, timeoutPromise]).finally(() => {
    if (timeout) {
      defaultTimer.clearTimeout(timeout);
    }
  });
}

async function cleanupFailedStart(
  streamId: string,
  record: WebRtcStreamRecord,
  publisher: WebRtcPublisher
): Promise<void> {
  if (streams.get(streamId) === record) {
    streams.delete(streamId);
  }
  await record.source?.stop().catch(() => {});
  await publisher.stop().catch(() => {});
}

function assertStreamStartAvailable(deviceId: string, streamId: string): void {
  const existing = activeStreamForDevice(deviceId);
  if (existing || startingDeviceIds.has(deviceId)) {
    throw new ActionableError(
      `WebRTC stream already active or starting for device ${deviceId} (streamId ${existing?.streamId ?? "pending"}). Stop it first.`
    );
  }
  if (streams.has(streamId) || startingStreamIds.has(streamId)) {
    throw new ActionableError(`WebRTC stream ${streamId} already active. Stop it first.`);
  }
}

/**
 * Start publishing a device's screen to the configured coordination server over
 * WHIP. Android capture prefers the persistent on-device encoder and falls back
 * to segment-rotated `screenrecord`; iOS capture uses the macOS screen-capture
 * helper and a local H.264 encoder. Returns the reconnect descriptor for the new
 * stream.
 */
export async function startWebRtcStream(
  request: StartWebRtcStreamRequest
): Promise<WebRtcStreamDescriptor> {
  const config = resolveWebRtcStreamingConfig(request.overrides);
  const streamId = request.streamId ?? `webrtc_${dependencies.idGenerator.next()}`;
  // An explicit id reused across devices would otherwise overwrite the existing
  // record, orphaning the first stream's publisher/source.
  assertStreamStartAvailable(request.device.deviceId, streamId);

  const startToken = Symbol(streamId);
  startingDeviceIds.set(request.device.deviceId, startToken);
  startingStreamIds.set(streamId, startToken);
  try {
    const bitrateBps = config.bitrateKbps ? config.bitrateKbps * 1000 : undefined;

    // Resolve the persistent-encoder jar ONCE, before establishing the WHIP
    // session — a fatal fail-mode (checksum mismatch, or REQUIRE with nothing
    // available) must abort the stream start with its ActionableError rather than
    // surfacing mid-capture. The download resolves here, off the per-frame path;
    // startSource() only constructs the (synchronous) capture source. A degrade
    // returns null → screenrecord.
    const jarPath = await dependencies.resolveVideoJar(request.device);

    let settleInitialAudioSourceStart:
    | ((result: { ok: true } | { ok: false; error: unknown }) => void)
    | undefined;
    let initialAudioSourceStartSettled = false;
    const initialAudioSourceStart = config.audioEnabled
      ? new Promise<void>((resolve, reject) => {
        settleInitialAudioSourceStart = result => {
          if (initialAudioSourceStartSettled) {
            return;
          }
          initialAudioSourceStartSettled = true;
          if (result.ok) {
            resolve();
          } else {
            reject(result.error);
          }
        };
      })
      : null;
    const settleInitialAudioStart = (error?: unknown): void => {
      if (!config.audioEnabled) {
        return;
      }
      settleInitialAudioSourceStart?.(error ? { ok: false, error } : { ok: true });
    };

    const publisherRef: { current?: WebRtcPublisher } = {};
    const publisher = dependencies.createPublisher(
      {
        streamId,
        whipEndpoint: config.whipEndpoint,
        bearerToken: config.bearerToken,
        iceServers: config.iceServers,
        bitrateBps,
        trickleIce: config.trickleIce,
        audioEnabled: config.audioEnabled,
      },
      {
        onBeforeEstablish: () => withRecord(streamId, stopSource),
        onConnected: async () => {
          const currentRecord = streams.get(streamId);
          if (!currentRecord || currentRecord.publisher !== publisherRef.current) {
            settleInitialAudioStart(new Error(`WebRTC stream ${streamId} stopped before capture source started.`));
            return;
          }
          try {
            const started = await startSource(currentRecord);
            if (!started) {
              const error = new Error(`WebRTC stream ${streamId} stopped before capture source started.`);
              settleInitialAudioStart(error);
              if (config.audioEnabled) {
                throw error;
              }
              return;
            }
            settleInitialAudioStart();
          } catch (error) {
            settleInitialAudioStart(error);
            throw error;
          }
        },
      }
    );
    publisherRef.current = publisher;
    const record: WebRtcStreamRecord = {
      streamId,
      device: request.device,
      publisher,
      source: null,
      jarPath,
      bitrateBps,
      size: config.size,
      audioEnabled: config.audioEnabled,
      startedAt: dependencies.now().toISOString(),
      startToken,
    };
    streams.set(streamId, record);

    try {
      await publisher.start();
      if (initialAudioSourceStart) {
        await withTimeout(
          initialAudioSourceStart,
          INITIAL_AUDIO_SOURCE_START_TIMEOUT_MS,
          "Timed out waiting for WebRTC audio capture source to start."
        );
      }
    } catch (error) {
      await cleanupFailedStart(streamId, record, publisher);
      throw new ActionableError(
        `Failed to start WebRTC stream: ${error instanceof Error ? error.message : String(error)}`
      );
    }

    return publisher.getDescriptor();
  } finally {
    if (startingDeviceIds.get(request.device.deviceId) === startToken) {
      startingDeviceIds.delete(request.device.deviceId);
    }
    if (startingStreamIds.get(streamId) === startToken) {
      startingStreamIds.delete(streamId);
    }
  }
}

/** Stop a stream by id, or the sole active stream when id is omitted. */
export async function stopWebRtcStream(streamId?: string): Promise<WebRtcStreamDescriptor> {
  const record = resolveStreamRecord(streamId);
  streams.delete(record.streamId);
  if (startingDeviceIds.get(record.device.deviceId) === record.startToken) {
    startingDeviceIds.delete(record.device.deviceId);
  }
  if (startingStreamIds.get(record.streamId) === record.startToken) {
    startingStreamIds.delete(record.streamId);
  }
  const descriptor = record.publisher.getDescriptor();

  await record.source?.stop().catch(error => {
    logger.debug(`[WebRtcStream] source stop failed: ${error}`);
  });
  await record.publisher.stop().catch(error => {
    logger.debug(`[WebRtcStream] publisher stop failed: ${error}`);
  });

  return { ...descriptor, state: "stopped" };
}

/** List reconnect descriptors for all active streams. */
export function listWebRtcStreams(): WebRtcStreamDescriptor[] {
  return Array.from(streams.values()).map(record => record.publisher.getDescriptor());
}

/** Get the reconnect descriptor for one stream (or null). */
export function getWebRtcStreamDescriptor(streamId: string): WebRtcStreamDescriptor | null {
  const record = streams.get(streamId);
  return record ? record.publisher.getDescriptor() : null;
}

function resolveStreamRecord(streamId?: string): WebRtcStreamRecord {
  if (streamId) {
    const record = streams.get(streamId);
    if (!record) {
      throw new ActionableError(`No active WebRTC stream with id ${streamId}.`);
    }
    return record;
  }

  if (streams.size === 0) {
    throw new ActionableError("No active WebRTC streams. Provide a streamId.");
  }
  if (streams.size > 1) {
    throw new ActionableError("Multiple active WebRTC streams. Provide a streamId.");
  }
  return streams.values().next().value as WebRtcStreamRecord;
}
