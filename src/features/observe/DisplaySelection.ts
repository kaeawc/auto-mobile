import type { DeviceDisplays, DisplayPanel, Posture } from "../../models/DisplayPanel";
import { ActionableError } from "../../models/ActionableError";

/** Selection errors are returned directly to the tool caller. */
export class DisplaySelectionError extends ActionableError {}

/** Validate the opt-in observe aggregate without enabling aggregate input routing. */
export function assertAllDisplayObserveSupported(
  platform: "android" | "ios",
  options: { waitFor?: unknown; includeScreenshotImage?: boolean; raw?: boolean } = {},
): void {
  if (platform === "ios") {
    throw new DisplaySelectionError(
      'display: "all" is unsupported on iOS; use display: "active" for the live panel.',
    );
  }
  for (const option of ["waitFor", "includeScreenshotImage", "raw"] as const) {
    if (option === "waitFor" ? options[option] !== undefined : options[option] === true) {
      throw new ActionableError(
        `display: "all" cannot be combined with ${option}; omit ${option} or observe one panel separately.`,
      );
    }
  }
}

export interface DisplayLiveState {
  /** Physical key of the window that owns input focus (or the iOS key scene). */
  focusedPanelKey?: string;
  /** Physical key of the screen currently shown by a single-screen simulator. */
  activePanelKey?: string;
  posture?: Posture;
}

const roles = new Set(["inner", "cover", "rear", "external"]);

function selectExplicitPanel(panels: readonly DisplayPanel[], request: string): DisplayPanel {
  const available = panels.map((panel) => `${panel.key} (${panel.role})`).join(", ");
  if (request === "all") {
    throw new DisplaySelectionError(
      `display: "all" is not supported for single-panel targeting. Choose one panel: ${available}`,
    );
  }
  const selected =
    panels.find((panel) => panel.key === request) ??
    (roles.has(request) ? panels.find((panel) => panel.role === request) : undefined);
  if (!selected) {
    throw new DisplaySelectionError(
      `Unknown or unavailable display "${request}". Available panels: ${available}`,
    );
  }
  return selected;
}

function postureDefault(posture: Posture | undefined): DisplayPanel["role"] | undefined {
  if (posture === "closed") {
    return "cover";
  }
  if (posture === "opened" || posture === "rear_display") {
    return "inner";
  }
  return undefined;
}

/** Pure per-call panel selection. Inventory order is the stable final fallback. */
export function resolveTargetDisplay(
  inventory: DeviceDisplays | undefined,
  request: string | undefined,
  liveState: DisplayLiveState,
): DisplayPanel {
  const panels = inventory?.panels?.length
    ? inventory.panels
    : [{ key: "0", role: "unknown" as const, sizePx: { width: 0, height: 0 } }];
  if (request !== undefined && request !== "active") {
    return selectExplicitPanel(panels, request);
  }
  const focused = panels.find((panel) => panel.key === liveState.focusedPanelKey);
  if (focused) {
    return focused;
  }
  const active = panels.find((panel) => panel.key === liveState.activePanelKey);
  if (request === "active" && active) {
    return active;
  }
  const defaultRole = postureDefault(liveState.posture);
  return panels.find((panel) => panel.role === defaultRole) ?? active ?? panels[0];
}
