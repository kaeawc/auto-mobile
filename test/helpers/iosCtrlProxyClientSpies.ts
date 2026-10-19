/**
 * Typed seams for substituting the iOS CtrlProxy client in tests.
 *
 * Production resolves the client through the static registry accessors
 * `IOSCtrlProxyClient.getInstance` / `getExistingInstance`, which are declared to return the
 * concrete class. A test never casts a stub into that class: it builds a real client with
 * `IOSCtrlProxyClient.createForTesting` (its socket factory refuses to connect) and replaces
 * the public methods it exercises, either from an {@link IosClientOverrides} bag or by
 * forwarding a `FakeIOSCtrlProxy` (#11863).
 */

import { spyOn } from "bun:test";
import type { BootedDevice } from "../../src/models";
import { IOSCtrlProxyClient } from "../../src/features/observe/ios";
import { FakeIOSCtrlProxy } from "../fakes/FakeIOSCtrlProxy";
import { FakeTimer } from "../fakes/FakeTimer";

/** Public client members that are callable (everything a test can replace). */
type ClientMethodKey = {
  [K in keyof IOSCtrlProxyClient]: IOSCtrlProxyClient[K] extends (...args: never[]) => unknown
    ? K
    : never;
}[keyof IOSCtrlProxyClient];

/** The client methods a test replaces; each keeps the real signature. */
export type IosClientOverrides = {
  [K in ClientMethodKey]?: IOSCtrlProxyClient[K];
};

/** What a test substitutes for the client: a real test client, method overrides or a recording fake. */
type IosClientStub = IOSCtrlProxyClient | IosClientOverrides | FakeIOSCtrlProxy;

const DEFAULT_IOS_DEVICE: BootedDevice = {
  name: "iPhone Test",
  platform: "ios",
  deviceId: "ios-test-client",
};

function isClientMethodKey(client: IOSCtrlProxyClient, key: string): key is ClientMethodKey {
  return key in client;
}

function override<K extends ClientMethodKey>(
  client: IOSCtrlProxyClient,
  key: K,
  impl: IOSCtrlProxyClient[K] | undefined,
): void {
  if (impl) {
    client[key] = impl;
  }
}

