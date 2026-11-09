import type { DevicectlDisplayInfoSource } from "../../../utils/ios-cmdline-tools/DevicectlDisplayInfo";
import { findActiveIosPanel } from "../../device/postureCommands";
import {
  defaultIosRequestedHingeAngleStore,
  iosPostureForPanel,
  type IosRequestedHingeAngleStore,
} from "../../device/DuoHingeLayout";
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
 * opened, cover means closed) without reading the hinge. `requested_hinge_angle` (iPhone Duo)
 * is `half_opened` because the inner panel is active and the last hinge angle setPosture
 * requested lies strictly between 0 and 180 degrees; the hinge itself is still not read.
 * Consumers must not treat either iPhone Duo source as confirmed. Omitted when an Android
 * posture read fails and posture falls back to `unknown`: no source established it.
 */
export type PostureSource = "device_state" | "inferred_from_active_panel" | "requested_hinge_angle";

export const POSTURE_SOURCES = [
  "device_state",
  "inferred_from_active_panel",
  "requested_hinge_angle",
] as const satisfies readonly PostureSource[];

/** The live posture and active physical panel. */
export interface CurrentDisplayState {
  posture: Posture;
  /** Omitted when the posture could not be read (`unknown`). */
  postureSource?: PostureSource;
  /** Omitted when the live display list names no inventory panel. */
  activePanel?: { key: string; role: PanelRole };
  /** iPhone Duo: the last hinge angle setPosture requested (an echo, never a hinge read). */
  requestedHingeAngle?: number;
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
    iosHingeAngleStore = defaultIosRequestedHingeAngleStore,
  }: {
    signal?: AbortSignal;
    /** The last hinge angle setPosture requested; the hinge itself is never read. */
    iosHingeAngleStore?: Pick<IosRequestedHingeAngleStore, "requested">;
    /** Needed only for an iOS device; Android callers omit it. */
    iosDisplayInfoSource?: DevicectlDisplayInfoSource;
  },
): Promise<CurrentDisplayState | undefined> {
  if (!hasPostureInventory(device)) {
    return undefined;
  }
  if (device.platform === "ios") {
    return iosDisplayInfoSource
      ? readIosCurrentDisplayState(device, iosDisplayInfoSource, iosHingeAngleStore, signal)
      : undefined;
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
    // A failed device_state read falls back to unknown; do not attribute that to the device.
    ...(posture === "unknown" ? {} : { postureSource: "device_state" as const }),
    ...(panel ? { activePanel: { key: panel.key, role: panel.role } } : {}),
  };
}

/** The active iPhone Duo panel from devicectl, refined by the last requested hinge angle. */
async function readIosCurrentDisplayState(
  device: BootedDevice,
  source: DevicectlDisplayInfoSource,
  store: Pick<IosRequestedHingeAngleStore, "requested">,
  signal: AbortSignal | undefined,
): Promise<CurrentDisplayState | undefined> {
  try {
    const displays = await source.readDisplays({ deviceId: device.deviceId, signal });
    const panel = findActiveIosPanel(displays, device.displays?.panels);
    if (panel && (panel.role === "inner" || panel.role === "cover")) {
      const requested = store.requested(device.deviceId);
      const posture = iosPostureForPanel(panel.role, requested);
      return {
        posture,
        // devicectl reports which panel is active, not the hinge angle (#17637).
        postureSource:
          posture === "half_opened" ? "requested_hinge_angle" : "inferred_from_active_panel",
        activePanel: { key: panel.key, role: panel.role },
        ...(requested !== undefined ? { requestedHingeAngle: requested } : {}),
      };
    }
    logger.warn(`Cannot determine current iOS display panel for ${device.deviceId}`);
  } catch (error) {
    logger.warn(`Failed to read current iOS display state: ${errorMessage(error)}`, error);
  }
  return undefined;
}
