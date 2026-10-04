/** A stable physical screen identity, independent of the current logical display. */
export type PanelRole = "inner" | "cover" | "rear" | "external" | "unknown";

/** A device state; a panel itself has no posture. */
export type Posture =
  | "closed"
  | "half_opened"
  | "opened"
  | "rear_display"
  | "flipped"
  | "tent"
  | "unknown";

/** Ordered defaults: the first posture for each role is its inferred posture. */
export const POSTURE_PANEL_ROLES = [
  ["closed", "cover"],
  ["opened", "inner"],
  ["rear_display", "inner"],
] as const satisfies readonly (readonly [Posture, PanelRole])[];

export interface DisplayPanel {
  key: string;
  role: PanelRole;
  sizePx: { width: number; height: number };
  scale?: number;
}

/** Observation identity reserved for display targeting and transition fencing. */
export interface DisplayRef {
  /** This call used the session display pin, rather than an explicit selector. */
  pinned?: true;
  key: string;
  role: PanelRole;
  posture: Posture;
  /**
   * Generation advances on notifyTransition calls for panel key, role, or posture changes, Android non-swap size changes and accepted pushed display_transition events (changed with a different panel key or non-swap size, added, removed, or device_state changes), iOS multi-panel rotation, and iOS setPosture hinge, observed identity, and settled notifications (potentially several increments per request), but not on captures, Android pure width/height swaps, or iOS same-observation geometry corrections.
   * Generation is comparable only within one session: it restarts at 0 when the device is released or the session ends, and on daemon restart.
   */
  generation: number;
}

export interface DeviceDisplays {
  panels: DisplayPanel[];
  postures: Posture[];
}

/** Shared targeting inventory, including the ordinary single-display fallback. */
export function selectablePanels(inventory: DeviceDisplays | undefined): DisplayPanel[] {
  return inventory?.panels?.length
    ? inventory.panels
    : [{ key: "0", role: "unknown", sizePx: { width: 0, height: 0 } }];
}

/** Live connection evidence carried from routing to session-pin error handling. */
export interface DisconnectedPanelContext {
  panel: Pick<DisplayPanel, "key" | "role">;
  connectedPanels: Array<Pick<DisplayPanel, "key" | "role">>;
  hasPostures: boolean;
}

/** Guidance for a known panel whose logical display is absent in this posture. */
export function buildDisconnectedPanelMessage(
  panelKey: string,
  panelRole: DisplayPanel["role"],
  connected: readonly { key: string; role?: DisplayPanel["role"] }[],
  hasPostures: boolean,
  pinned: boolean,
): string {
  const choices = connected.map(({ key, role }) => (role ? `${key} (${role})` : key)).join(", ");
  const posture = POSTURE_PANEL_ROLES.find(([, role]) => role === panelRole)?.[0];
  const postureRemedy = hasPostures
    ? `; to make this panel available, change the device posture with ${posture ? `setPosture {posture: "${posture}"}` : "setPosture using a supported posture"}`
    : "";
  const pinRemedy = pinned
    ? " Clear the pin with setActiveDevice {display: null} (include deviceId and sessionUuid), or select another display explicitly."
    : "";
  return `Display "${panelKey}" (${panelRole}) is not connected in the current posture. Connected panels: ${choices}. Target a connected panel, omit display, or use display: "active"${postureRemedy}.${pinRemedy}`;
}