/** Forwards every client method the fake implements to the fake, resolved at call time so a test can still spy on the fake. */
export function iosClientOverridesFromFake(fake: FakeIOSCtrlProxy): IosClientOverrides {
  return {
    bindSession: (...args: Parameters<FakeIOSCtrlProxy["bindSession"]>) =>
      fake.bindSession(...args),
    clearCache: (...args: Parameters<FakeIOSCtrlProxy["clearCache"]>) => fake.clearCache(...args),
    close: (...args: Parameters<FakeIOSCtrlProxy["close"]>) => fake.close(...args),
    connectWithoutSetup: (...args: Parameters<FakeIOSCtrlProxy["connectWithoutSetup"]>) =>
      fake.connectWithoutSetup(...args),
    convertToViewHierarchyResult: (
      ...args: Parameters<FakeIOSCtrlProxy["convertToViewHierarchyResult"]>
    ) => fake.convertToViewHierarchyResult(...args),
    ensureConnected: (...args: Parameters<FakeIOSCtrlProxy["ensureConnected"]>) =>
      fake.ensureConnected(...args),
    getAccessibilityHierarchy: (
      ...args: Parameters<FakeIOSCtrlProxy["getAccessibilityHierarchy"]>
    ) => fake.getAccessibilityHierarchy(...args),
    getBoundSessionId: (...args: Parameters<FakeIOSCtrlProxy["getBoundSessionId"]>) =>
      fake.getBoundSessionId(...args),
    getLatestHierarchy: (...args: Parameters<FakeIOSCtrlProxy["getLatestHierarchy"]>) =>
      fake.getLatestHierarchy(...args),
    getSupportedCommands: (...args: Parameters<FakeIOSCtrlProxy["getSupportedCommands"]>) =>
      fake.getSupportedCommands(...args),
    hasCachedHierarchy: (...args: Parameters<FakeIOSCtrlProxy["hasCachedHierarchy"]>) =>
      fake.hasCachedHierarchy(...args),
    invalidateCache: (...args: Parameters<FakeIOSCtrlProxy["invalidateCache"]>) =>
      fake.invalidateCache(...args),
    isConnected: (...args: Parameters<FakeIOSCtrlProxy["isConnected"]>) =>
      fake.isConnected(...args),
    onPushUpdate: (...args: Parameters<FakeIOSCtrlProxy["onPushUpdate"]>) =>
      fake.onPushUpdate(...args),
    refreshSdkScreenIdentity: (...args: Parameters<FakeIOSCtrlProxy["refreshSdkScreenIdentity"]>) =>
      fake.refreshSdkScreenIdentity(...args),
    clearSdkScreenIdentity: (...args: Parameters<FakeIOSCtrlProxy["clearSdkScreenIdentity"]>) =>
      fake.clearSdkScreenIdentity(...args),
    requestAction: (...args: Parameters<FakeIOSCtrlProxy["requestAction"]>) =>
      fake.requestAction(...args),
    requestActivateAccessibilityLink: (
      ...args: Parameters<FakeIOSCtrlProxy["requestActivateAccessibilityLink"]>
    ) => fake.requestActivateAccessibilityLink(...args),
    requestAddHighlight: (...args: Parameters<FakeIOSCtrlProxy["requestAddHighlight"]>) =>
      fake.requestAddHighlight(...args),
    requestAppendText: (...args: Parameters<FakeIOSCtrlProxy["requestAppendText"]>) =>
      fake.requestAppendText(...args),
    requestClearText: (...args: Parameters<FakeIOSCtrlProxy["requestClearText"]>) =>
      fake.requestClearText(...args),
    requestClipboard: (...args: Parameters<FakeIOSCtrlProxy["requestClipboard"]>) =>
      fake.requestClipboard(...args),
    requestDoubleTapCoordinates: (
      ...args: Parameters<FakeIOSCtrlProxy["requestDoubleTapCoordinates"]>
    ) => fake.requestDoubleTapCoordinates(...args),
    requestDrag: (...args: Parameters<FakeIOSCtrlProxy["requestDrag"]>) =>
      fake.requestDrag(...args),
    requestHierarchySync: (...args: Parameters<FakeIOSCtrlProxy["requestHierarchySync"]>) =>
      fake.requestHierarchySync(...args),
    requestHierarchySyncForTapRevalidation: (
      ...args: Parameters<FakeIOSCtrlProxy["requestHierarchySyncForTapRevalidation"]>
    ) => fake.requestHierarchySyncForTapRevalidation(...args),
    requestHierarchySyncWithoutObservationStreamPush:
      fake.requestHierarchySyncWithoutObservationStreamPush.bind(fake),
    requestImeAction: (...args: Parameters<FakeIOSCtrlProxy["requestImeAction"]>) =>
      fake.requestImeAction(...args),
    requestKeyboard: (...args: Parameters<FakeIOSCtrlProxy["requestKeyboard"]>) =>
      fake.requestKeyboard(...args),
    requestLaunchApp: (...args: Parameters<FakeIOSCtrlProxy["requestLaunchApp"]>) =>
      fake.requestLaunchApp(...args),
    requestMagicTap: (...args: Parameters<FakeIOSCtrlProxy["requestMagicTap"]>) =>
      fake.requestMagicTap(...args),
    requestMultiFingerSwipe: (...args: Parameters<FakeIOSCtrlProxy["requestMultiFingerSwipe"]>) =>
      fake.requestMultiFingerSwipe(...args),
    requestPathGesture: (...args: Parameters<FakeIOSCtrlProxy["requestPathGesture"]>) =>
      fake.requestPathGesture(...args),
    requestPinch: (...args: Parameters<FakeIOSCtrlProxy["requestPinch"]>) =>
      fake.requestPinch(...args),
    requestPressBack: (...args: Parameters<FakeIOSCtrlProxy["requestPressBack"]>) =>
      fake.requestPressBack(...args),
    requestPressButton: (...args: Parameters<FakeIOSCtrlProxy["requestPressButton"]>) =>
      fake.requestPressButton(...args),
    requestPressHome: (...args: Parameters<FakeIOSCtrlProxy["requestPressHome"]>) =>
      fake.requestPressHome(...args),
    requestPressKey: (...args: Parameters<FakeIOSCtrlProxy["requestPressKey"]>) =>
      fake.requestPressKey(...args),
    requestRecentApps: (...args: Parameters<FakeIOSCtrlProxy["requestRecentApps"]>) =>
      fake.requestRecentApps(...args),
    requestResetPermissions: (...args: Parameters<FakeIOSCtrlProxy["requestResetPermissions"]>) =>
      fake.requestResetPermissions(...args),
    requestRotate: (...args: Parameters<FakeIOSCtrlProxy["requestRotate"]>) =>
      fake.requestRotate(...args),
    requestScreenshot: (...args: Parameters<FakeIOSCtrlProxy["requestScreenshot"]>) =>
      fake.requestScreenshot(...args),
    requestScreenshotWithoutObservationStreamPush:
      fake.requestScreenshotWithoutObservationStreamPush.bind(fake),
    requestSdkTrigger: (...args: Parameters<FakeIOSCtrlProxy["requestSdkTrigger"]>) =>
      fake.requestSdkTrigger(...args),
    requestSelectAll: (...args: Parameters<FakeIOSCtrlProxy["requestSelectAll"]>) =>
      fake.requestSelectAll(...args),
    requestSetHingeAngle: (...args: Parameters<FakeIOSCtrlProxy["requestSetHingeAngle"]>) =>
      fake.requestSetHingeAngle(...args),
    requestSetText: (...args: Parameters<FakeIOSCtrlProxy["requestSetText"]>) =>
      fake.requestSetText(...args),
    requestSetVoiceOverEnabled: (
      ...args: Parameters<FakeIOSCtrlProxy["requestSetVoiceOverEnabled"]>
    ) => fake.requestSetVoiceOverEnabled(...args),
    requestShake: (...args: Parameters<FakeIOSCtrlProxy["requestShake"]>) =>
      fake.requestShake(...args),
    requestSwipe: (...args: Parameters<FakeIOSCtrlProxy["requestSwipe"]>) =>
      fake.requestSwipe(...args),
    requestTapCoordinates: (...args: Parameters<FakeIOSCtrlProxy["requestTapCoordinates"]>) =>
      fake.requestTapCoordinates(...args),
    requestVoiceOverActivate: (...args: Parameters<FakeIOSCtrlProxy["requestVoiceOverActivate"]>) =>
      fake.requestVoiceOverActivate(...args),
    requestVoiceOverState: (...args: Parameters<FakeIOSCtrlProxy["requestVoiceOverState"]>) =>
      fake.requestVoiceOverState(...args),
    resetConnectionBudget: (...args: Parameters<FakeIOSCtrlProxy["resetConnectionBudget"]>) =>
      fake.resetConnectionBudget(...args),
    setNetworkErrorSimulation: (
      ...args: Parameters<FakeIOSCtrlProxy["setNetworkErrorSimulation"]>
    ) => fake.setNetworkErrorSimulation(...args),
    terminateStaleConnection: (...args: Parameters<FakeIOSCtrlProxy["terminateStaleConnection"]>) =>
      fake.terminateStaleConnection(...args),
    verifyServiceReady: (...args: Parameters<FakeIOSCtrlProxy["verifyServiceReady"]>) =>
      fake.verifyServiceReady(...args),
    waitForConnection: (...args: Parameters<FakeIOSCtrlProxy["waitForConnection"]>) =>
      fake.waitForConnection(...args),
  };
}

