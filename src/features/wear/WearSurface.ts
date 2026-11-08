import { toActionableError } from "../../models/ActionableError";
import type { AdbCommandRunner } from "../../utils/android-cmdline-tools/interfaces/AdbExecutor";
import type { Timer } from "../../utils/SystemTimer";

/**
 * Wear OS tile carousel control over the system debug broadcasts (#17495, measured in #16824).
 * `add-tile`/`remove-tile` go to DEBUG_SURFACE and `show-tile` to DEBUG_SYSUI. The broadcasts
 * report success when nothing happened (`remove-tile` of an absent tile, `show-tile` of an
 * out-of-range index), so a shown tile is only reported once an observe confirms it.
 */
export const DEBUG_SURFACE_ACTION = "com.google.android.wearable.app.DEBUG_SURFACE";
export const DEBUG_SYSUI_ACTION = "com.google.android.wearable.app.DEBUG_SYSUI";
/** Wear system UI package; it hosts both the watch face and the shown tile. */
export const WEAR_SYSUI_PACKAGE = "com.google.android.clockwork.sysui";
/** The carousel animation took about 2-3 s on the measured emulator. */
export const SHOW_TILE_SETTLE_MS = 3_000;
const COMMAND_TIMEOUT_MS = 10_000;

export const WEAR_SURFACE_ACTIONS = ["addTile", "showTile", "removeTile"] as const;
export type WearSurfaceAction = (typeof WEAR_SURFACE_ACTIONS)[number];

/** `<package>/<service>`; the service may use the `.Name` shorthand. No shell metacharacters. */
export const TILE_COMPONENT_PATTERN = /^[A-Za-z][\w.]*\/\.?[A-Za-z_][\w.]*$/;

export const BROADCAST_OUTCOMES = [
  "added",
  "removed",
  "showRequested",
  "providerNotFound",
  "missingComponent",
  "indexRequired",
  "unrecognizedOperation",
  "unknown",
] as const;
export type BroadcastOutcome = (typeof BROADCAST_OUTCOMES)[number];

export interface ParsedBroadcast {
  /** The `result=` code, or null when no `Broadcast completed` line was printed. */
  code: number | null;
  data?: string;
}

export interface ClassifiedBroadcast extends ParsedBroadcast {
  outcome: BroadcastOutcome;
  /** The positional tile index from `Index=[n]` (added). */
  index?: number;
  /** The operation named by an `Unrecognized operation <op>` reply. */
  operation?: string;
}

const COMPLETED_LINE = /^Broadcast completed: result=(-?\d+)(?:, data="(.*)")?\s*$/m;
const INDEX_DATA = /^Index=\[(\d+)\]$/;
const UNRECOGNIZED = /^Unrecognized operation (.+)$/;

/** Reads the `Broadcast completed: result=<n>[, data="<text>"]` line of `am broadcast`. */
export function parseBroadcastOutput(stdout: string): ParsedBroadcast {
  const match = COMPLETED_LINE.exec(stdout.replace(/\r\n/g, "\n"));
  if (!match) {
    return { code: null };
  }
  return { code: Number(match[1]), ...(match[2] !== undefined ? { data: match[2] } : {}) };
}

/**
 * Maps a broadcast reply to a typed outcome by its data text first and its code second, so a
 * reply this release does not know reads as `unknown` instead of a guessed success.
 */
export function classifyBroadcast(
  operation: SurfaceOperation,
  parsed: ParsedBroadcast,
): ClassifiedBroadcast {
  const { data } = parsed;
  const unrecognized = data === undefined ? null : UNRECOGNIZED.exec(data);
  if (unrecognized) {
    return { ...parsed, outcome: "unrecognizedOperation", operation: unrecognized[1] };
  }
  const refusal = REFUSALS.find((rule) => data !== undefined && rule.matches(data));
  if (refusal) {
    return { ...parsed, outcome: refusal.outcome };
  }
  return parsed.code === 1 ? { ...parsed, ...SUCCESSES[operation](data) } : unknown(parsed);
}

function unknown(parsed: ParsedBroadcast): ClassifiedBroadcast {
  return { ...parsed, outcome: "unknown" };
}

type SurfaceOperation = "add-tile" | "remove-tile" | "show-tile";

