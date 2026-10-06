import type { BootedDevice } from "../../models";
import { AndroidCtrlProxyClient } from "../observe/android/AndroidCtrlProxyClient";
import { IOSCtrlProxyClient } from "../observe/ios/IOSCtrlProxyClient";
import { NavigationGraphManager } from "./NavigationGraphManager";

/** The device identity needed to find the session its navigation events are recorded for. */
export type NavigationDeviceRef = Pick<BootedDevice, "deviceId" | "platform">;

/** The session a device's CtrlProxy client is currently bound to, or null when unbound. */
export type BoundSessionLookup = (device: NavigationDeviceRef) => string | null;

/** Picks the NavigationGraphManager a device's navigation state lives on. */
export type NavigationGraphResolver = (device?: NavigationDeviceRef) => NavigationGraphManager;

/**
 * The session the device's existing CtrlProxy client records navigation events for
 * (`bindSession`, called by every tool call that carries a `sessionUuid`). Reads only an
 * existing client, so resolving a manager never starts one as a side effect.
 */
export const clientBoundSession: BoundSessionLookup = (device) => {
  if (device.platform === "android") {
    return AndroidCtrlProxyClient.getExistingInstance(device.deviceId)?.getBoundSessionId() ?? null;
  }
  if (device.platform === "ios") {
    return IOSCtrlProxyClient.getExistingInstance(device.deviceId)?.getBoundSessionId() ?? null;
  }
  return null;
};

/**
 * Build a resolver that selects the manager exactly as the recording side does
 * (`getNavigationGraphManager` on the CtrlProxy clients): the bound session's manager, else
 * the global singleton. Readers of the current screen and edges (observe predictions,
 * prediction outcomes) must use it, or a session-bound device records on a manager they
 * never read (#10197). Resolve per call; never cache the manager across a rebind.
 */
export function createNavigationGraphResolver(
  boundSessionOf: BoundSessionLookup = clientBoundSession,
): NavigationGraphResolver {
  return (device) => {
    const sessionId = device ? boundSessionOf(device) : null;
    return sessionId
      ? NavigationGraphManager.getInstanceForSession(sessionId)
      : NavigationGraphManager.getInstance();
  };
}

export const resolveNavigationGraphForDevice: NavigationGraphResolver =
  createNavigationGraphResolver();
