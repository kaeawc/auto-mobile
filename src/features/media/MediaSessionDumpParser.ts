import type {
  MediaPlaybackState,
  MediaSessionDump,
  MediaSessionIdentity,
  MediaSessionInfo,
  MediaSessionMetadata,
} from "./MediaSessionTypes";

/** Turns `adb shell dumpsys media_session` output into typed sessions (#14117). */
export interface MediaSessionDumpParser {
  parse(dumpsysOutput: string): MediaSessionDump;
}

/** `PlaybackState.STATE_*` codes, indexed by code. */
const PLAYBACK_STATES_BY_CODE: readonly MediaPlaybackState[] = [
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
];

/**
 * `PlaybackState.ACTION_*` (and `PlaybackStateCompat`, bits 18-21), indexed by bit.
 * The framework writes the bitmask as a decimal long.
 */
const PLAYBACK_ACTIONS_BY_BIT: readonly string[] = [
  "stop",
  "pause",
  "play",
  "rewind",
  "skip_to_previous",
  "skip_to_next",
  "fast_forward",
  "set_rating",
  "seek_to",
  "play_pause",
  "play_from_media_id",
  "play_from_search",
  "skip_to_queue_item",
  "play_from_uri",
  "prepare",
  "prepare_from_media_id",
  "prepare_from_search",
  "prepare_from_uri",
  "set_repeat_mode",
  "set_shuffle_mode_enabled",
  "set_captioning_enabled",
  "set_shuffle_mode",
  "set_playback_speed",
];

/** `MediaSessionRecord.toString()`: `<package>/<tag> (userId=<n>)`. */
const IDENTITY_PATTERN = /([A-Za-z][\w.]*)\/(.*) \(userId=(\d+)\)$/;
/** A session record's first line: `<indent><tag> <package>/<tag> (userId=<n>)`. */
const SESSION_HEADER_PATTERN = /^(\s+)\S.* ([A-Za-z][\w.]*)\/(.*) \(userId=(\d+)\)$/;
const MEDIA_BUTTON_SESSION_PATTERN = /Media button session is (.+)$/;

function indentOf(line: string): number {
  return line.length - line.trimStart().length;
}

function parseIdentity(text: string): MediaSessionIdentity | null {
  const match = IDENTITY_PATTERN.exec(text.trim());
  return match ? { package: match[1], tag: match[2], userId: Number.parseInt(match[3], 10) } : null;
}

function sameIdentity(a: MediaSessionIdentity, b: MediaSessionIdentity | null): boolean {
  return b !== null && a.package === b.package && a.tag === b.tag && a.userId === b.userId;
}

function intField(text: string, pattern: RegExp): number | undefined {
  const match = pattern.exec(text);
  return match ? Number.parseInt(match[1], 10) : undefined;
}

/** Bit test that stays exact above 2^31, where JavaScript bitwise operators would truncate. */
function hasBit(mask: number, bit: number): boolean {
  return Math.floor(mask / 2 ** bit) % 2 === 1;
}

export function decodePlaybackActions(mask: number): string[] {
  return PLAYBACK_ACTIONS_BY_BIT.filter((_, bit) => hasBit(mask, bit));
}

export function playbackStateForCode(code: number): MediaPlaybackState {
  return PLAYBACK_STATES_BY_CODE[code] ?? "unknown";
}

type PlaybackFields = Pick<
  MediaSessionInfo,
  "state" | "stateCode" | "positionMs" | "positionUpdatedAtMs" | "speed" | "actions"
>;

const NO_PLAYBACK_STATE: PlaybackFields = { state: "none", actions: [] };

/**
 * `PlaybackState.toString()`. API 33+ writes `state=PLAYING(3)`; earlier releases
 * write the bare code, `state=3`. Either way the code is authoritative.
 */
