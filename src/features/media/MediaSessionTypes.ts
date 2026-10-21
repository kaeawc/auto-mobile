/**
 * Typed view of Android media sessions (#14117), read from `dumpsys media_session`.
 *
 * Values are what the session last reported to the system (`PlaybackState`,
 * `MediaMetadata` description), not what the speaker is doing: `positionMs` is the
 * position at `positionUpdatedAtMs` (device `elapsedRealtime`), exactly like
 * `PlaybackState.getPosition()`.
 */

/** `PlaybackState.STATE_*`, lower-cased. `unknown` is a code this parser does not know. */
export const MEDIA_PLAYBACK_STATES = [
  "none",
  "stopped",
  "paused",
  "playing",
  "fast_forwarding",
  "rewinding",
  "buffering",
  "error",
  "connecting",
  "skipping_to_previous",
  "skipping_to_next",
  "skipping_to_queue_item",
  "unknown",
] as const;

export type MediaPlaybackState = (typeof MEDIA_PLAYBACK_STATES)[number];

/** Transport keys `cmd media_session dispatch` accepts that this tool exposes. */
export const MEDIA_DISPATCH_KEYS = [
  "play",
  "pause",
  "play-pause",
  "next",
  "previous",
  "stop",
  "fast-forward",
  "rewind",
] as const;

export type MediaDispatchKey = (typeof MEDIA_DISPATCH_KEYS)[number];

/** Audio streams `mediaSession` volume control exposes, mapped to `AudioManager.STREAM_*`. */
export const MEDIA_VOLUME_STREAMS = ["music", "ring", "alarm"] as const;

export type MediaVolumeStream = (typeof MEDIA_VOLUME_STREAMS)[number];

/**
 * What the platform's dump exposes of `MediaMetadata`: its size and its
 * `MediaDescription` (title, subtitle, description). For metadata without display
 * fields the description is the first three of title, artist, album, so `artist`
 * and `album` are positional and best effort. Duration is not in the dump.
 */
export interface MediaSessionMetadata {
  title?: string;
  artist?: string;
  album?: string;
  /** The raw `description=` text, kept because a comma in a title makes the split ambiguous. */
  description?: string;
  /** Number of metadata keys the app set. */
  size?: number;
}

/** Identity of one `MediaSession`: owning package, session tag and Android user. */
export interface MediaSessionIdentity {
  package: string;
  tag: string;
  userId: number;
}

export interface MediaSessionInfo extends MediaSessionIdentity {
  /** `MediaSession.setActive` state. */
  active: boolean;
  state: MediaPlaybackState;
  /** Raw `PlaybackState` code; absent when the session never set a playback state. */
  stateCode?: number;
  positionMs?: number;
  /** Device `elapsedRealtime` at which `positionMs` was reported. */
  positionUpdatedAtMs?: number;
  speed?: number;
  /** `PlaybackState.ACTION_*` names, lower-cased, decoded from the actions bitmask. */
  actions: string[];
  metadata?: MediaSessionMetadata;
  /** True for the session hardware media keys (headset, Bluetooth, `dispatch`) go to. */
  isMediaButtonSession: boolean;
}

export interface MediaSessionDump {
  sessions: MediaSessionInfo[];
  /** The session that receives media button events now, or null when the dump names none. */
  mediaButtonSession: MediaSessionIdentity | null;
}
