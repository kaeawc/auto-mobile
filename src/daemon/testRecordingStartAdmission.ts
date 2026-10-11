import { DaemonState } from "./daemonState";
import {
  assertInputRequesterHoldsDevice,
  InputDeviceOwnedError,
  TOOL_CALL_REMEDY,
} from "./inputDeviceOwnership";
import type { TestRecordingResponse } from "./testRecordingSocketTypes";
import { logger } from "../utils/logger";
import { noActiveDeviceSessionPayload } from "../server/proxyServer";

/** Preserve the typed holder refusal on the recording socket's response boundary. */
export function testRecordingStartOwnershipRefusal(
  deviceId: string,
  requesterSessionUuid: string | undefined,
  requireHeldSession = false,
): TestRecordingResponse | undefined {
  const state = DaemonState.getInstance();
  if (!state.isInitialized()) {
    return undefined;
  }
  const sessionManager = state.getSessionManager();
  const ownerSessionUuid = sessionManager.getSessionForDevice(deviceId) ?? undefined;
  if (!ownerSessionUuid && requireHeldSession) {
    const { error } = noActiveDeviceSessionPayload({
      message:
        `testRecording start refused: no session of yours holds device '${deviceId}'. ` +
        "Call getAndroid or getApple to acquire a session on it first.",
      reason: "device_not_held",
    });
    // Auxiliary sockets carry typed fields beside their string error, unlike MCP envelopes.
    return { success: false, ...error, error: error.message };
  }
  try {
    assertInputRequesterHoldsDevice({
      action: "testRecording start",
      deviceId,
      ownerSessionUuid,
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
  return undefined;
}
