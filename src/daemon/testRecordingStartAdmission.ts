import { DaemonState } from "./daemonState";
import {
  assertInputRequesterHoldsDevice,
  InputDeviceOwnedError,
  TOOL_CALL_REMEDY,
} from "./inputDeviceOwnership";
import { ActionableError } from "../models/ActionableError";
import { logger } from "../utils/logger";
import { noActiveDeviceSessionPayload } from "../server/proxyServer";

/** Preserve the typed holder refusal on the recording socket's response boundary. */
export function testRecordingStartOwnershipRefusal(
  deviceId: string | undefined,
  requesterSessionUuid: string | undefined,
  requireHeldSession = false,
) {
  const state = DaemonState.getInstance();
  if (!state.isInitialized()) {
    return undefined;
  }
  const sessionManager = state.getSessionManager();
  const ownerSessionUuid = deviceId
    ? (sessionManager.getSessionForDevice(deviceId) ?? undefined)
    : undefined;
  if (!ownerSessionUuid && requireHeldSession) {
    const { error } = noActiveDeviceSessionPayload({
      message:
        (deviceId
          ? `testRecording start refused: no session of yours holds device '${deviceId}'. `
          : "testRecording start refused: the session holds no device. ") +
        "Call getAndroid or getApple to acquire a session on it first.",
      reason: "device_not_held",
    });
    // Auxiliary sockets carry typed fields beside their string error, unlike MCP envelopes.
    return { success: false, ...error, error: error.message };
  }
  if (!deviceId) {
    return undefined;
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

/** The socket's unheld-start refusal, thrown at the MCP response boundary. */
export class TestRecordingStartUnheldError extends ActionableError {
  readonly code = "no_active_device_session";
  readonly retryable = false;

  constructor(
    message: string,
    private readonly payload: Record<string, unknown>,
  ) {
    super(message);
    this.name = "TestRecordingStartUnheldError";
  }

  toPayload(): Record<string, unknown> {
    return this.payload;
  }

  get reason(): unknown {
    return this.payload.reason;
  }

  get nextAction(): unknown {
    return this.payload.nextAction;
  }
}

/** Apply the shared recording-start rule before MCP readiness or assignment. */
export function assertTestRecordingStartHeldDevice(
  deviceId: string | undefined,
  requesterSessionUuid: string | undefined,
  requireHeldSession = true,
): void {
  const refusal = testRecordingStartOwnershipRefusal(
    deviceId,
    requesterSessionUuid,
    requireHeldSession,
  );
  if (!refusal) {
    return;
  }
  const message = refusal.error;
  const payload: Record<string, unknown> = { ...refusal };
  delete payload.success;
  delete payload.error;
  if ("code" in refusal && refusal.code === "device_owned_by_other_session" && deviceId) {
    throw new InputDeviceOwnedError(
      "testRecording start",
      deviceId,
      requesterSessionUuid,
      TOOL_CALL_REMEDY,
      message,
    );
  }
  throw new TestRecordingStartUnheldError(message, payload);
}