/** Refusal replies, recognized by their data text whatever the result code. */
const REFUSALS: ReadonlyArray<{ outcome: BroadcastOutcome; matches: (data: string) => boolean }> = [
  { outcome: "missingComponent", matches: (data) => data === "A component name is required." },
  { outcome: "indexRequired", matches: (data) => data === "An index is required." },
  {
    outcome: "providerNotFound",
    matches: (data) => data.includes("Requested tile provider does not exist"),
  },
];

/** The `result=1` reply each operation prints when it succeeds; anything else is unknown. */
const SUCCESSES: Readonly<
  Record<SurfaceOperation, (data?: string) => Pick<ClassifiedBroadcast, "outcome" | "index">>
> = {
  "add-tile": (data) => {
    const index = data === undefined ? null : INDEX_DATA.exec(data);
    return index ? { outcome: "added", index: Number(index[1]) } : { outcome: "unknown" };
  },
  "remove-tile": (data) => ({ outcome: data === "Tile(s) removed." ? "removed" : "unknown" }),
  "show-tile": (data) => ({ outcome: data === undefined ? "showRequested" : "unknown" }),
};

/** What an observe of the watch says about the screen; fields are absent when unreadable. */
export interface SurfaceSnapshot {
  /** Foreground app of the active window. */
  appId?: string;
  /** Positive evidence of the tile carousel container in the observed hierarchy. */
  tileShowing?: boolean;
}

export type SurfaceObserver = (signal?: AbortSignal) => Promise<SurfaceSnapshot>;

export type TileTarget = { component: string } | { index: number };

export interface WearSurfaceResult {
  success: boolean;
  action: WearSurfaceAction;
  requested: { component?: string; index?: number };
  /** The broadcast that performs the action. */
  broadcastResult: ClassifiedBroadcast;
  /** showTile by component: the `add-tile` reply that resolved the current index. */
  indexResolution?: ClassifiedBroadcast;
  index?: number;
  /** True only when an observe after the action confirmed it. */
  verified: boolean;
  message: string;
  reason?: string;
}

export interface WearSurface {
  addTile(component: string, signal?: AbortSignal): Promise<WearSurfaceResult>;
  removeTile(component: string, signal?: AbortSignal): Promise<WearSurfaceResult>;
  showTile(target: TileTarget, signal?: AbortSignal): Promise<WearSurfaceResult>;
}

export interface WearSurfaceDeps {
  adb: AdbCommandRunner;
  timer: Timer;
  observe: SurfaceObserver;
}

const FAILURE_REASONS: Partial<Record<BroadcastOutcome, string>> = {
  providerNotFound:
    "The tile provider does not exist on this watch. Check the component (package/service of a service handling androidx.wear.tiles.action.BIND_TILE_PROVIDER).",
  missingComponent: "The broadcast was sent without a component name.",
  indexRequired: "The broadcast was sent without a tile index.",
  unrecognizedOperation:
    "This Wear OS build does not recognize the operation; its debug surface broadcasts may differ from the verified Wear OS 7 emulator.",
};

function failureReason(reply: ClassifiedBroadcast): string {
  return (
    FAILURE_REASONS[reply.outcome] ??
    (reply.code === null
      ? "The broadcast printed no result; the debug receiver may be missing on this build."
      : `Unexpected broadcast reply result=${reply.code}${reply.data !== undefined ? `, data="${reply.data}"` : ""}.`)
  );
}

export class AdbWearSurface implements WearSurface {
  constructor(private readonly deps: WearSurfaceDeps) {}

  async addTile(component: string, signal?: AbortSignal): Promise<WearSurfaceResult> {
    const reply = await this.addTileBroadcast(component, signal);
    const added = reply.outcome === "added";
    return {
      success: added,
      action: "addTile",
      requested: { component },
      broadcastResult: reply,
      ...(reply.index !== undefined ? { index: reply.index } : {}),
      verified: false,
      message: added
        ? `The tile is in the carousel at index ${reply.index} (add-tile is idempotent: it may already have been there). Not observed; use showTile to confirm it renders.`
        : "The tile was not added.",
      ...(added ? {} : { reason: failureReason(reply) }),
    };
  }

