import { parseVolume } from "../../../features/media/MediaSessionController";
import {
  MEDIA_VOLUME_STREAMS,
  type MediaVolumeStream,
} from "../../../features/media/MediaSessionTypes";
import { z } from "zod/v4";
import type { MutationValue } from "./types";

/** `AudioManager.STREAM_*` codes of the Android streams the volume journal rows cover. */
const STREAM_CODES = {
  voice_call: 0,
  system: 1,
  ring: 2,
  music: 3,
  alarm: 4,
  notification: 5,
  bluetooth_sco: 6,
  accessibility: 10,
  assistant: 11,
} as const;

type VolumeStream = keyof typeof STREAM_CODES;

/**
 * Streams a volume key press can change. Android picks the stream from audio focus and call state
 * (voice call, Bluetooth SCO, ring, notification, music, accessibility, assistant, with system
 * and alarm through their aliases), so the press journals every one. The set order puts each
 * stream that can be an alias (SCO and voice call, notification and system to ring, everything to
 * music on a television profile) before the stream it aliases, so the alias's own index is set
 * last and a rescaling round trip cannot leave it off by one. The shell cannot set the
 * accessibility stream (it needs an accessibility service's uid), so that stream is only verified.
 */
const KEY_PRESS_SET_ORDER = [
  "bluetooth_sco",
  "notification",
  "system",
  "assistant",
  "voice_call",
  "ring",
  "alarm",
  "music",
] as const satisfies readonly VolumeStream[];
const KEY_PRESS_STREAMS: readonly VolumeStream[] = [...KEY_PRESS_SET_ORDER, "accessibility"];

/** Journal key of the stream levels a `pressButton` volume key press can change. */
export const VOLUME_KEY_PRESS_MUTATION_KEY = "volume:key-press";

/** Journal key of the one stream a `mediaSession` volume action sets. */
export function volumeStreamMutationKey(stream: MediaVolumeStream): string {
  return `volume:${stream}`;
}

/** Output a volume revert prints only when every stream read back its journaled level. */
export const VOLUME_RESTORED_MARKER = "volume-restored";

/** The streams a volume journal key covers, or null for any other key. */
export function volumeMutationStreams(key: string): readonly VolumeStream[] | null {
  if (key === VOLUME_KEY_PRESS_MUTATION_KEY) {
    return KEY_PRESS_STREAMS;
  }
  const stream = key.startsWith("volume:") ? key.slice("volume:".length) : "";
  return (MEDIA_VOLUME_STREAMS as readonly string[]).includes(stream)
    ? [stream as MediaVolumeStream]
    : null;
}

/** One device shell script that prints each stream's name followed by its `volume --get` output. */
export function volumeReadScript(streams: readonly VolumeStream[]): string {
  return streams
    .map(
      (stream) => `echo ${stream}; cmd media_session volume --stream ${STREAM_CODES[stream]} --get`,
    )
    .join("; ");
}

/** Levels per stream from {@link volumeReadScript}'s output; null when any stream is unreadable. */
export function parseVolumeReadOutput(
  output: string,
  streams: readonly VolumeStream[],
): Record<string, number> | null {
  const levels: Record<string, number> = {};
  let current: string | undefined;
  for (const line of output.split(/\r?\n/)) {
    const trimmed = line.trim();
    if ((streams as readonly string[]).includes(trimmed)) {
      current = trimmed;
      continue;
    }
    const volume = parseVolume(trimmed);
    if (volume && current !== undefined && !Object.hasOwn(levels, current)) {
      levels[current] = volume.level;
    }
  }
  return streams.every((stream) => Object.hasOwn(levels, stream)) ? levels : null;
}

/** The prior a volume row journals: one level for a stream row, a level map for a key press. */
export function volumePriorValue(key: string, levels: Record<string, number>): MutationValue {
  const streams = volumeMutationStreams(key);
  if (!streams) {
    return { state: "unobservable" };
  }
  return key === VOLUME_KEY_PRESS_MUTATION_KEY
    ? { state: "present", value: Object.fromEntries(streams.map((s) => [s, levels[s]])) }
    : { state: "present", value: levels[streams[0]!] };
}

/**
 * Restorable levels: every covered stream at a positive integer index. A level of 0 is not
 * restorable: Android reports a muted stream as 0 (losing its index), and setting the ring stream
 * to 0 also moves the ringer mode to vibrate or silent, so a reset cannot put either back exactly.
 * A positive ring level, conversely, proves the ringer mode was normal, which setting it restores.
 */
function restorableLevels(
  streams: readonly VolumeStream[],
  key: string,
  prior: MutationValue,
): Record<string, number> | null {
  if (prior.state !== "present") {
    return null;
  }
  const level = z.number().int().positive();
  const schema = z.object(Object.fromEntries(streams.map((stream) => [stream, level]))).strict();
  const parsed = schema.safeParse(
    key === VOLUME_KEY_PRESS_MUTATION_KEY ? prior.value : { [streams[0]!]: prior.value },
  );
  return parsed.success ? (parsed.data as Record<string, number>) : null;
}

/**
 * The device shell script that sets each covered stream back to its journaled level and prints
 * {@link VOLUME_RESTORED_MARKER} only when every stream reads that level back; null when the key
 * is not a volume row or its prior is not restorable.
 */
export function volumeRevertScript(key: string, prior: MutationValue): string | null {
  const streams = volumeMutationStreams(key);
  const levels = streams ? restorableLevels(streams, key, prior) : null;
  if (!streams || !levels) {
    return null;
  }
  const sets = streams
    .filter((stream) => stream !== "accessibility")
    .map(
      (stream) =>
        `cmd media_session volume --stream ${STREAM_CODES[stream]} --set ${levels[stream]} >/dev/null 2>&1`,
    );
  const checks = streams.map(
    (stream) =>
      `cmd media_session volume --stream ${STREAM_CODES[stream]} --get 2>/dev/null | grep -q "volume is ${levels[stream]} in range"`,
  );
  return [...sets, `${checks.join(" && ")} && echo ${VOLUME_RESTORED_MARKER}`].join("; ");
}