/**
 * A real {@link IOSCtrlProxyClient} built through `createForTesting` (its socket factory
 * refuses to connect), with the given methods replaced. Nothing is cast: the replacements
 * keep the class's own signatures.
 */
export function createIosTestClient(
  device: BootedDevice,
  overrides: IosClientOverrides = {},
): IOSCtrlProxyClient {
  const client = IOSCtrlProxyClient.createForTesting(
    device,
    8765,
    () => {
      throw new Error("Unexpected socket connection");
    },
    new FakeTimer(),
  );
  for (const key of Object.keys(overrides)) {
    if (!isClientMethodKey(client, key)) {
      throw new Error(`IosClientOverrides names an unknown client member: ${key}`);
    }
    override(client, key, overrides[key]);
  }
  return client;
}

/** One real client per stub, so `getInstance` and `getExistingInstance` hand back the same one. */
const clientsByStub = new WeakMap<object, IOSCtrlProxyClient>();

function clientFor(stub: IosClientStub, device: BootedDevice): IOSCtrlProxyClient {
  if (stub instanceof IOSCtrlProxyClient) {
    return stub;
  }
  const existing = clientsByStub.get(stub);
  if (existing) {
    return existing;
  }
  const client = createIosTestClient(
    device,
    stub instanceof FakeIOSCtrlProxy ? iosClientOverridesFromFake(stub) : stub,
  );
  clientsByStub.set(stub, client);
  return client;
}

/** Make `IOSCtrlProxyClient.getInstance` return `client` until the spy is restored. */
export function spyOnIosClientInstance(client: IosClientStub) {
  return spyOn(IOSCtrlProxyClient, "getInstance").mockReturnValue(
    clientFor(client, DEFAULT_IOS_DEVICE),
  );
}

/**
 * Make `IOSCtrlProxyClient.getExistingInstance` return `client` (or `null` for "no
 * client yet") until the spy is restored.
 */
export function spyOnIosExistingInstance(client: IosClientStub | null) {
  return spyOn(IOSCtrlProxyClient, "getExistingInstance").mockReturnValue(
    client === null ? null : clientFor(client, DEFAULT_IOS_DEVICE),
  );
}

/** Like {@link spyOnIosClientInstance}, but resolves the stub per device. */
export function spyOnIosClientFactory(create: (device: BootedDevice) => IosClientStub) {
  return spyOn(IOSCtrlProxyClient, "getInstance").mockImplementation((device) =>
    clientFor(create(device), device),
  );
}

/** Like {@link spyOnIosExistingInstance}, but resolves the stub per device id. */
export function spyOnIosExistingFactory(create: (deviceId: string) => IosClientStub | null) {
  return spyOn(IOSCtrlProxyClient, "getExistingInstance").mockImplementation((deviceId) => {
    const stub = create(deviceId);
    return stub === null ? null : clientFor(stub, { ...DEFAULT_IOS_DEVICE, deviceId });
  });
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
