import { ActionableError } from "../../models/ActionableError";
import { errorMessage } from "../../models/describeUnknownError";
import type { AudioStream } from "../../utils/android-cmdline-tools/emulatorGrpc/EmulatorAudioClient";
import { logger } from "../../utils/logger";
import { audioPcmPath } from "./recordingAudioLimits";
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
    sink: (pcm: Uint8Array) => void,
    options?: { sampleRate?: number },
  ): Promise<AudioStream>;
}

/** Where captured PCM goes while a recording runs, so a long recording never sits in memory. */
export interface PcmFile {
  write(chunk: Uint8Array): void;
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

const LOST_TRACK_WARNING =
  "The recording has no audio track: an earlier stop failed and discarded the audio.";

interface AudioTrack {
  stream: AudioStream;
  file: PcmFile;
  pcmPath: string;
  leadMs: number;
  /** Set once the track is abandoned; a stop still muxing then reports no audio track. */
  discarded?: Promise<void>;
}

/**
 * Records the device's audio beside the video when a recording asks for `audio`, and muxes it in
 * at stop (#13629). The video capture itself is the wrapped backend's; a failed audio capture or
 * mux leaves the video intact with `hasAudioTrack: false` and a warning.
 */
export class AudioTrackVideoCaptureBackend implements VideoCaptureBackend {
  private readonly tracks = new Map<string, AudioTrack>();
  /**
   * Recordings whose stop failed after the track was discarded. The video side may keep the
   * recording active for a retry, which must still say the file has no audio (#15860).
   */
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
    await this.deps.muxer.ensureAvailable();
    const pcmPath = audioPcmPath(config.outputPath);
    const file = this.deps.openPcmFile(pcmPath);
    let stream: AudioStream;
    try {
      stream = await this.deps.source.startStream(deviceId, (chunk) => file.write(chunk));
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
      await this.discard({ stream, file, pcmPath, leadMs: 0 });
      throw error;
    }
    const leadMs = Math.max(0, videoStartedAt - audioStartedAt);
    this.tracks.set(handle.recordingId, { stream, file, pcmPath, leadMs });
    return handle;
  }

  async stop(handle: RecordingHandle): Promise<RecordingResult> {
    const track = this.tracks.get(handle.recordingId);
    if (!track) {
      return this.lostTracks.has(handle.recordingId)
        ? this.stopAfterLostTrack(handle)
        : this.inner.stop(handle);
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
      await this.discardOnce(track);
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
      this.lostTracks.add(handle.recordingId);
      throw error;
    }
    const warning = track.discarded
      ? "The recording has no audio track: it was force-stopped while stopping."
      : await this.addTrack(track, result.outputPath);
    const warnings = [...(result.warnings ?? []), ...(warning ? [warning] : [])];
    return {
      ...result,
      // Muxing rewrote the file, so its size is re-read from disk.
      ...(warning ? {} : { sizeBytes: undefined }),
      hasAudioTrack: warning === undefined,
      warnings: warnings.length > 0 ? warnings : undefined,
    };
  }

  /** A retry of a stop that failed after discarding the track: the video, with no audio track. */
  private async stopAfterLostTrack(handle: RecordingHandle): Promise<RecordingResult> {
    const result = await this.inner.stop(handle);
    this.lostTracks.delete(handle.recordingId);
    return {
      ...result,
      hasAudioTrack: false,
      warnings: [...(result.warnings ?? []), LOST_TRACK_WARNING],
    };
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
