import { ActionableError, toActionableError } from "../../models/ActionableError";
import type { ExecResult } from "../../models";
import type { AdbCommandRunner } from "../../utils/android-cmdline-tools/interfaces/AdbExecutor";
import type { Timer } from "../../utils/SystemTimer";
import { logger } from "../../utils/logger";
import { errorMessage } from "../../utils/describeUnknownError";
import { shellQuote } from "../../utils/shellQuote";
import { volumeSetScript } from "./AndroidVolume";
import { AospMediaSessionDumpParser, type MediaSessionDumpParser } from "./MediaSessionDumpParser";
import type {
  MediaDispatchKey,
  MediaPlaybackState,
  MediaSessionDump,
  MediaSessionIdentity,
  MediaSessionInfo,
  MediaVolumeStream,
} from "./MediaSessionTypes";

/** `AudioManager.STREAM_*` codes for the streams the tool exposes. */
const STREAM_CODES: Readonly<Record<MediaVolumeStream, number>> = {
  ring: 2,
  music: 3,
  alarm: 4,
};

const COMMAND_TIMEOUT_MS = 10_000;
const WAIT_POLL_MS = 250;
/** How long a dispatch waits for the handling session to report a new state. */
export const DISPATCH_SETTLE_TIMEOUT_MS = 2_000;
const DISPATCH_POLL_MS = 200;

/** Restores a transport-changed session to the state it was in before the dispatch. */
const RESTORING_KEYS: Partial<Record<MediaPlaybackState, MediaDispatchKey>> = {
  playing: "play",
  paused: "pause",
  stopped: "stop",
};

const TRACK_CHANGING_KEYS: ReadonlySet<MediaDispatchKey> = new Set(["next", "previous"]);

/** Output from `cmd` on a release without the `media_session` shell command. */
const COMMAND_UNAVAILABLE_MARKERS = [
  "No shell command implementation",
  "Can't find service",
  "Unknown command",
];

export interface MediaSessionWaitResult {
  mediaState: MediaPlaybackState;
  matched: boolean;
  waitMs: number;
  polls: number;
  dump: MediaSessionDump;
}

export interface MediaSessionDispatchResult {
  key: MediaDispatchKey;
  /** The media button session the key went to, or null when Android routed it to no session. */
  handledBy: MediaSessionIdentity | null;
  previousState?: MediaPlaybackState;
  state?: MediaPlaybackState;
  stateChanged: boolean;
  /** The dispatch that puts the handling session back into its previous state, when it changed. */
  restore?: { dispatch: MediaDispatchKey };
  dump: MediaSessionDump;
}

export interface MediaVolumeResult {
  stream: MediaVolumeStream;
  previousLevel: number;
  level: number;
  requestedLevel: number;
  min: number;
  max: number;
  changed: boolean;
  /** Read-back level equals the requested level. */
  verified: boolean;
  restore: { volume: { stream: MediaVolumeStream; level: number } };
}

/** Reads and drives Android media sessions for the `mediaSession` tool (#14117). */
export interface MediaSessionController {
  getSessions(request: { appId?: string; signal?: AbortSignal }): Promise<MediaSessionDump>;
  waitForState(request: {
    appId?: string;
    mediaState: MediaPlaybackState;
    timeoutMs: number;
    signal?: AbortSignal;
  }): Promise<MediaSessionWaitResult>;
  dispatch(request: {
    appId?: string;
    key: MediaDispatchKey;
    signal?: AbortSignal;
  }): Promise<MediaSessionDispatchResult>;
  setVolume(request: {
    stream: MediaVolumeStream;
    level: number;
    signal?: AbortSignal;
  }): Promise<MediaVolumeResult>;
}

function describeIdentity(identity: MediaSessionIdentity | null): string {
  return identity ? `${identity.package}/${identity.tag} (userId=${identity.userId})` : "none";
}

function sameIdentity(a: MediaSessionIdentity, b: MediaSessionIdentity): boolean {
  return a.package === b.package && a.tag === b.tag && a.userId === b.userId;
}

function findSession(
  dump: MediaSessionDump,
  identity: MediaSessionIdentity | null,
): MediaSessionInfo | undefined {
  return identity ? dump.sessions.find((session) => sameIdentity(session, identity)) : undefined;
}

function outputOf(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return "";
  }
  const stdout = "stdout" in value ? String(value.stdout) : "";
  const stderr = "stderr" in value ? String(value.stderr) : "";
  const message = value instanceof Error ? value.message : "";
  return `${stdout}\n${stderr}\n${message}`;
}

