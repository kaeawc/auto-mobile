import { ActionableError } from "../../models/ActionableError";
import { errorMessage } from "../../models/describeUnknownError";
import type { AudioStream } from "../../utils/android-cmdline-tools/emulatorGrpc/EmulatorAudioClient";
import { logger } from "../../utils/logger";
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
  /** Flushes and closes; resolves with the bytes written. */
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
  file: PcmFile;
  pcmPath: string;
  leadMs: number;
}

/**
 * Records the device's audio beside the video when a recording asks for `audio`, and muxes it in
 * at stop (#13629). The video capture itself is the wrapped backend's; a failed audio capture or
 * mux leaves the video intact with `hasAudioTrack: false` and a warning.
 */
export class AudioTrackVideoCaptureBackend implements VideoCaptureBackend {
  private readonly tracks = new Map<string, AudioTrack>();

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
    const pcmPath = `${config.outputPath}.audio.pcm`;
    const file = this.deps.openPcmFile(pcmPath);
    const audioStartedAt = this.deps.now();
    let stream: AudioStream;
    try {
      stream = await this.deps.source.startStream(deviceId, (chunk) => file.write(chunk));
    } catch (error) {
      await this.discardFile(file, pcmPath);
      throw error;
    }
    let handle: RecordingHandle;
    try {
      handle = await this.inner.start(config);
    } catch (error) {
      await this.discard({ stream, file, pcmPath, leadMs: 0 });
      throw error;
    }
    const leadMs = Math.max(0, this.deps.now() - audioStartedAt);
    this.tracks.set(handle.recordingId, { stream, file, pcmPath, leadMs });
    return handle;
  }

  async stop(handle: RecordingHandle): Promise<RecordingResult> {
    const track = this.tracks.get(handle.recordingId);
    if (!track) {
      return this.inner.stop(handle);
    }
    this.tracks.delete(handle.recordingId);
    let result: RecordingResult;
    try {
      result = await this.inner.stop(handle);
    } catch (error) {
      await this.discard(track);
      throw error;
    }
    const warning = await this.addTrack(track, result.outputPath);
    const warnings = [...(result.warnings ?? []), ...(warning ? [warning] : [])];
    return {
      ...result,
      // Muxing rewrote the file, so its size is re-read from disk.
      ...(warning ? {} : { sizeBytes: undefined }),
      hasAudioTrack: warning === undefined,
      warnings: warnings.length > 0 ? warnings : undefined,
    };
  }

  async forceStop(handle: RecordingHandle, options?: ForceStopOptions): Promise<void> {
    const track = this.tracks.get(handle.recordingId);
    if (track) {
      this.tracks.delete(handle.recordingId);
      await this.discard(track);
    }
    await this.inner.forceStop?.(handle, options);
  }

  /** Ends the audio capture and muxes it into `videoPath`; returns a warning when it could not. */
  private async addTrack(track: AudioTrack, videoPath: string): Promise<string | undefined> {
    try {
      await track.stream.stop();
      const pcmBytes = await track.file.close();
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
      await this.removeQuietly(track.pcmPath);
    }
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
