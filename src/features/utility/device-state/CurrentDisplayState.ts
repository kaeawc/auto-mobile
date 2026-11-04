import type { BootedDevice } from "../../../models";
import { isPhysicalPanel, type PanelRole, type Posture } from "../../../models/DisplayPanel";
import type { AdbCommandRunner } from "../../../utils/android-cmdline-tools/interfaces/AdbExecutor";
import type { Timer } from "../../../utils/SystemTimer";
import {
  ObservedAndroidDisplayCache,
  observedAndroidDisplay,
} from "../../observe/ObservationDisplay";

/** The live posture and the panel backing the default logical display. */
export interface CurrentDisplayState {
  posture: Posture;
  /** Omitted when the live display list names no inventory panel. */
  activePanel?: { key: string; role: PanelRole };
}

/** Whether a device's inventory can change posture at all: two or more physical panels. */
export function hasPostureInventory(device: BootedDevice): boolean {
  return (device.displays?.panels.filter(isPhysicalPanel).length ?? 0) >= 2;
}

/**
 * Read the committed `device_state` and the panel behind logical display 0, uncached, through
 * the same parsers observe uses. Single-panel devices and iOS return undefined: an iPhone Duo has
 * no captured `devicectl device info displays` evidence yet that identifies its active panel.
 */
export async function readCurrentDisplayState(
  device: BootedDevice,
  adb: AdbCommandRunner,
  timer: Pick<Timer, "now">,
  signal?: AbortSignal,
): Promise<CurrentDisplayState | undefined> {
  if (device.platform !== "android" || !hasPostureInventory(device)) {
    return undefined;
  }
  // readOnly: a state read must never seed or refresh observe's posture and panel caches.
  const [posture, observed] = await Promise.all([
    new ObservedAndroidDisplayCache(timer, true).posture(device, adb, signal, true),
    observedAndroidDisplay(device, adb, signal),
  ]);
  const panel = device.displays?.panels.find(
    (candidate) => candidate.key === observed.display.key,
  );
  return {
    posture,
    ...(panel ? { activePanel: { key: panel.key, role: panel.role } } : {}),
  };
}
