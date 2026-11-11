import type { StartDeviceAndroidAutoOptions } from "../features/deviceLifecycle/deviceLifecycleCore";
import { getDeviceToolsDependencies } from "../features/deviceLifecycle/deviceLifecycleCore";
import { readBootedSessionIdentity } from "../daemon/deviceDescription";
import { ActionableError } from "../models/ActionableError";
import { errorMessage } from "../utils/describeUnknownError";
import {
  createStructuredToolResponse,
  getStructuredPayload,
  type StructuredToolResponse,
} from "../utils/toolUtils";
import { startDeviceAndroidAutoHeadUnit } from "./provisioning/provisioningAndroidAuto";
import { whileHoldingProvisionedSession } from "./provisioning/provisioningSession";

/**
 * startDevice's `androidAuto.headUnit` (#17840): once the phone is ready and its session bound,
 * start its DHU through the applier provisionDevice uses (one host port 5277 lease and
 * single-projection check per host) and add the report to the response. A failure names the
 * phone and its session: the phone stays ready and held, so the caller can retry or release it.
 */
export async function withRequestedHeadUnit(
  options: StartDeviceAndroidAutoOptions | undefined,
  ready: StructuredToolResponse,
  bounds: { signal: AbortSignal | undefined; totalDeadlineMs: number },
): Promise<StructuredToolResponse> {
  if (!options) {
    return ready;
  }
  const payload = getStructuredPayload(ready);
  const { device, sessionId } = readBootedSessionIdentity(payload);
  const session = sessionId ?? "none";
  const deps = getDeviceToolsDependencies();
  const start = async (holdSignal?: AbortSignal) => {
    const signals = [bounds.signal, holdSignal].filter((signal) => signal !== undefined);
    return await startDeviceAndroidAutoHeadUnit(options, deps, device, {
      signal: signals.length > 0 ? AbortSignal.any(signals) : undefined,
      totalDeadlineMs: bounds.totalDeadlineMs,
    });
  };
  try {
    // Held like provisionDevice's post-bind steps: the hold's signal aborts when the daemon
    // cancels the session's work (killDevice, a lost device), so a stale run never projects a
    // same-serial replacement under this session.
    const androidAuto = sessionId
      ? await whileHoldingProvisionedSession(
          deps,
          { sessionUuid: sessionId, deadlineMs: bounds.totalDeadlineMs, toolName: "startDevice" },
          start,
        )
      : await start();
    return createStructuredToolResponse({ ...payload, androidAuto });
  } catch (error) {
    throw new ActionableError(
      `${device.deviceId} is ready and bound to session ${session}, but its Android Auto head unit did not start: ${errorMessage(error)}`,
      { cause: error },
    );
  }
}
