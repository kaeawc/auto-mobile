import { DaemonState } from "./daemonState";
import {
  assertInputRequesterHoldsDevice,
  InputDeviceOwnedError,
  TOOL_CALL_REMEDY,
} from "./inputDeviceOwnership";
import type { TestRecordingResponse } from "./testRecordingSocketTypes";
import { logger } from "../utils/logger";

/** Preserve the typed holder refusal on the recording socket's response boundary. */
export function testRecordingStartOwnershipRefusal(
  deviceId: string,
  requesterSessionUuid: string | undefined,
): TestRecordingResponse | undefined {
  const state = DaemonState.getInstance();
  if (!state.isInitialized()) {
    return undefined;
  }
  const sessionManager = state.getSessionManager();
  try {
    assertInputRequesterHoldsDevice({
      action: "testRecording start",
      deviceId,
      ownerSessionUuid: sessionManager.getSessionForDevice(deviceId) ?? undefined,
      requesterSessionUuid,
      sessionManager,
      remedy: TOOL_CALL_REMEDY,
    });
  } catch (error) {
    if (!(error instanceof InputDeviceOwnedError)) {
      throw error;
    }
    logger.warn(`[TestRecording] ${error.message}`);
    return { success: false, error: error.message, ...error.toPayload() };
  }
  // Unheld-device admission awaits an owner decision on an existing refusal code (#11665).
  return undefined;
}
