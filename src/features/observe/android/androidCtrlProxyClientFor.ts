import type { BootedDevice } from "../../../models";
import type { AndroidCtrlProxy } from "./AndroidCtrlProxy";
import { AndroidCtrlProxyClient } from "./AndroidCtrlProxyClient";

/**
 * The default per-device CtrlProxy client for collaborators that accept an injected one (#11806).
 * One shared default instead of a `getInstance` lambda per collaborator.
 */
export function androidCtrlProxyClientFor(device: BootedDevice): AndroidCtrlProxy {
  return AndroidCtrlProxyClient.getInstance(device);
}
