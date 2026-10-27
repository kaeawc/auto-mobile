import { ActionableError } from "./ActionableError";
import type { DeviceDisplays } from "./DisplayPanel";
import { availableDisplayPanels, panelChoices } from "./pinnedDisplayPanels";

export class InvalidDisplayPinError extends ActionableError {
  readonly details;
  constructor(pin: unknown, inventory: DeviceDisplays | undefined) {
    super(
      `Invalid display pin ${JSON.stringify(pin)}. Choose a panel key or role (inner, cover, rear, external); active resolves to the sole key only on single-display devices, and all cannot be pinned. Available panels: ${panelChoices(inventory)}`,
    );
    this.name = "InvalidDisplayPinError";
    this.details = { pin, availablePanels: availableDisplayPanels(inventory) };
  }
}
