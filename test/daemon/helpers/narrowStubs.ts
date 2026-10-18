import type { DaemonStateAccess } from "../../../src/daemon/daemonRequestHandlers";
import type { DaemonStateLike } from "../../../src/daemon/daemonState";
import type { AndroidEmulatorClient } from "../../../src/utils/android-cmdline-tools/AndroidEmulatorClient";
import type { AndroidCtrlProxyManager } from "../../../src/ctrlProxy/CtrlProxyManager";
import type { PlatformDeviceManagerFactory } from "../../../src/utils/factories/PlatformDeviceManagerFactory";

/**
 * Single narrowing points for hand-written collaborator doubles. Each production seam takes a
 * concrete class or a wide interface that a few-method stub cannot satisfy structurally; an
 * `object` -> type assertion is always legal, so call sites need no cast through `unknown`.
 */
export function asDaemonState(stub: object): DaemonStateAccess {
  return stub as DaemonStateAccess;
}

export function asDaemonStateLike(stub: object): DaemonStateLike {
  return stub as DaemonStateLike;
}

export function asCtrlProxyManager(stub: object): AndroidCtrlProxyManager {
  return stub as AndroidCtrlProxyManager;
}

export function asDeviceManager(
  stub: object,
): ReturnType<typeof PlatformDeviceManagerFactory.getInstance> {
  return stub as ReturnType<typeof PlatformDeviceManagerFactory.getInstance>;
}

export function asEmulatorClient(stub: object): AndroidEmulatorClient {
  return stub as AndroidEmulatorClient;
}
