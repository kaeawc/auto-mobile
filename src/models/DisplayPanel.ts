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
  generation: number;
}

export interface DeviceDisplays {
  panels: DisplayPanel[];
  postures: Posture[];
}
