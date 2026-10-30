/**
 * Frame coalescing for realtime channels (#14261). Within one flush window
 * (`PROTOTYPE_CHANNEL_FLUSH_MS`) consecutive frames whose matched actions are only `setData` /
 * `setState` to the same targets collapse to the last one, so a 30 Hz location feed rebuilds the
 * tree once per window instead of 30 times a second. Appends and every other action are never
 * coalesced. One pure function shared by the device runtimes and pinned by
 * `test/fixtures/prototype-spec/realtime/coalesce.json`.
 */
export interface PrototypeChannelResolvedAction {
  type: string;
  /** The `/data/...` path of a data action. */
  path?: string;
  /** The state key of a `setState`. */
  key?: string;
  [field: string]: unknown;
}

/** The actions one frame produced after its routes matched and `{event}` values were bound. */
export type PrototypeChannelFrameActions = readonly PrototypeChannelResolvedAction[];

function targetOf(action: PrototypeChannelResolvedAction): string | undefined {
  if (action.type === "setData" && typeof action.path === "string") {
    return `data:${action.path}`;
  }
  return action.type === "setState" && typeof action.key === "string"
    ? `state:${action.key}`
    : undefined;
}

/** The sorted, deduplicated targets of a frame made only of coalescable writes, else undefined. */
function coalesceSignature(frame: PrototypeChannelFrameActions): string | undefined {
  const targets = frame.map(targetOf);
  if (frame.length === 0 || targets.some((target) => target === undefined)) {
    return undefined;
  }
  return JSON.stringify([...new Set(targets as string[])].sort());
}

/** The frames of one flush window with each run of same-target write frames reduced to its last. */
export function coalescePrototypeChannelFrames(
  frames: readonly PrototypeChannelFrameActions[],
): PrototypeChannelFrameActions[] {
  const kept: PrototypeChannelFrameActions[] = [];
  let previous: string | undefined;
  for (const frame of frames) {
    const signature = coalesceSignature(frame);
    if (signature !== undefined && signature === previous) {
      kept[kept.length - 1] = frame;
    } else {
      kept.push(frame);
    }
    previous = signature;
  }
  return kept;
}
