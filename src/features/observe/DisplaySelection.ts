import type {
  DeviceDisplays,
  DisplayPanel,
  Posture,
  DisconnectedPanelContext,
} from "../../models/DisplayPanel";
import type { DisplayInventoryOutcome } from "../../models/DeviceInfo";
import { POSTURE_PANEL_ROLES, selectablePanels } from "../../models/DisplayPanel";
import {
  DisplayInventoryUnavailableError,
  InvalidDisplayPinError,
  PinnedDisplayUnavailableError,
} from "../../models/PinnedDisplayError";
import { ActionableError } from "../../models/ActionableError";

/** Selection errors are returned directly to the tool caller. */
export class DisplaySelectionError extends ActionableError {
  readonly disconnectedPanel?: DisconnectedPanelContext;
  constructor(
    message: string,
    options?: ErrorOptions & { disconnectedPanel?: DisconnectedPanelContext },
  ) {
    super(message, options);
    this.disconnectedPanel = options?.disconnectedPanel;
  }
}

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
  /** Used only when the caller omitted display; explicit active bypasses it. */
  displayPin?: string;
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

/** A successful single-display read may omit panels; a failed read must not blame the pin. */
export function readableDisplayInventory(input: {
  inventory?: DeviceDisplays;
  outcome?: DisplayInventoryOutcome;
  pin?: string;
}): DeviceDisplays {
  if (
    input.outcome?.kind === "unreadable" ||
    (!input.inventory && input.outcome?.kind !== "single")
  ) {
    throw new DisplayInventoryUnavailableError({ pin: input.pin });
  }
  return input.inventory ?? { panels: [], postures: [] };
}

/** Pins use the targeting keys/roles; single-display active resolves to its sole key. */
export function validateDisplayPin(inventory: DeviceDisplays | undefined, pin: unknown): string {
  if (typeof pin !== "string" || !pin || pin === "all") {
    throw new InvalidDisplayPinError(pin, inventory);
  }
  inventory = readableDisplayInventory({ inventory, pin });
  const panels = selectablePanels(inventory);
  if (pin === "active" && panels.length === 1) {
    return panels[0].key;
  }
  if (
    pin === "active" ||
    !panels.some((panel) => panel.key === pin || (roles.has(pin) && panel.role === pin))
  ) {
    throw new InvalidDisplayPinError(pin, inventory);
  }
  return pin;
}

function pinnedPanel(inventory: DeviceDisplays | undefined, pin: string): DisplayPanel {
  const panels = selectablePanels(readableDisplayInventory({ inventory, pin }));
  const panel =
    panels.find((candidate) => candidate.key === pin) ??
    (roles.has(pin) ? panels.find((candidate) => candidate.role === pin) : undefined);
  if (!panel || pin === "active" || pin === "all") {
    throw new PinnedDisplayUnavailableError(pin, inventory);
  }
  return panel;
}

function postureDefault(posture: Posture | undefined): DisplayPanel["role"] | undefined {
  return POSTURE_PANEL_ROLES.find(([defaultPosture]) => defaultPosture === posture)?.[1];
}

/** Pure per-call panel selection. Inventory order is the stable final fallback. */
export function resolveTargetDisplay(
  inventory: DeviceDisplays | undefined,
  request: string | undefined,
  liveState: DisplayLiveState,
): DisplayPanel {
  const panels = selectablePanels(inventory);
  if (request !== undefined && request !== "active") {
    return selectExplicitPanel(panels, request);
  }
  if (request === undefined && liveState.displayPin !== undefined) {
    return pinnedPanel(inventory, liveState.displayPin);
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
