import { ActionableError } from "./ActionableError";
import type { DeviceDisplays, DisconnectedPanelContext } from "./DisplayPanel";
import { buildDisconnectedPanelMessage } from "./DisplayPanel";
import {
  availableDisplayPanels,
  panelChoices,
  type PinnedDisplayDetails,
} from "./pinnedDisplayPanels";

export class PinnedDisplayUnavailableError extends ActionableError {
  readonly details: PinnedDisplayDetails;
  constructor(
    pin: string,
    inventory: DeviceDisplays | undefined,
    options?: ErrorOptions & {
      disconnectedPanel?: DisconnectedPanelContext;
    },
  ) {
    const disconnected = options?.disconnectedPanel;
    super(
      disconnected
        ? buildDisconnectedPanelMessage(
            disconnected.panel.key,
            disconnected.panel.role,
            disconnected.connectedPanels,
            { hasPostures: disconnected.hasPostures, pinned: true },
          )
        : `Pinned display "${pin}" is unavailable. Known panels (connection status unknown): ${panelChoices(inventory)}. Clear the pin with setActiveDevice {display: null} (include deviceId and sessionUuid), or select another display explicitly.`,
      options,
    );
    this.name = "PinnedDisplayUnavailableError";
    this.details = {
      pin,
      availablePanels: disconnected?.connectedPanels ?? availableDisplayPanels(inventory),
    };
  }
}
