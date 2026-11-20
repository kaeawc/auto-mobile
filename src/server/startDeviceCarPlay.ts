import { readBootedSessionIdentity } from "../daemon/deviceDescription";
import type {
  DeviceToolsDependencies,
  StartDeviceCarPlayOptions,
} from "../features/deviceLifecycle/deviceLifecycleCore";
import { getDeviceToolsDependencies } from "../features/deviceLifecycle/deviceLifecycleCore";
import { ActionableError } from "../models/ActionableError";
import { errorMessage } from "../utils/describeUnknownError";
import {
  activateCarPlayDisplay,
  type CarPlayDisplayDependencies,
} from "../utils/ios/carPlayDisplay";
import { DefaultCarPlayProjectionProbe } from "../utils/ios/carPlayProjection";
import { DefaultCarPlayScreenPowerer } from "../utils/ios/carPlayScreenPower";
import {
  createStructuredToolResponse,
  getStructuredPayload,
  type StructuredToolResponse,
} from "../utils/toolUtils";
import { whileHoldingProvisionedSession } from "./provisioning/provisioningSession";

const UNSUPPORTED_RUNTIME = "[unsupported-runtime]";

export type StartDeviceCarPlayDependencies = CarPlayDisplayDependencies &
  Pick<DeviceToolsDependencies, "holdAcquiringSession">;

function defaultCarPlayDisplayDependencies(): StartDeviceCarPlayDependencies {
  const deps = getDeviceToolsDependencies();
  return {
    powerer: new DefaultCarPlayScreenPowerer(),
    probe: new DefaultCarPlayProjectionProbe(),
    timer: deps.timer,
    holdAcquiringSession: deps.holdAcquiringSession,
  };
}

/**
 * startDevice's `carPlay` (#18820): once the iPhone simulator is ready and its session bound,
 * power on its CarPlay screen and require the probe to report the car display before adding it
 * to the response. It runs after every boot path startDevice takes (cold boot, an already-booted
 * device, a reboot, a device the session broker just reset), because CoreSimulator drops the
 * CarPlay display config on each boot. A failure names the simulator and its session: the
 * simulator stays ready and held, so the caller can retry or release it.
 */
export async function withRequestedCarPlay(
  options: StartDeviceCarPlayOptions | undefined,
  ready: StructuredToolResponse,
  bounds: { signal: AbortSignal | undefined; totalDeadlineMs: number },
  dependencies: () => StartDeviceCarPlayDependencies = defaultCarPlayDisplayDependencies,
): Promise<StructuredToolResponse> {
  if (!options) {
    return ready;
  }
  const payload = getStructuredPayload(ready);
  const { device, sessionId } = readBootedSessionIdentity(payload);
  const deps = dependencies();
  const activate = async (holdSignal?: AbortSignal) => {
    const signals = [bounds.signal, holdSignal].filter((signal) => signal !== undefined);
    return await activateCarPlayDisplay(device.deviceId, deps, {
      signal: signals.length > 0 ? AbortSignal.any(signals) : undefined,
      deadlineMs: bounds.totalDeadlineMs,
    });
  };
  try {
    // Held like startDevice's head unit: the client has no session id to heartbeat until this
    // returns, so the hold keeps the session from the first-heartbeat reap, and its signal stops
    // the helpers when the daemon cancels the session's work (a lost or killed device).
    const carPlay = sessionId
      ? await whileHoldingProvisionedSession(
          deps,
          { sessionUuid: sessionId, deadlineMs: bounds.totalDeadlineMs, toolName: "startDevice" },
          activate,
        )
      : await activate();
    return createStructuredToolResponse({ ...payload, carPlay });
  } catch (error) {
    // iOS 27+ has no Simulator CarPlay: the helper's own error is the whole answer.
    if (error instanceof ActionableError && error.message.startsWith(UNSUPPORTED_RUNTIME)) {
      throw error;
    }
    throw new ActionableError(
      `${device.deviceId} is ready and bound to session ${sessionId ?? "none"}, but its CarPlay display is not available: ${errorMessage(error)}`,
      { cause: error },
    );
  }
}
