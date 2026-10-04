import { AsyncLocalStorage } from "node:async_hooks";
import type { DeviceDisplays } from "../../models/DisplayPanel";
import { PinnedDisplayUnavailableError } from "../../models/PinnedDisplayError";
import { DisplaySelectionError } from "./DisplaySelection";

interface SelectedDisplayPin {
  pin: string;
  inventory: DeviceDisplays | undefined;
}

const selection = new AsyncLocalStorage<SelectedDisplayPin | undefined>();

/** Call-local provenance only; the durable pin lives exclusively in SessionManager. */
export function runWithSelectedDisplayPin<T>(pin: SelectedDisplayPin | undefined, run: () => T): T {
  return selection.run(pin, run);
}

/** Expose call-local provenance for actionable transition guidance. */
export function selectedDisplayPin(): string | undefined {
  return selection.getStore()?.pin;
}

/** Preserve explicit-selector errors while explaining restrictions caused by a session pin. */
export function unsupportedDisplayOptionMessage(option: string): string {
  const pin = selectedDisplayPin();
  return pin === undefined
    ? `${option} is not supported with \`display\` yet`
    : `${option} is not supported while the session is pinned to display "${pin}". Clear the pin with setActiveDevice {display: null} (include deviceId and sessionUuid), then retry.`;
}

/** Live routing may reject a physically inventoried panel before capture/input. */
export function displayPinFailure(error: unknown): unknown {
  const selected = selection.getStore();
  return selected && error instanceof DisplaySelectionError
    ? new PinnedDisplayUnavailableError(selected.pin, selected.inventory, {
        cause: error,
        disconnectedPanel: error.disconnectedPanel,
      })
    : error;
}