function parsePlaybackState(value: string): PlaybackFields {
  const stateCode = intField(value, /\{state=(?:[A-Z_]+\()?(-?\d+)/);
  if (stateCode === undefined) {
    return NO_PLAYBACK_STATE;
  }
  const speedMatch = /[{,] speed=(-?[\d.]+(?:[eE]-?\d+)?)/.exec(value);
  const actionsMask = intField(value, /[{,] actions=(\d+)/);
  return {
    state: playbackStateForCode(stateCode),
    stateCode,
    positionMs: intField(value, /[{,] position=(-?\d+)/),
    positionUpdatedAtMs: intField(value, /[{,] updated=(-?\d+)/),
    speed: speedMatch ? Number.parseFloat(speedMatch[1]) : undefined,
    actions: actionsMask === undefined ? [] : decodePlaybackActions(actionsMask),
  };
}

function nullable(part: string | undefined): string | undefined {
  const trimmed = part?.trim();
  return trimmed && trimmed !== "null" ? trimmed : undefined;
}

/**
 * `metadata: size=<n>, description=<title>, <subtitle>, <description>` (older
 * releases omit the space after the colon). The description fields are split only
 * when there are exactly three, because a comma inside a title is indistinguishable
 * from the separator.
 */
function parseMetadata(value: string): MediaSessionMetadata | undefined {
  if (value.trim() === "null") {
    return undefined;
  }
  const size = intField(value, /size=(\d+)/);
  const descriptionIndex = value.indexOf("description=");
  const description =
    descriptionIndex >= 0 ? value.slice(descriptionIndex + "description=".length) : undefined;
  const parts = description?.split(", ") ?? [];
  const positional =
    parts.length === 3
      ? { title: nullable(parts[0]), artist: nullable(parts[1]), album: nullable(parts[2]) }
      : {};
  const metadata: MediaSessionMetadata = {
    ...positional,
    ...(nullable(description) ? { description } : {}),
    ...(size === undefined ? {} : { size }),
  };
  return Object.values(metadata).some((field) => field !== undefined) ? metadata : undefined;
}

interface SessionBlock {
  header: MediaSessionIdentity;
  lines: string[];
}

function nextNonBlank(lines: readonly string[], from: number): string | undefined {
  return lines.slice(from).find((line) => line.trim() !== "");
}

/** Session records are the header lines immediately followed by an `ownerPid=` line. */
function sessionBlocks(lines: readonly string[]): SessionBlock[] {
  const blocks: SessionBlock[] = [];
  let current: { block: SessionBlock; indent: number } | null = null;
  for (const [index, line] of lines.entries()) {
    const header = SESSION_HEADER_PATTERN.exec(line);
    if (
      header &&
      nextNonBlank(lines, index + 1)
        ?.trim()
        .startsWith("ownerPid=")
    ) {
      const identity = {
        package: header[2],
        tag: header[3],
        userId: Number.parseInt(header[4], 10),
      };
      current = { block: { header: identity, lines: [] }, indent: header[1].length };
      blocks.push(current.block);
    } else if (current && line.trim() !== "" && indentOf(line) > current.indent) {
      current.block.lines.push(line.trim());
    } else if (current && line.trim() !== "") {
      current = null;
    }
  }
  return blocks;
}

function fieldValue(lines: readonly string[], pattern: RegExp): string | undefined {
  for (const line of lines) {
    const match = pattern.exec(line);
    if (match) {
      return match[1];
    }
  }
  return undefined;
}

function toSession(
  block: SessionBlock,
  mediaButton: MediaSessionIdentity | null,
): MediaSessionInfo {
  const identity: MediaSessionIdentity = {
    ...block.header,
    package: fieldValue(block.lines, /^package=(\S+)$/) ?? block.header.package,
  };
  const playback = fieldValue(block.lines, /^state=(.*)$/);
  const metadata = fieldValue(block.lines, /^metadata:\s*(.*)$/);
  const parsedMetadata = metadata === undefined ? undefined : parseMetadata(metadata);
  return {
    ...identity,
    active: fieldValue(block.lines, /^active=(\w+)$/) === "true",
    ...(playback === undefined ? NO_PLAYBACK_STATE : parsePlaybackState(playback)),
    ...(parsedMetadata ? { metadata: parsedMetadata } : {}),
    isMediaButtonSession: sameIdentity(identity, mediaButton),
  };
}

/**
 * Parses the AOSP `MediaSessionService` dump: each user record's
 * `Media button session is ...` line and its `Sessions Stack` of `MediaSessionRecord`
 * dumps. Lines it does not recognise are ignored, so additions in newer releases
 * (volume control ids, media2 session sections) do not break it.
 */
export class AospMediaSessionDumpParser implements MediaSessionDumpParser {
  parse(dumpsysOutput: string): MediaSessionDump {
    const lines = dumpsysOutput.split(/\r?\n/);
    const mediaButtonSession =
      lines
        .map((line) => MEDIA_BUTTON_SESSION_PATTERN.exec(line)?.[1])
        .map((text) => (text === undefined ? null : parseIdentity(text)))
        .find((identity) => identity !== null) ?? null;
    return {
      sessions: sessionBlocks(lines).map((block) => toSession(block, mediaButtonSession)),
      mediaButtonSession,
    };
  }
}
