import type { DeviceDisplays, DisplayPanel } from "./DisplayPanel";
import { selectablePanels } from "./DisplayPanel";

export interface PinnedDisplayDetails {
  pin: string;
  availablePanels: Array<Pick<DisplayPanel, "key" | "role">>;
}

export function availableDisplayPanels(inventory: DeviceDisplays | undefined) {
  return selectablePanels(inventory).map(({ key, role }) => ({ key, role }));
}

export function panelChoices(inventory: DeviceDisplays | undefined): string {
  return (
    availableDisplayPanels(inventory)
      .map(({ key, role }) => `${key} (${role})`)
      .join(", ") || "none"
  );
}
