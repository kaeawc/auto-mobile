/**
 * Typed seams for substituting the iOS CtrlProxy client in tests.
 *
 * Production resolves the client through the static registry accessors
 * `IOSCtrlProxyClient.getInstance` / `getExistingInstance`, which are declared to
 * return the concrete class. A test double (`FakeIOSCtrlProxy`, or a partial stub
 * of a few methods) can only satisfy the narrow `IOSCtrlProxy` interface, so
 * handing it to `mockReturnValue` needs a cast. These helpers confine that cast to
 * one documented place instead of repeating a double cast to `IOSCtrlProxyClient` at
 * every call site (#11863).
 */

import { spyOn } from "bun:test";
import type { BootedDevice } from "../../src/models";
import { IOSCtrlProxyClient } from "../../src/features/observe/ios";

/** Anything a test substitutes for the client: a fake or a partial method stub. */
type IosClientStub = object;

/**
 * The single narrowing point: a stub is an `object`, and the registry accessors are
 * typed to the concrete class. A direct `object` -> class assertion is legal, so no
 * double cast through unknown is needed.
 */
function asClient(stub: IosClientStub): IOSCtrlProxyClient {
  return stub as IOSCtrlProxyClient;
}

/** Make `IOSCtrlProxyClient.getInstance` return `client` until the spy is restored. */
export function spyOnIosClientInstance(client: IosClientStub) {
  return spyOn(IOSCtrlProxyClient, "getInstance").mockReturnValue(asClient(client));
}

/**
 * Make `IOSCtrlProxyClient.getExistingInstance` return `client` (or `null` for "no
 * client yet") until the spy is restored.
 */
export function spyOnIosExistingInstance(client: IosClientStub | null) {
  return spyOn(IOSCtrlProxyClient, "getExistingInstance").mockReturnValue(
    client === null ? null : asClient(client),
  );
}

/** Like {@link spyOnIosClientInstance}, but resolves the stub per device. */
export function spyOnIosClientFactory(create: (device: BootedDevice) => IosClientStub) {
  return spyOn(IOSCtrlProxyClient, "getInstance").mockImplementation((device) =>
    asClient(create(device)),
  );
}

/** Like {@link spyOnIosExistingInstance}, but resolves the stub per device id. */
export function spyOnIosExistingFactory(create: (deviceId: string) => IosClientStub | null) {
  return spyOn(IOSCtrlProxyClient, "getExistingInstance").mockImplementation((deviceId) => {
    const stub = create(deviceId);
    return stub === null ? null : asClient(stub);
  });
}
