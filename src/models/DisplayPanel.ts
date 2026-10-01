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

export interface DisplayPanel {
  key: string;
  role: PanelRole;
  sizePx: { width: number; height: number };
  scale?: number;
}

/** Observation identity reserved for display targeting and transition fencing. */
export interface DisplayRef {
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
