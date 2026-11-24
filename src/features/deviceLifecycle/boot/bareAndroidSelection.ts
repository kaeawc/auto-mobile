import type { DeviceMatchCriteria } from "../../../models/DeviceMatchCriteria";
import type { BootedDevice } from "../../../models";
import type { Session } from "../../../daemon/sessionManager/sessionTypes";
import { errorMessage } from "../../../utils/describeUnknownError";
import { logger } from "../../../utils/logger";

type AndroidRequirements = DeviceMatchCriteria["requires"];

/** Whether the caller set any requirement; a key whose value is `undefined` sets none (#19153). */
export function hasDefinedRequirement(requires: AndroidRequirements): boolean {
  return Object.values(requires ?? {}).some((value) => value !== undefined);
}

/**
 * Whether a bare getAndroid keeps its phone default under these requirements (#19153). A
 * requirement only another form factor meets drops it: several panels or a posture (foldable), a
 * round or square screen (Wear) and vehicle states (Automotive). Play Store and a single panel are
 * met by a phone, so they narrow the phone choice instead of widening it to a TV or a watch.
 */
export function keepsPhoneDefault(requires: AndroidRequirements): boolean {
  if (requires === undefined) {
    return true;
  }
  return (
    (requires.panels === undefined || requires.panels <= 1) &&
    requires.posture === undefined &&
    requires.screenRound === undefined &&
    requires.vehicle?.motion === undefined
  );
}

/** The daemon state a bare getAndroid reads to find the device its session already holds. */
export interface SessionDeviceSource {
  isInitialized(): boolean;
  getSessionManager(): {
    getSession(sessionId: string): Pick<Session, "assignedDevice" | "platform"> | null;
  };
}

/**
 * The running Android device the requesting session already holds, so a bare getAndroid with
 * several phones running hands the session its own device instead of another one (#19153).
 * Undefined when there is no session, it holds no Android device, or that device is no longer
 * booted: the call then selects a device as if no session held one.
 */
export async function sessionHeldAndroidDevice(
  sessionUuid: string | undefined,
  daemonState: SessionDeviceSource,
  listBootedAndroid: () => Promise<BootedDevice[]>,
): Promise<string | undefined> {
  if (sessionUuid === undefined || !daemonState.isInitialized()) {
    return undefined;
  }
  const session = daemonState.getSessionManager().getSession(sessionUuid);
  if (!session || session.platform !== "android" || session.assignedDevice.length === 0) {
    return undefined;
  }
  try {
    const booted = await listBootedAndroid();
    return booted.some((device) => device.deviceId === session.assignedDevice)
      ? session.assignedDevice
      : undefined;
  } catch (error) {
    // The preference is best-effort: selection itself rediscovers and reports what it finds.
    logger.debug(
      `[DeviceTools] Could not confirm session device ${session.assignedDevice} is booted: ${errorMessage(error)}`,
    );
    return undefined;
  }
}