  async removeTile(component: string, signal?: AbortSignal): Promise<WearSurfaceResult> {
    const reply = classifyBroadcast(
      "remove-tile",
      await this.broadcast(
        DEBUG_SURFACE_ACTION,
        "remove-tile",
        `--ecn component ${component}`,
        signal,
      ),
    );
    const removed = reply.outcome === "removed";
    return {
      success: removed,
      action: "removeTile",
      requested: { component },
      broadcastResult: reply,
      verified: false,
      message: removed
        ? "The tile was removed or was not present; the broadcast does not say which. Not observed."
        : "The tile was not removed.",
      ...(removed ? {} : { reason: failureReason(reply) }),
    };
  }

  async showTile(target: TileTarget, signal?: AbortSignal): Promise<WearSurfaceResult> {
    const requested =
      "component" in target ? { component: target.component } : { index: target.index };
    let indexResolution: ClassifiedBroadcast | undefined;
    let index: number;
    if ("component" in target) {
      // Indexes shift whenever a tile is added, so resolve the current one right before showing.
      indexResolution = await this.addTileBroadcast(target.component, signal);
      if (indexResolution.outcome !== "added" || indexResolution.index === undefined) {
        return {
          success: false,
          action: "showTile",
          requested,
          broadcastResult: indexResolution,
          indexResolution,
          verified: false,
          message: "The tile index could not be resolved, so nothing was shown.",
          reason: failureReason(indexResolution),
        };
      }
      index = indexResolution.index;
    } else {
      index = target.index;
    }
    const reply = classifyBroadcast(
      "show-tile",
      await this.broadcast(DEBUG_SYSUI_ACTION, "show-tile", `--ei index ${index}`, signal),
    );
    const base = {
      action: "showTile" as const,
      requested,
      broadcastResult: reply,
      ...(indexResolution ? { indexResolution } : {}),
      index,
    };
    if (reply.outcome !== "showRequested") {
      return {
        ...base,
        success: false,
        verified: false,
        message: "The tile was not shown.",
        reason: failureReason(reply),
      };
    }
    await this.deps.timer.sleep(SHOW_TILE_SETTLE_MS);
    signal?.throwIfAborted();
    const after = await this.deps.observe(signal);
    const unverified = verificationGap(after);
    return {
      ...base,
      success: unverified === undefined,
      verified: unverified === undefined,
      message:
        unverified === undefined
          ? `The show-tile broadcast was accepted for index ${index}; an observe confirmed a tile container in the foreground Wear system UI (tile identity is not verified).`
          : `The show-tile broadcast was accepted for index ${index}, but the observe did not confirm a tile.`,
      ...(unverified !== undefined ? { reason: unverified } : {}),
    };
  }

  private async addTileBroadcast(component: string, signal?: AbortSignal) {
    return classifyBroadcast(
      "add-tile",
      await this.broadcast(
        DEBUG_SURFACE_ACTION,
        "add-tile",
        `--ecn component ${component}`,
        signal,
      ),
    );
  }

  private async broadcast(
    action: string,
    operation: string,
    extras: string,
    signal?: AbortSignal,
  ): Promise<ParsedBroadcast> {
    const command = `shell am broadcast -a ${action} --es operation ${operation} ${extras}`;
    try {
      signal?.throwIfAborted();
      const result = await this.deps.adb.executeCommand(command, {
        timeoutMs: COMMAND_TIMEOUT_MS,
        noRetry: true,
        signal,
      });
      return parseBroadcastOutput(result.stdout);
    } catch (error) {
      throw toActionableError(error, `Failed to run adb ${command}`);
    }
  }
}

/** The watch face shares sysui, so only the tile container is positive tile evidence. */
function verificationGap(after: SurfaceSnapshot): string | undefined {
  if (after.appId !== WEAR_SYSUI_PACKAGE) {
    return `The foreground after the broadcast is ${after.appId ?? "unknown"}, not the Wear system UI (${WEAR_SYSUI_PACKAGE}).`;
  }
  if (after.tileShowing !== true) {
    return "The observed hierarchy did not contain the tile container: the index may be out of range or the hierarchy could not be read (is CtrlProxy enabled?).";
  }
  return undefined;
}
