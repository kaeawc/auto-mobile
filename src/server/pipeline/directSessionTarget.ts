import { DeviceOutsideBoundSessionError } from "../../daemon/deviceOutsideBoundSessionRefusal";
import { DirectSessionNotActiveError } from "../../models/DirectSessionNotActiveError";
import { resolveDirectSessionDevice } from "../../utils/directSessionDeviceRegistry";
import { logger } from "../../utils/logger";
import type { TargetResolution } from "./targetResolutionState";

/**
 * Direct (no-proxy) mode: the session's registered device is the call's target. A deviceId the
 * call names must be that device. The session's platform replaces an unnamed ("either") one even
 * when the call repeats the deviceId, so a watch session reaches its watch without naming
 * watchOS (#14908); with no deviceId the session's device and platform are adopted outright.
 */
export function adoptDirectSessionDevice(state: TargetResolution, sessionUuid: string): void {
  const directSession = resolveDirectSessionDevice(sessionUuid);
  if (!directSession) {
    throw new DirectSessionNotActiveError(sessionUuid);
  }
  if (state.providedDeviceId && state.providedDeviceId !== directSession.device.deviceId) {
    throw new DeviceOutsideBoundSessionError(
      sessionUuid,
      directSession.device,
      { deviceId: state.providedDeviceId },
      `${state.input.name} deviceId '${state.providedDeviceId}' does not match session '${sessionUuid}' device '${directSession.device.deviceId}'. ` +
        "Omit deviceId to target the session's device.",
    );
  }
  if (!state.providedDeviceId || state.platform === "either") {
    state.platform = directSession.device.platform;
  }
  if (!state.providedDeviceId) {
    state.providedDeviceId = directSession.device.deviceId;
    logger.info(
      `[ToolRegistry] Resolved device from direct session ${sessionUuid}: ${state.providedDeviceId}`,
    );
  }
}
