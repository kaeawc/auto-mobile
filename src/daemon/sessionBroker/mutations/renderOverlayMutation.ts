import {
  isRenderOverlay,
  type RenderOverlay,
} from "../../../utils/ios-cmdline-tools/SimulatorRenderOverlays";

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
