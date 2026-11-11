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
  try {
    const androidAuto = await startDeviceAndroidAutoHeadUnit(
      options,
      getDeviceToolsDependencies(),
      device,
      bounds,
    );
    return createStructuredToolResponse({ ...payload, androidAuto });
  } catch (error) {
    throw new ActionableError(
      `${device.deviceId} is ready and bound to session ${session}, but its Android Auto head unit did not start: ${errorMessage(error)}`,
      { cause: error },
    );
  }
}
