import { ActionableError, type BootedDevice } from "../models";
import { logger } from "../utils/logger";
import { defaultIdGenerator, type IdGenerator } from "../utils/IdGenerator";
import {
  createAndroidH264CaptureSource,
  WebRtcPublisher,
  resolveWebRtcStreamingConfig,
  type AndroidH264SourceOptions,
  type H264CaptureSource,
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
  bitrateBps?: number;
  size?: { width: number; height: number };
  startedAt: string;
}

export interface WebRtcStreamManagerDependencies {
  idGenerator: IdGenerator;
  createPublisher: (config: WebRtcPublisherConfig, deps: WebRtcPublisherDeps) => WebRtcPublisher;
  createSource: (options: AndroidH264SourceOptions) => H264CaptureSource;
  now: () => Date;
}

const defaultDependencies: WebRtcStreamManagerDependencies = {
  idGenerator: defaultIdGenerator,
  createPublisher: (config, deps) => new WebRtcPublisher(config, deps),
  createSource: options => createAndroidH264CaptureSource(options),
  now: () => new Date(),
};

let dependencies: WebRtcStreamManagerDependencies = { ...defaultDependencies };
const streams = new Map<string, WebRtcStreamRecord>();

/** Override manager dependencies (tests). */
export function setWebRtcStreamManagerDependencies(
  overrides: Partial<WebRtcStreamManagerDependencies>
): void {
  dependencies = { ...dependencies, ...overrides };
}

/** Reset manager state and dependencies (tests). */
export function resetWebRtcStreamManager(): void {
  streams.clear();
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
async function startSource(record: WebRtcStreamRecord): Promise<void> {
  await stopSource(record);
  // stopWebRtcStream() may have deleted (or replaced) this record while we were
  // awaiting the source stop above. Starting capture now would spawn a
  // screenrecord process attached to a record no later stop/list can reach,
  // leaking it. Bail if we no longer own the stream.
  if (streams.get(record.streamId) !== record) {
    return;
  }
  const source = dependencies.createSource({
    device: record.device,
    onData: chunk => record.publisher.writeH264Chunk(chunk),
    onError: () => {
      record.publisher.notifySourceFailed();
    },
    bitrateBps: record.bitrateBps,
    size: record.size,
  });
  record.source = source;
  await source.start();
  // The stream may have been stopped while the source was starting. stop() only
  // reaches record.source, which was still null when it ran, so stop the source
  // we just spawned to avoid an orphaned screenrecord process.
  if (streams.get(record.streamId) !== record) {
    record.source = null;
    await source.stop().catch(() => {});
  }
}

/**
 * Start publishing a device's screen to the configured coordination server over
 * WHIP. Currently Android-only; capture prefers the persistent on-device encoder
 * and falls back to segment-rotated `screenrecord`. Returns the reconnect
 * descriptor for the new stream.
 */
export async function startWebRtcStream(
  request: StartWebRtcStreamRequest
): Promise<WebRtcStreamDescriptor> {
  if (request.device.platform !== "android") {
    // iOS has no live H.264 elementary stream from simctl; a capture source must
    // be built first (VideoToolbox in the CtrlProxy runner). See
    // docs/design-docs/mcp/observe/ios-webrtc-streaming.md (#3777).
    throw new ActionableError(
      `WebRTC streaming currently supports Android only (got ${request.device.platform}). ` +
        `See docs/design-docs/mcp/observe/ios-webrtc-streaming.md for the iOS plan.`
    );
  }

  const existing = activeStreamForDevice(request.device.deviceId);
  if (existing) {
    throw new ActionableError(
      `WebRTC stream already active for device ${request.device.deviceId} (streamId ${existing.streamId}). Stop it first.`
    );
  }

  const config = resolveWebRtcStreamingConfig(request.overrides);
  const streamId = request.streamId ?? `webrtc_${dependencies.idGenerator.next()}`;

  // An explicit id reused across devices would otherwise overwrite the existing
  // record here, orphaning the first stream's publisher/source (leaking the
  // screenrecord/WHIP session and hiding it from list/stop).
  if (streams.has(streamId)) {
    throw new ActionableError(`WebRTC stream ${streamId} already active. Stop it first.`);
  }

  const bitrateBps = config.bitrateKbps ? config.bitrateKbps * 1000 : undefined;

  // The publisher's lifecycle hooks resolve the record by id (rather than
  // closing over it) so the record can be constructed with the publisher in one
  // shot. The hooks only run during publisher.start() (below), after the record
  // is registered.
  const publisher = dependencies.createPublisher(
    {
      streamId,
      whipEndpoint: config.whipEndpoint,
      bearerToken: config.bearerToken,
      iceServers: config.iceServers,
      bitrateBps,
      trickleIce: config.trickleIce,
    },
    {
      onBeforeEstablish: () => withRecord(streamId, stopSource),
      onConnected: () => withRecord(streamId, startSource),
    }
  );
  const record: WebRtcStreamRecord = {
    streamId,
    device: request.device,
    publisher,
    source: null,
    bitrateBps,
    size: config.size,
    startedAt: dependencies.now().toISOString(),
  };
  streams.set(streamId, record);

  try {
    await publisher.start();
  } catch (error) {
    streams.delete(streamId);
    await record.source?.stop().catch(() => {});
    await publisher.stop().catch(() => {});
    throw new ActionableError(
      `Failed to start WebRTC stream: ${error instanceof Error ? error.message : String(error)}`
    );
  }

  return publisher.getDescriptor();
}

/** Stop a stream by id, or the sole active stream when id is omitted. */
export async function stopWebRtcStream(streamId?: string): Promise<WebRtcStreamDescriptor> {
  const record = resolveStreamRecord(streamId);
  streams.delete(record.streamId);
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
