/**
 * Typed seams for substituting the iOS CtrlProxy client in tests.
 *
 * Production resolves the client through the static registry accessors
 * `IOSCtrlProxyClient.getInstance` / `getExistingInstance`, which are declared to
 * return the concrete class. A test double (`FakeIOSCtrlProxy`, or a partial stub
 * of a few methods) can only satisfy the narrow `IosCtrlProxy` interface, so
 * handing it to `mockReturnValue` needs a cast. These helpers confine that cast to
 * one documented place instead of repeating a double cast to `IOSCtrlProxyClient` at
 * every call site (#11863).
 */

import { spyOn } from "bun:test";
import type { BootedDevice } from "../../src/models";
import { IOSCtrlProxyClient } from "../../src/features/observe/ios";
import { FakeTimer } from "../fakes/FakeTimer";

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

/** The client methods the daemon input suites replace; each keeps the real signature. */
export interface IosClientOverrides {
  requestDrag?: IOSCtrlProxyClient["requestDrag"];
  requestTapCoordinates?: IOSCtrlProxyClient["requestTapCoordinates"];
  requestSetText?: IOSCtrlProxyClient["requestSetText"];
  requestAppendText?: IOSCtrlProxyClient["requestAppendText"];
  requestImeAction?: IOSCtrlProxyClient["requestImeAction"];
  getScreenScaleMetadata?: IOSCtrlProxyClient["getScreenScaleMetadata"];
  requestHierarchySyncWithoutObservationStreamPush?: IOSCtrlProxyClient["requestHierarchySyncWithoutObservationStreamPush"];
  setPreference?: IOSCtrlProxyClient["setPreference"];
  removePreference?: IOSCtrlProxyClient["removePreference"];
  deleteKeychainItemForIos?: IOSCtrlProxyClient["deleteKeychainItemForIos"];
  clearPreferenceStore?: IOSCtrlProxyClient["clearPreferenceStore"];
}

/**
 * A real {@link IOSCtrlProxyClient} built through `createForTesting` (its socket factory
 * refuses to connect), with the given methods replaced. Nothing is cast: the spied methods
 * keep the class's own signatures.
 */
export function createIosTestClient(
  device: BootedDevice,
  overrides: IosClientOverrides = {},
): IOSCtrlProxyClient {
  const client = IOSCtrlProxyClient.createForTesting(device, 8765, {
    wsFactory: () => {
      throw new Error("Unexpected socket connection");
    },
    timer: new FakeTimer(),
  });
  if (overrides.requestDrag) {
    spyOn(client, "requestDrag").mockImplementation(overrides.requestDrag);
  }
  if (overrides.requestTapCoordinates) {
    spyOn(client, "requestTapCoordinates").mockImplementation(overrides.requestTapCoordinates);
  }
  if (overrides.requestSetText) {
    spyOn(client, "requestSetText").mockImplementation(overrides.requestSetText);
  }
  if (overrides.requestAppendText) {
    spyOn(client, "requestAppendText").mockImplementation(overrides.requestAppendText);
  }
  if (overrides.requestImeAction) {
    spyOn(client, "requestImeAction").mockImplementation(overrides.requestImeAction);
  }
  if (overrides.getScreenScaleMetadata) {
    spyOn(client, "getScreenScaleMetadata").mockImplementation(overrides.getScreenScaleMetadata);
  }
  if (overrides.requestHierarchySyncWithoutObservationStreamPush) {
    spyOn(client, "requestHierarchySyncWithoutObservationStreamPush").mockImplementation(
      overrides.requestHierarchySyncWithoutObservationStreamPush,
    );
  }
  if (overrides.setPreference) {
    spyOn(client, "setPreference").mockImplementation(overrides.setPreference);
  }
  if (overrides.removePreference) {
    spyOn(client, "removePreference").mockImplementation(overrides.removePreference);
  }
  if (overrides.deleteKeychainItemForIos) {
    spyOn(client, "deleteKeychainItemForIos").mockImplementation(
      overrides.deleteKeychainItemForIos,
    );
  }
  if (overrides.clearPreferenceStore) {
    spyOn(client, "clearPreferenceStore").mockImplementation(overrides.clearPreferenceStore);
  }
  return client;
}

/** Make `IOSCtrlProxyClient.getInstance` return a {@link createIosTestClient} client until the spy is restored. */
export function spyOnIosTestClientInstance(
  device: BootedDevice,
  overrides: IosClientOverrides = {},
) {
  return spyOn(IOSCtrlProxyClient, "getInstance").mockReturnValue(
    createIosTestClient(device, overrides),
  );
}
