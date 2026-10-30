import { ActionableError } from "../../models/ActionableError";
import { errorMessage } from "../../models/describeUnknownError";
import type {
  AudioStream,
  PcmSink,
} from "../../utils/android-cmdline-tools/emulatorGrpc/EmulatorAudioClient";
import { logger } from "../../utils/logger";
import { ANDROID_SCREENRECORD_MAX_SECONDS } from "./androidScreenrecord";
import type {
  ForceStopOptions,
  RecordingHandle,
  RecordingResult,
  VideoCaptureBackend,
  VideoCaptureConfig,
} from "./VideoRecorderService";

/** Streams a device's audio output until stopped. */
export interface AudioTrackSource {
  startStream(
    deviceId: string,
    sink: PcmSink,
    options?: { sampleRate?: number },
  ): Promise<AudioStream>;
}

/** Where captured PCM goes while a recording runs, so a long recording never sits in memory. */
export interface PcmFile {
  /** Appends a chunk; a returned promise settles once the file can take more (backpressure). */
  write(chunk: Uint8Array): void | Promise<void>;
  /** Flushes and closes; resolves with the bytes written, or rejects with a write error. Idempotent. */
  close(): Promise<number>;
}

export interface AudioTrackMuxRequest {
  videoPath: string;
  pcmPath: string;
  pcmBytes: number;
  sampleRate: number;
  /** Audio captured before the video started, trimmed from the start of the track. */
  leadMs: number;
}

/** Adds a PCM track to a finished video in place. */
export interface AudioTrackMuxer {
  /** Throws an actionable error when muxing is not possible on this host. */
  ensureAvailable(): Promise<void>;
  mux(request: AudioTrackMuxRequest): Promise<void>;
}

export interface AudioTrackDependencies {
  source: AudioTrackSource;
  muxer: AudioTrackMuxer;
  openPcmFile: (path: string) => PcmFile;
  removeFile: (path: string) => Promise<void>;
  now: () => number;
}

interface AudioTrack {
  stream: AudioStream;
  /** Stops writing and releases a write waiting on a slow disk, so teardown never waits on it. */
  abandon: () => void;
  file: PcmFile;
  pcmPath: string;
  leadMs: number;
  /** Set once the track is abandoned; a stop still muxing then reports no audio track. */
  discarded?: Promise<void>;
}

/** Where a recording's audio is captured while it runs, beside its output file. */
export function audioTrackPcmPath(outputPath: string): string {
  return `${outputPath}.audio.pcm`;
}

/**
 * An Android recording longer than one screenrecord segment is stitched from several, and the
 * audio track is not, so audio is refused there rather than silently cut short.
 */
export function assertAudioFitsOneSegment(
  platform: string | undefined,
  maxDurationSeconds: number | undefined,
  audio: boolean | undefined,
): void {
  if (
    audio &&
    platform === "android" &&
    (maxDurationSeconds ?? 0) > ANDROID_SCREENRECORD_MAX_SECONDS
  ) {
    throw new ActionableError(
      `audio is supported for Android recordings up to ${ANDROID_SCREENRECORD_MAX_SECONDS} s; ` +
        "set maxDuration to that or less, or record without audio.",
    );
  }
}

const LOST_ON_FAILED_STOP =
  "The recording has no audio track: an earlier stop failed and its audio was discarded.";

/**
 * Records the device's audio beside the video when a recording asks for `audio`, and muxes it in
 * at stop (#13629). The video capture itself is the wrapped backend's; a failed audio capture or
 * mux leaves the video intact with `hasAudioTrack: false` and a warning.
 */
export class AudioTrackVideoCaptureBackend implements VideoCaptureBackend {
  private readonly tracks = new Map<string, AudioTrack>();
  /** Recordings whose track was discarded by a failed stop, so a retried stop still says so. */
  private readonly lostTracks = new Set<string>();

  constructor(
    private readonly inner: VideoCaptureBackend,
    private readonly deps: AudioTrackDependencies,
  ) {
    if (inner.describeCaptureTeardown) {
      this.describeCaptureTeardown = inner.describeCaptureTeardown.bind(inner);
    }
    if (inner.forceStopOrphanedCapture) {
      this.forceStopOrphanedCapture = inner.forceStopOrphanedCapture.bind(inner);
    }
  }

  describeCaptureTeardown?: VideoCaptureBackend["describeCaptureTeardown"];
  forceStopOrphanedCapture?: VideoCaptureBackend["forceStopOrphanedCapture"];

  async start(config: VideoCaptureConfig): Promise<RecordingHandle> {
    if (!config.audio) {
      return this.inner.start(config);
    }
    const deviceId = config.device?.deviceId;
    if (!deviceId) {
      throw new ActionableError("A recording with audio needs a target device.");
    }
    assertAudioFitsOneSegment(config.device?.platform, config.maxDurationSeconds, config.audio);
    await this.deps.muxer.ensureAvailable();
    const pcmPath = audioTrackPcmPath(config.outputPath);
    const file = this.deps.openPcmFile(pcmPath);
    const writer = abandonableWriter(file);
    let stream: AudioStream;
    try {
      stream = await this.deps.source.startStream(deviceId, writer.sink);
    } catch (error) {
      await this.discardFile(file, pcmPath);
      throw error;
    }
    // The PCM starts once the stream is open, and the video once its capture is launched; any
    // settle wait inside the video start is not counted as audio captured before the video.
    const audioStartedAt = this.deps.now();
    let handle: RecordingHandle;
    const videoStartedAt = this.deps.now();
    try {
      handle = await this.inner.start(config);
    } catch (error) {
      await this.discard({ stream, abandon: writer.abandon, file, pcmPath, leadMs: 0 });
      throw error;
    }
    const leadMs = Math.max(0, videoStartedAt - audioStartedAt);
    this.tracks.set(handle.recordingId, {
      stream,
      abandon: writer.abandon,
      file,
      pcmPath,
      leadMs,
    });
    // The PCM grows beside the video, so the in-progress size cap counts it too.
    return {
      ...handle,
      inProgressSidecarPaths: [...(handle.inProgressSidecarPaths ?? []), pcmPath],
    };
  }

