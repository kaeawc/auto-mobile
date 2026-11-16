import contract from "../../../schemas/prototype-spec-contract.json";

/**
 * The deterministic fake media engine (#14257), the twin of Kotlin's and Swift's
 * `PrototypeFakeMediaEngine`. All three replay `test/fixtures/prototype-media-sim`.
 *
 * Nothing decodes. Time is virtual: it moves only when the runtime's injected clock calls
 * `advance`, so a playing player's position, end of media and looping are exact. `simulate`
 * applies a `media.*` event from `prototype simulate`. Events are reported only on status or
 * `playing` transitions, never on position ticks, and `buffering` stalls the playhead without one.
 */

export const PROTOTYPE_MEDIA_ERROR_CODES = contract.platformModules.media.state.error.value
  .values as [string, ...string[]];

/** The statuses `media.statusChanged` can drive a fake player into. */
/** The media status a failed player reports; named so status checks never read as literals. */
export const PROTOTYPE_MEDIA_ERROR_STATUS = "error";

export const PROTOTYPE_MEDIA_SIM_STATUSES = ["buffering", "ready", "ended", "error"] as const;
export type PrototypeMediaSimStatus = (typeof PROTOTYPE_MEDIA_SIM_STATUSES)[number];

export const PROTOTYPE_MEDIA_SIM_EVENTS = [
  "media.statusChanged",
  "media.ended",
  "media.error",
] as const;
export type PrototypeMediaSimEvent = (typeof PROTOTYPE_MEDIA_SIM_EVENTS)[number];

/** One player's `/platform/media/players/<id>` state; `error` is present only in `error`. */
export interface PrototypeFakeMediaState {
  playing: boolean;
  positionMs: number;
  durationMs: number;
  buffering: boolean;
  status: "idle" | "loading" | "ready" | "ended" | "error";
  error?: string;
}

export interface PrototypeFakeMediaEvent {
  name: PrototypeMediaSimEvent;
  payload: Record<string, unknown>;
}

export interface PrototypeMediaSimRequest {
  event: PrototypeMediaSimEvent;
  player: string;
  /** `media.statusChanged` only. */
  status?: PrototypeMediaSimStatus;
  /** Required when the event drives the player into `error`. */
  code?: string;
  /** Advance the virtual clock by this much before applying the event. */
  advanceMs?: number;
}

export type PrototypeFakeMediaFailure = "unknown_player" | "invalid_args";
export type PrototypeFakeMediaResult =
  | { success: true }
  | { success: false; code: PrototypeFakeMediaFailure };

interface Player {
  state: PrototypeFakeMediaState;
  loop: boolean;
}

const OK: PrototypeFakeMediaResult = { success: true };

export class PrototypeFakeMediaEngine {
  private readonly players = new Map<string, Player>();
  private readonly emitted: PrototypeFakeMediaEvent[] = [];

  /** Every event reported so far, oldest first. */
  get events(): readonly PrototypeFakeMediaEvent[] {
    return this.emitted;
  }

  /** `/platform/media`: every loaded player's state, in load order. */
  snapshot(): { players: Record<string, PrototypeFakeMediaState> } {
    return {
      players: Object.fromEntries(
        [...this.players].map(([id, player]) => [id, { ...player.state }]),
      ),
    };
  }

  /** Load a player paused at 0; `durationMs` is `-1` when the source has no known end. */
  load(player: string, durationMs: number, loop = false): void {
    this.players.set(player, {
      loop,
      state: { playing: false, positionMs: 0, durationMs, buffering: false, status: "ready" },
    });
    this.statusChanged(player, this.players.get(player)!.state);
  }

  play(player: string): PrototypeFakeMediaResult {
    return this.update(player, (state) => {
      if (state.status === PROTOTYPE_MEDIA_ERROR_STATUS) {
        return;
      }
      if (state.status === "ended") {
        state.positionMs = 0;
        state.status = "ready";
      }
      state.playing = true;
    });
  }

  pause(player: string): PrototypeFakeMediaResult {
    return this.update(player, (state) => {
      state.playing = false;
    });
  }

