import { afterEach, describe, expect, test } from "bun:test";
import { AndroidCtrlProxyClient } from "../../../../src/features/observe/android/AndroidCtrlProxyClient";
import { FakeAdbExecutor } from "../../../fakes/FakeAdbExecutor";
import { FakeTimer } from "../../../fakes/FakeTimer";
import { AndroidCtrlProxyManager } from "../../../../src/ctrlProxy/CtrlProxyManager";
import type { BootedDevice } from "../../../../src/models";

const device: BootedDevice = {
  name: "registry-test",
  platform: "android",
  deviceId: "emulator-5598",
};

function makeClient(): AndroidCtrlProxyClient {
  return AndroidCtrlProxyClient.createForTesting(device, new FakeAdbExecutor(), {
    timer: new FakeTimer(),
  });
}

describe("AndroidCtrlProxyClient.registry", () => {
  afterEach(() => {
    AndroidCtrlProxyClient.clearInstanceRegistryForTesting();
    AndroidCtrlProxyClient.registry.clearRetired();
  });

  test("registerForTesting registers and replaces the client for a device", () => {
    const first = makeClient();
    const second = makeClient();
    AndroidCtrlProxyClient.registerForTesting(first, device.deviceId);
    expect(AndroidCtrlProxyClient.getExistingInstance(device.deviceId)).toBe(first);
    AndroidCtrlProxyClient.registerForTesting(second, device.deviceId);
    expect(AndroidCtrlProxyClient.registry.peek(device.deviceId)).toBe(second);
  });

  test("removeInstanceIfCurrent leaves a replacement in place", () => {
    const stale = makeClient();
    const current = makeClient();
    AndroidCtrlProxyClient.registerForTesting(current, device.deviceId);
    AndroidCtrlProxyClient.removeInstanceIfCurrent(device.deviceId, stale);
    expect(AndroidCtrlProxyClient.registry.peek(device.deviceId)).toBe(current);
    AndroidCtrlProxyClient.removeInstanceIfCurrent(device.deviceId, current);
    expect(AndroidCtrlProxyClient.registry.peek(device.deviceId)).toBeUndefined();
  });

  test("retire then resume drops the retired client and clears the mark", () => {
    const client = makeClient();
    AndroidCtrlProxyClient.registerForTesting(client, device.deviceId);
    AndroidCtrlProxyClient.retireForShutdown(device.deviceId);
    expect(AndroidCtrlProxyClient.registry.isRetired(device.deviceId)).toBe(true);
    expect(client.isClosed()).toBe(true);
    AndroidCtrlProxyClient.resumeAfterDeviceStart(device.deviceId);
    expect(AndroidCtrlProxyClient.registry.isRetired(device.deviceId)).toBe(false);
    expect(AndroidCtrlProxyClient.registry.peek(device.deviceId)).toBeUndefined();
  });

  test("clearInstanceRegistryForTesting keeps retired marks", () => {
    AndroidCtrlProxyClient.registerForTesting(makeClient(), device.deviceId);
    AndroidCtrlProxyClient.retireForShutdown(device.deviceId);
    AndroidCtrlProxyClient.clearInstanceRegistryForTesting();
    expect(AndroidCtrlProxyClient.registry.entries()).toEqual([]);
    expect(AndroidCtrlProxyClient.registry.isRetired(device.deviceId)).toBe(true);
  });

  test("close evicts the closed client so the next lookup is not stale", async () => {
    const client = makeClient();
    AndroidCtrlProxyClient.registerForTesting(client, device.deviceId);
    await client.close();
    expect(AndroidCtrlProxyClient.getExistingInstance(device.deviceId)).toBeNull();
  });

  test("close of a replaced client leaves the current client registered", async () => {
    const stale = makeClient();
    const current = makeClient();
    AndroidCtrlProxyClient.registerForTesting(stale, device.deviceId);
    AndroidCtrlProxyClient.registerForTesting(current, device.deviceId);
    await stale.close();
    expect(AndroidCtrlProxyClient.getExistingInstance(device.deviceId)).toBe(current);
  });

  test("close of an unregistered client does not disturb the registry", async () => {
    const current = makeClient();
    AndroidCtrlProxyClient.registerForTesting(current, device.deviceId);
    await makeClient().close();
    expect(AndroidCtrlProxyClient.getExistingInstance(device.deviceId)).toBe(current);
  });

  test("close keeps a retired mark in place", async () => {
    const client = makeClient();
    AndroidCtrlProxyClient.registerForTesting(client, device.deviceId);
    AndroidCtrlProxyClient.retireForShutdown(device.deviceId);
    await client.close();
    expect(AndroidCtrlProxyClient.registry.isRetired(device.deviceId)).toBe(true);
  });

  test("constructing a client does not register a CtrlProxy manager", () => {
    AndroidCtrlProxyManager.resetInstances();
    makeClient();
    expect(AndroidCtrlProxyManager.getExistingInstance(device.deviceId)).toBeUndefined();
  });
});
