import { ActionableError } from "../../../models/ActionableError";
import {
  isRenderOverlay,
  RENDER_OVERLAYS,
  type RenderOverlay,
  type SimulatorRenderOverlayControl,
} from "../../../utils/ios-cmdline-tools/SimulatorRenderOverlays";
import type { Timer } from "../../../utils/SystemTimer";
import type { DeviceMutationResetContext } from "./reset";
import type { DeviceMutationInput } from "./types";

/** Journal key prefix of a Simulator render overlay `device-setting` row (#19016). */
export const RENDER_OVERLAY_KEY_PREFIX = "renderOverlay:";

export function renderOverlayKey(overlay: RenderOverlay): string {
  return `${RENDER_OVERLAY_KEY_PREFIX}${overlay}`;
}

/** The overlay a journal key names, or undefined for any other key. */
export function renderOverlayFromKey(key: string): RenderOverlay | undefined {
  if (!key.startsWith(RENDER_OVERLAY_KEY_PREFIX)) {
    return undefined;
  }
  const overlay = key.slice(RENDER_OVERLAY_KEY_PREFIX.length);
  return isRenderOverlay(overlay) ? overlay : undefined;
}

/**
 * Restore every given overlay row of one device through a single CoreSimulator call, then verify
 * the read-back. Rows arrive newest first, so the oldest prior of an overlay wins.
 */
export async function restoreRenderOverlays(
  control: Pick<SimulatorRenderOverlayControl, "set"> | undefined,
  timer: Pick<Timer, "now">,
  mutations: readonly DeviceMutationInput[],
  context: DeviceMutationResetContext,
): Promise<void> {
  const values: Partial<Record<RenderOverlay, boolean>> = {};
  for (const mutation of mutations) {
    const overlay = renderOverlayFromKey(mutation.key);
    const prior = mutation.priorValue.state === "present" ? mutation.priorValue.value : undefined;
    if (overlay === undefined || typeof prior !== "boolean" || control === undefined) {
      throw new ActionableError(`iOS cannot restore render overlay ${mutation.key}`);
    }
    values[overlay] = prior;
  }
  if (control === undefined || mutations.length === 0) {
    return;
  }
  await context.assertOwned();
  const started = timer.now();
  try {
    const change = await control.set(context.scope.deviceId, values, context.signal);
    const unrestored = RENDER_OVERLAYS.find(
      (overlay) => values[overlay] !== undefined && change.applied[overlay] !== values[overlay],
    );
    if (unrestored !== undefined) {
      throw new ActionableError(`iOS render overlay ${unrestored} did not read back as restored`);
    }
  } finally {
    context.recordPhase?.("coresimulator:ca-debug", timer.now() - started);
  }
  await context.assertOwned();
}
