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

/** Live routing may reject a physically inventoried panel before capture/input. */
export function displayPinFailure(error: unknown): unknown {
  const selected = selection.getStore();
  return selected && error instanceof DisplaySelectionError
    ? new PinnedDisplayUnavailableError(selected.pin, selected.inventory, { cause: error })
    : error;
}