/** `cmd` either exits non-zero or prints a marker when the shell command does not exist. */
function isCommandUnavailable(value: unknown): boolean {
  const cause =
    value !== null && typeof value === "object" && "cause" in value ? value.cause : undefined;
  return [value, cause].some((candidate) =>
    COMMAND_UNAVAILABLE_MARKERS.some((marker) => outputOf(candidate).includes(marker)),
  );
}

/** `[v] volume is 7 in range [0..25]`, printed by the media shell's `volume --get`. */
export function parseVolume(output: string): { level: number; min: number; max: number } | null {
  const match = /volume is (\d+) in range \[(\d+)\.\.(\d+)\]/.exec(output);
  return match
    ? {
        level: Number.parseInt(match[1], 10),
        min: Number.parseInt(match[2], 10),
        max: Number.parseInt(match[3], 10),
      }
    : null;
}

/** What a dispatch changed on the session that handled it, with the key that undoes it. */
function dispatchOutcome(
  key: MediaDispatchKey,
  handledBy: MediaSessionIdentity | null,
  previousState: MediaPlaybackState | undefined,
  after: MediaSessionDump,
): MediaSessionDispatchResult {
  const state = findSession(after, handledBy)?.state;
  const stateChanged = previousState !== undefined && state !== previousState;
  // A track change cannot be undone by a transport key, so `next`/`previous` carry no receipt
  // even when the player briefly reports a skipping or buffering state.
  const restoringKey =
    previousState === undefined || TRACK_CHANGING_KEYS.has(key)
      ? undefined
      : RESTORING_KEYS[previousState];
  return {
    key,
    handledBy,
    ...(previousState === undefined ? {} : { previousState }),
    ...(state === undefined ? {} : { state }),
    stateChanged,
    ...(stateChanged && restoringKey ? { restore: { dispatch: restoringKey } } : {}),
    dump: after,
  };
}

export class AndroidMediaSessionController implements MediaSessionController {
  constructor(
    private readonly adb: AdbCommandRunner,
    private readonly timer: Timer,
    private readonly parser: MediaSessionDumpParser = new AospMediaSessionDumpParser(),
  ) {}

  async getSessions(request: { appId?: string; signal?: AbortSignal }): Promise<MediaSessionDump> {
    const dump = await this.readDump(request.signal);
    return request.appId === undefined
      ? dump
      : {
          ...dump,
          sessions: dump.sessions.filter((session) => session.package === request.appId),
        };
  }

  async waitForState(request: {
    appId?: string;
    mediaState: MediaPlaybackState;
    timeoutMs: number;
    signal?: AbortSignal;
  }): Promise<MediaSessionWaitResult> {
    const startedAt = this.timer.now();
    let polls = 0;
    while (true) {
      request.signal?.throwIfAborted();
      const dump = await this.getSessions(request);
      polls += 1;
      const waitMs = this.timer.now() - startedAt;
      const matched = dump.sessions.some((session) => session.state === request.mediaState);
      if (matched || waitMs >= request.timeoutMs) {
        return { mediaState: request.mediaState, matched, waitMs, polls, dump };
      }
      await this.timer.sleep(Math.min(WAIT_POLL_MS, request.timeoutMs - waitMs));
    }
  }

  async dispatch(request: {
    appId?: string;
    key: MediaDispatchKey;
    signal?: AbortSignal;
  }): Promise<MediaSessionDispatchResult> {
    const before = await this.readDump(request.signal);
    const target = before.mediaButtonSession;
    if (request.appId !== undefined && target?.package !== request.appId) {
      throw new ActionableError(
        `Media keys go to the current media button session (${describeIdentity(target)}), not ${request.appId}. ` +
          `Start or resume playback in ${request.appId} so it becomes the media button session, or omit appId. Nothing was dispatched.`,
      );
    }
    const previousState = findSession(before, target)?.state;
    await this.runMediaCommand(`dispatch ${request.key}`, request.signal);
    const after = await this.awaitDispatchOutcome(target, previousState, request.signal);
    return dispatchOutcome(request.key, target ?? after.mediaButtonSession, previousState, after);
  }

