import { ActionableError } from "./ActionableError";
import type { DeviceDisplays, DisplayPanel } from "./DisplayPanel";

export interface PinnedDisplayDetails {
  pin: string;
  availablePanels: Array<Pick<DisplayPanel, "key" | "role">>;
}

function availableDisplayPanels(inventory: DeviceDisplays | undefined) {
  return (inventory?.panels ?? []).map(({ key, role }) => ({ key, role }));
}

function panelChoices(inventory: DeviceDisplays | undefined): string {
  return (
    availableDisplayPanels(inventory)
      .map(({ key, role }) => `${key} (${role})`)
      .join(", ") || "none"
  );
}

export class InvalidDisplayPinError extends ActionableError {
  readonly details;
  constructor(pin: unknown, inventory: DeviceDisplays | undefined) {
    super(
      `Invalid display pin ${JSON.stringify(pin)}. Choose a panel key or role (inner, cover, rear, external); active and all cannot be pinned. Available panels: ${panelChoices(inventory)}`,
    );
    this.name = "InvalidDisplayPinError";
    this.details = { pin, availablePanels: availableDisplayPanels(inventory) };
  }
}

export class DisplayPinNeedsSessionError extends ActionableError {
  constructor() {
    super(
      "A display pin requires an initialized daemon device session. Acquire a session, then call setActiveDevice with sessionUuid and display; display pins are unsupported in direct mode.",
    );
    this.name = "DisplayPinNeedsSessionError";
  }
}

export class PinnedDisplayUnavailableError extends ActionableError {
  readonly details: PinnedDisplayDetails;
  constructor(pin: string, inventory: DeviceDisplays | undefined, options?: ErrorOptions) {
    super(
      `Pinned display "${pin}" is unavailable. Available panels: ${panelChoices(inventory)}. Clear the pin with setActiveDevice {display: null} (include deviceId and sessionUuid), or select another display explicitly.`,
      options,
    );
    this.name = "PinnedDisplayUnavailableError";
    this.details = { pin, availablePanels: availableDisplayPanels(inventory) };
  }
}

export interface DisplayInventoryUnavailableDetails {
  pin?: string;
  retryable: true;
}

export class DisplayInventoryUnavailableError extends ActionableError {
  readonly details: DisplayInventoryUnavailableDetails;
  constructor(input: { pin?: string; cause?: unknown }) {
    super(
      "The display inventory could not be read. Please retry the request; the session display pin has been kept.",
      { cause: input.cause },
    );
    this.name = "DisplayInventoryUnavailableError";
    this.details = { ...(input.pin === undefined ? {} : { pin: input.pin }), retryable: true };
  }
}