  seek(player: string, positionMs: number): PrototypeFakeMediaResult {
    return this.update(player, (state) => {
      if (state.status === PROTOTYPE_MEDIA_ERROR_STATUS) {
        return;
      }
      const end = state.durationMs >= 0 ? state.durationMs : Number.MAX_SAFE_INTEGER;
      state.positionMs = Math.min(Math.max(0, positionMs), end);
      if (state.status === "ended" && state.positionMs < end) {
        state.status = "ready";
      }
    });
  }

  /** Move the virtual clock: playing, ready, non-buffering players advance, end or loop. */
  advance(ms: number): void {
    for (const [id, player] of this.players) {
      const state = player.state;
      if (!state.playing || state.buffering || state.status !== "ready") {
        continue;
      }
      state.positionMs += ms;
      if (state.durationMs < 0 || state.positionMs < state.durationMs) {
        continue;
      }
      if (player.loop) {
        state.positionMs = state.durationMs === 0 ? 0 : state.positionMs % state.durationMs;
        continue;
      }
      this.end(id, state);
    }
  }

  simulate(request: PrototypeMediaSimRequest): PrototypeFakeMediaResult {
    const player = this.players.get(request.player);
    if (!player) {
      return { success: false, code: "unknown_player" };
    }
    const status = targetStatus(request);
    if (
      status === undefined ||
      (status === "error" && !PROTOTYPE_MEDIA_ERROR_CODES.includes(request.code ?? ""))
    ) {
      return { success: false, code: "invalid_args" };
    }
    if (request.advanceMs !== undefined) {
      this.advance(request.advanceMs);
    }
    const state = player.state;
    if (status === "buffering") {
      state.buffering = true;
    } else if (status === "ready") {
      this.update(request.player, (next) => {
        next.buffering = false;
        next.status = "ready";
        delete next.error;
      });
    } else if (status === "ended") {
      state.buffering = false;
      this.end(request.player, state);
    } else {
      this.fail(request.player, state, request.code!);
    }
    return OK;
  }

  release(player: string): PrototypeFakeMediaResult {
    return this.players.delete(player) ? OK : { success: false, code: "unknown_player" };
  }

  private update(
    player: string,
    change: (state: PrototypeFakeMediaState) => void,
  ): PrototypeFakeMediaResult {
    const state = this.players.get(player)?.state;
    if (!state) {
      return { success: false, code: "unknown_player" };
    }
    const before = { status: state.status, playing: state.playing };
    change(state);
    if (before.status !== state.status || before.playing !== state.playing) {
      this.statusChanged(player, state);
    }
    return OK;
  }

  private end(player: string, state: PrototypeFakeMediaState): void {
    const wasEnded = state.status === "ended";
    this.update(player, (next) => {
      next.playing = false;
      next.positionMs = next.durationMs >= 0 ? next.durationMs : next.positionMs;
      next.status = "ended";
      delete next.error;
    });
    if (!wasEnded) {
      this.emitted.push({ name: "media.ended", payload: { player } });
    }
  }

  private fail(player: string, state: PrototypeFakeMediaState, code: string): void {
    const unchanged = state.status === PROTOTYPE_MEDIA_ERROR_STATUS && state.error === code;
    this.update(player, (next) => {
      next.playing = false;
      next.buffering = false;
      next.status = "error";
      next.error = code;
    });
    if (!unchanged) {
      this.emitted.push({ name: "media.error", payload: { player, code } });
    }
  }

  private statusChanged(player: string, state: PrototypeFakeMediaState): void {
    this.emitted.push({
      name: "media.statusChanged",
      payload: {
        player,
        status: state.status,
        playing: state.playing,
        positionMs: state.positionMs,
      },
    });
  }
}

function targetStatus(request: PrototypeMediaSimRequest): PrototypeMediaSimStatus | undefined {
  if (request.event === "media.ended") {
    return "ended";
  }
  if (request.event === "media.error") {
    return "error";
  }
  return request.status;
}
