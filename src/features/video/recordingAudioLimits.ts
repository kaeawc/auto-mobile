import { ActionableError } from "../../models/ActionableError";
import { ANDROID_SCREENRECORD_MAX_SECONDS } from "./androidScreenrecord";

/** Where a recording with audio keeps its captured PCM until it is muxed in at stop. */
export function audioPcmPath(outputPath: string): string {
  return `${outputPath}.audio.pcm`;
}

/**
 * Segmented Android recordings (over 180 s) have no audio track: it would need stitching. Checked
 * by the `videoRecording` tool and again by the daemon's start, so a direct start cannot record
 * audio past screenrecord's limit (#15860).
 */
export function assertAudioFitsOneSegment(
  platform: string,
  maxDurationSeconds: number,
  audio: boolean | undefined,
): void {
  if (audio && platform === "android" && maxDurationSeconds > ANDROID_SCREENRECORD_MAX_SECONDS) {
    throw new ActionableError(
      `audio is supported for Android recordings up to ${ANDROID_SCREENRECORD_MAX_SECONDS} s; ` +
        "set maxDuration to that or less, or record without audio.",
    );
  }
}

/**
 * The files the in-progress size cap adds up: the live capture file if the backend reports one,
 * else the output, plus the PCM a recording with audio writes beside the output (#15860). Re-arming
 * after a retained stop passes no `audio`: the failed stop already discarded the PCM.
 */
export function sizeMonitorPaths(
  liveCapturePath: string | undefined,
  outputPath: string,
  audio?: boolean,
): string[] {
  const video = liveCapturePath ?? outputPath;
  return audio ? [video, audioPcmPath(outputPath)] : [video];
}

/** The combined size of `paths`; a file that does not exist yet counts as zero. */
export async function totalFileSize(
  paths: readonly string[],
  statFileSize: (path: string) => Promise<number>,
): Promise<number> {
  const sizes = await Promise.all(paths.map((path) => statFileSize(path)));
  return sizes.reduce((total, size) => total + size, 0);
}
