import type { DevicectlDisplayInfoSource } from "../../../utils/ios-cmdline-tools/DevicectlDisplayInfo";
import { devicectlConfirmsIosPanel } from "../../device/postureCommands";
import { logger } from "../../../utils/logger";
import { errorMessage } from "../../../utils/describeUnknownError";
import type { BootedDevice } from "../../../models";
import { isPhysicalPanel, type PanelRole, type Posture } from "../../../models/DisplayPanel";
import type { AdbCommandRunner } from "../../../utils/android-cmdline-tools/interfaces/AdbExecutor";
import type { Timer } from "../../../utils/SystemTimer";
import {
  ObservedAndroidDisplayCache,
  observedAndroidDisplay,
} from "../../observe/ObservationDisplay";

/**
 * Where `posture` came from. `device_state` is the device's own committed posture (Android).
 * `inferred_from_active_panel` maps the active panel to a posture (iPhone Duo: inner means
 * opened, cover means closed) without reading the hinge, so a half-folded Duo with its inner
 * panel active still reads `opened`. Consumers must not treat an inferred posture as confirmed.
 */
export type PostureSource = "device_state" | "inferred_from_active_panel";

export const POSTURE_SOURCES = [
  "device_state",
  "inferred_from_active_panel",
] as const satisfies readonly PostureSource[];

/** The live posture and active physical panel. */
export interface CurrentDisplayState {
  posture: Posture;
  postureSource: PostureSource;
  /** Omitted when the live display list names no inventory panel. */
  activePanel?: { key: string; role: PanelRole };
}

/** Whether a device's inventory can change posture at all: two or more physical panels. */
export function hasPostureInventory(device: BootedDevice): boolean {
  return (device.displays?.panels.filter(isPhysicalPanel).length ?? 0) >= 2;
}

/**
 * Read live display state without seeding observe caches. Android uses committed `device_state`
 * and logical display 0; iOS maps the active CoreDevice panel to opened/closed.
 * Single-panel inventories and indeterminate iOS reads return undefined.
 */
export async function readCurrentDisplayState(
  device: BootedDevice,
  adb: AdbCommandRunner,
  timer: Pick<Timer, "now">,
  {
    signal,
    iosDisplayInfoSource,
  }: {
    signal?: AbortSignal;
    /** Needed only for an iOS device; Android callers omit it. */
    iosDisplayInfoSource?: DevicectlDisplayInfoSource;
  },
): Promise<CurrentDisplayState | undefined> {
  if (!hasPostureInventory(device)) {
    return undefined;
  }
  if (device.platform === "ios") {
    if (!iosDisplayInfoSource) {
      return undefined;
    }
    try {
      const displays = await iosDisplayInfoSource.readDisplays({
        deviceId: device.deviceId,
        signal,
      });
      const panels = device.displays!.panels.filter(isPhysicalPanel);
      const panel = panels.find(
        (candidate) =>
          (candidate.role === "inner" || candidate.role === "cover") &&
          panels.filter((panel) => panel.role === candidate.role).length === 1 &&
          devicectlConfirmsIosPanel(displays, panels, candidate.role),
      );
      if (panel) {
        return {
          posture: panel.role === "inner" ? "opened" : "closed",
          // devicectl reports which panel is active, not the hinge angle (#17637).
          postureSource: "inferred_from_active_panel",
          activePanel: { key: panel.key, role: panel.role },
        };
      }
      logger.warn(`Cannot determine current iOS display panel for ${device.deviceId}`);
    } catch (error) {
      logger.warn(`Failed to read current iOS display state: ${errorMessage(error)}`, error);
    }
    return undefined;
  }
  if (device.platform !== "android") {
    return undefined;
  }
  // readOnly: a state read must never seed or refresh observe's posture and panel caches.
  const [posture, observed] = await Promise.all([
    new ObservedAndroidDisplayCache(timer, true).posture(device, adb, signal, true),
    observedAndroidDisplay(device, adb, signal),
  ]);
  const panel = device.displays?.panels.find((candidate) => candidate.key === observed.display.key);
  return {
    posture,
    postureSource: "device_state",
    ...(panel ? { activePanel: { key: panel.key, role: panel.role } } : {}),
  };
}
