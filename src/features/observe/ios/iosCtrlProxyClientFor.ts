import type { BootedDevice } from "../../../models";
import { IOSCtrlProxyClient } from "./IOSCtrlProxyClient";

/**
 * The default per-device runner client for collaborators that accept an injected one (#11806).
 * One shared default instead of a `getInstance` lambda per collaborator.
 */
export function iosCtrlProxyClientFor(device: BootedDevice): IOSCtrlProxyClient {
  return IOSCtrlProxyClient.getInstance(device);
}