  async setVolume(request: {
    stream: MediaVolumeStream;
    level: number;
    signal?: AbortSignal;
  }): Promise<MediaVolumeResult> {
    const streamCode = STREAM_CODES[request.stream];
    const before = await this.readVolume(streamCode, request.signal);
    if (request.level < before.min || request.level > before.max) {
      throw new ActionableError(
        `Volume level ${request.level} is outside the ${request.stream} stream's range [${before.min}..${before.max}]. Nothing was changed.`,
      );
    }
    if (request.level !== before.level) {
      const set = await this.tryCommand(
        `shell sh -c ${shellQuote(volumeSetScript(streamCode, request.level))}`,
        request.signal,
      );
      if (set.unavailable) {
        // Preserve the standalone `media` fallback on releases without either cmd setter.
        await this.runMediaCommand(
          `volume --stream ${streamCode} --set ${request.level}`,
          request.signal,
        );
      }
    }
    const after = await this.readVolume(streamCode, request.signal);
    return {
      stream: request.stream,
      previousLevel: before.level,
      level: after.level,
      requestedLevel: request.level,
      min: after.min,
      max: after.max,
      changed: after.level !== before.level,
      verified: after.level === request.level,
      restore: { volume: { stream: request.stream, level: before.level } },
    };
  }

  /** Re-reads until the handling session reports a new state, or the settle window ends. */
  private async awaitDispatchOutcome(
    target: MediaSessionIdentity | null,
    previousState: MediaPlaybackState | undefined,
    signal: AbortSignal | undefined,
  ): Promise<MediaSessionDump> {
    const deadline = this.timer.now() + DISPATCH_SETTLE_TIMEOUT_MS;
    while (true) {
      const dump = await this.readDump(signal);
      const handledBy = target ?? dump.mediaButtonSession;
      const state = findSession(dump, handledBy)?.state;
      const settled = handledBy !== null && state !== undefined && state !== previousState;
      if (settled || this.timer.now() >= deadline) {
        return dump;
      }
      await this.timer.sleep(DISPATCH_POLL_MS);
    }
  }

  private async readDump(signal: AbortSignal | undefined): Promise<MediaSessionDump> {
    signal?.throwIfAborted();
    try {
      const result = await this.adb.executeCommand("shell dumpsys media_session", {
        timeoutMs: COMMAND_TIMEOUT_MS,
        signal,
      });
      return this.parser.parse(result.stdout);
    } catch (error) {
      signal?.throwIfAborted();
      throw toActionableError(error, "Failed to read dumpsys media_session");
    }
  }

  private async readVolume(
    streamCode: number,
    signal: AbortSignal | undefined,
  ): Promise<{ level: number; min: number; max: number }> {
    const result = await this.runMediaCommand(`volume --stream ${streamCode} --get`, signal);
    const volume = parseVolume(`${result.stdout}\n${result.stderr}`);
    if (!volume) {
      throw new ActionableError(
        `Could not read the volume of stream ${streamCode}: unexpected output ${JSON.stringify(result.stdout.trim().slice(0, 200))}`,
      );
    }
    return volume;
  }

  /**
   * Runs a media shell subcommand: `cmd media_session` (Android 11+), falling back to the
   * `media` shell tool that older releases ship when `cmd` reports no such command.
   */
  private async runMediaCommand(
    subcommand: string,
    signal: AbortSignal | undefined,
  ): Promise<ExecResult> {
    const primary = await this.tryCommand(`shell cmd media_session ${subcommand}`, signal);
    if (!primary.unavailable) {
      return primary.result;
    }
    const fallback = await this.tryCommand(`shell media ${subcommand}`, signal);
    if (fallback.unavailable) {
      throw new ActionableError(
        `This device has neither 'cmd media_session' nor the 'media' shell command, so 'media ${subcommand}' cannot run.`,
      );
    }
    return fallback.result;
  }

  private async tryCommand(
    command: string,
    signal: AbortSignal | undefined,
  ): Promise<{ unavailable: true } | { unavailable: false; result: ExecResult }> {
    signal?.throwIfAborted();
    try {
      const result = await this.adb.executeCommand(command, {
        timeoutMs: COMMAND_TIMEOUT_MS,
        signal,
      });
      return isCommandUnavailable(result) ? { unavailable: true } : { unavailable: false, result };
    } catch (error) {
      signal?.throwIfAborted();
      if (isCommandUnavailable(error)) {
        // Expected on releases without this shell command; the caller falls back to `media`.
        logger.debug(`adb ${command} is unavailable on this device: ${errorMessage(error)}`);
        return { unavailable: true };
      }
      throw toActionableError(error, `Failed to run adb ${command}`);
    }
  }
}
