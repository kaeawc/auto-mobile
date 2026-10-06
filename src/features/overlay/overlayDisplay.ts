import type { BootedDevice } from "../../models";
import type { AdbExecutor } from "../../utils/android-cmdline-tools/interfaces/AdbExecutor";
import { defaultTimer } from "../../utils/SystemTimer";
import {
  sessionRenderedObservation,
  type RenderedObservationReader,
} from "../action/TargetDisplayAction";
import { resolveTargetDisplay } from "../observe/DisplaySelection";
import { ObservedAndroidDisplayCache } from "../observe/ObservationDisplay";

export interface OverlayDisplayDependencies {
  adb: Pick<AdbExecutor, "executeCommand">;
  lastRenderedObservation?: RenderedObservationReader;
  signal?: AbortSignal;
}

/**
 * Resolve the overlay's `display` argument to an Android logical display id, with the same
 * selection helper the tap tools use. `display` is already the product of the shared precedence
 * (an explicit argument, else the session display pin injected by the registry); undefined means
 * the default display and returns undefined so the wire stays unchanged.
 *
 * Throws DisplaySelectionError for an unknown panel, and (via the observed-display cache) the
 * disconnected-panel guidance when the panel exists but is not connected in this posture.
 */
export async function resolveOverlayDisplayId(
  device: BootedDevice,
  display: string | undefined,
  dependencies: OverlayDisplayDependencies,
): Promise<number | undefined> {
  if (display === undefined) {
    return undefined;
  }
  const previous = (dependencies.lastRenderedObservation ?? sessionRenderedObservation)(
    device.deviceId,
  );
  const panel = resolveTargetDisplay(device.displays, display, {
    focusedPanelKey: previous?.display.key,
    activePanelKey: previous?.display.key,
    posture: previous?.display.posture,
  });
  return new ObservedAndroidDisplayCache(defaultTimer).logicalIdForPanel(
    device,
    dependencies.adb,
    panel.key,
    dependencies.signal,
  );
}
