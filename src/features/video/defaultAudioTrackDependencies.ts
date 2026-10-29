import { createWriteStream } from "node:fs";
import { rm } from "node:fs/promises";
import { defaultEmulatorAudioService } from "../audio/defaultEmulatorAudioService";
import { DefaultFfmpegClient } from "../../utils/media/FfmpegClient";
import { logger } from "../../utils/logger";
import { defaultTimer } from "../../utils/SystemTimer";
import {
  AudioTrackVideoCaptureBackend,
  type AudioTrackDependencies,
  type PcmFile,
} from "./AudioTrackVideoCaptureBackend";
import { HybridVideoCaptureBackend } from "./HybridVideoCaptureBackend";
import { FfmpegAudioTrackMuxer } from "./FfmpegAudioTrackMuxer";

/** Appends PCM to an owner-only file as it arrives. Closing is idempotent. */
export function openFileBackedPcm(path: string): PcmFile {
  const stream = createWriteStream(path, { mode: 0o600 });
  let bytes = 0;
  let closing: Promise<number> | undefined;
  return {
    write: (chunk) => {
      bytes += chunk.byteLength;
      stream.write(chunk);
    },
    close: () => {
      closing ??= new Promise<number>((resolve, reject) => {
        stream.once("error", reject);
        stream.end(() => resolve(bytes));
      });
      return closing;
    },
  };
}

export function createDefaultAudioTrackDependencies(): AudioTrackDependencies {
  return {
    source: defaultEmulatorAudioService,
    muxer: new FfmpegAudioTrackMuxer(new DefaultFfmpegClient()),
    openPcmFile: openFileBackedPcm,
    removeFile: (path) => rm(path, { force: true }),
    now: () => defaultTimer.now(),
  };
}

/**
 * The daemon's capture backend: platform routing, plus the device's audio when a recording asks
 * for it (#13629).
 */
export function createRecordingCaptureBackend(): AudioTrackVideoCaptureBackend {
  logger.debug("[VideoRecording] Using HybridVideoCaptureBackend (iOS FFmpeg, Android platform)");
  return new AudioTrackVideoCaptureBackend(
    new HybridVideoCaptureBackend(),
    createDefaultAudioTrackDependencies(),
  );
}