  async stop(handle: RecordingHandle): Promise<RecordingResult> {
    const track = this.tracks.get(handle.recordingId);
    if (!track) {
      if (!this.lostTracks.has(handle.recordingId)) {
        return this.inner.stop(handle);
      }
      const result = await this.inner.stop(handle);
      this.lostTracks.delete(handle.recordingId);
      return withAudioOutcome(result, LOST_ON_FAILED_STOP);
    }
    // The track stays registered until its teardown ends, so a force stop that arrives while the
    // video is still finalizing can still stop the audio (#15859).
    try {
      return await this.stopWithTrack(handle, track);
    } finally {
      this.tracks.delete(handle.recordingId);
    }
  }

  async forceStop(handle: RecordingHandle, options?: ForceStopOptions): Promise<void> {
    this.lostTracks.delete(handle.recordingId);
    const track = this.tracks.get(handle.recordingId);
    if (track) {
      this.tracks.delete(handle.recordingId);
      // Video teardown does not wait for abandoned audio to reach a possibly stalled disk.
      void this.discardOnce(track);
    }
    await this.inner.forceStop?.(handle, options);
  }

  private async stopWithTrack(
    handle: RecordingHandle,
    track: AudioTrack,
  ): Promise<RecordingResult> {
    let result: RecordingResult;
    try {
      result = await this.inner.stop(handle);
    } catch (error) {
      await this.discardOnce(track);
      // The inner backend may keep the recording active for a retry (Android finalization); a
      // force stop that already took the track ends the recording instead.
      if (this.tracks.has(handle.recordingId)) {
        this.lostTracks.add(handle.recordingId);
      }
      throw error;
    }
    const warning = track.discarded
      ? "The recording has no audio track: it was force-stopped while stopping."
      : await this.addTrack(track, result.outputPath);
    return withAudioOutcome(result, warning);
  }

  /** Ends the audio capture and muxes it into `videoPath`; returns a warning when it could not. */
  private async addTrack(track: AudioTrack, videoPath: string): Promise<string | undefined> {
    let closing: Promise<number> | undefined;
    try {
      await track.stream.stop();
      closing = track.file.close();
      const pcmBytes = await closing;
      await this.deps.muxer.mux({
        videoPath,
        pcmPath: track.pcmPath,
        pcmBytes,
        sampleRate: track.stream.sampleRate,
        leadMs: track.leadMs,
      });
      return undefined;
    } catch (error) {
      logger.warn(`Recording audio track for ${videoPath} failed: ${errorMessage(error)}`);
      return `The recording has no audio track: ${errorMessage(error)}`;
    } finally {
      // A failed audio stop still releases the file before it is removed (#15859).
      if (closing) {
        await this.removeQuietly(track.pcmPath);
      } else {
        await this.discardFile(track.file, track.pcmPath);
      }
    }
  }

  private discardOnce(track: AudioTrack): Promise<void> {
    track.discarded ??= this.discard(track);
    return track.discarded;
  }

  private async discard(track: AudioTrack): Promise<void> {
    track.abandon();
    await track.stream.stop().catch((error: unknown) => {
      // The recording is being abandoned; a failed audio stop changes nothing for the caller.
      logger.debug(`audio track stop during discard: ${errorMessage(error)}`);
    });
    await this.discardFile(track.file, track.pcmPath);
  }

  private async discardFile(file: PcmFile, pcmPath: string): Promise<void> {
    await file.close().catch((error: unknown) => {
      // Only the temporary PCM is lost; it is removed next.
      logger.debug(`audio track file close during discard: ${errorMessage(error)}`);
    });
    await this.removeQuietly(pcmPath);
  }

  private async removeQuietly(pcmPath: string): Promise<void> {
    await this.deps.removeFile(pcmPath).catch((error: unknown) => {
      logger.warn(`Failed to remove temporary audio ${pcmPath}: ${errorMessage(error)}`);
    });
  }
}

/** `result` with the audio track's outcome: a warning means the video has no audio track. */
function withAudioOutcome(result: RecordingResult, warning: string | undefined): RecordingResult {
  const warnings = [...(result.warnings ?? []), ...(warning ? [warning] : [])];
  return {
    ...result,
    // Muxing rewrote the file, so its size is re-read from disk.
    ...(warning ? {} : { sizeBytes: undefined }),
    hasAudioTrack: warning === undefined,
    warnings: warnings.length > 0 ? warnings : undefined,
  };
}

/** A PCM sink over `file` that can be abandoned: later chunks are dropped and a waiting write is released. */
function abandonableWriter(file: PcmFile): { sink: PcmSink; abandon: () => void } {
  let abandoned = false;
  let release: () => void = () => {};
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  return {
    sink: (chunk) => {
      if (abandoned) {
        return undefined;
      }
      const busy = file.write(chunk);
      if (!(busy instanceof Promise)) {
        return undefined;
      }
      return new Promise<void>((resolve) => {
        void busy.then(resolve, resolve);
        void released.then(resolve);
      });
    },
    abandon: () => {
      abandoned = true;
      release();
    },
  };
}
