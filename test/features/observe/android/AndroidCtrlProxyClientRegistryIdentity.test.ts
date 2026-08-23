import { afterEach, describe, expect, test } from "bun:test";
import type { BootedDevice } from "../../../../src/models";
import { AndroidCtrlProxyClient } from "../../../../src/features/observe/android/AndroidCtrlProxyClient";
import { FakeAdbClientFactory } from "../../../fakes/FakeAdbClientFactory";

/**
 * Regression for issue #5452 (killDevice Windows CI failure).
 *
 * On Windows, bun evaluated `AndroidCtrlProxyClient` as two distinct module
 * records — the observe feature registered the per-device singleton in one
 * record's `static instances` map while `deviceTools`' shutdown teardown read a
 * *different* record's (empty) map, so `getExistingInstance` returned null and
 * the observer was never closed/evicted during killDevice.
 *
 * A cache-busted dynamic import forces a genuinely separate module record on
 * every platform, reproducing that split deterministically. The singleton
 * registry must be process-global so both records resolve the same instance.
 */
describe("AndroidCtrlProxyClient registry identity across module records (#5452)", () => {
  const device: BootedDevice = {
    name: "Pixel 8",
    platform: "android",
    deviceId: "emulator-5554",
  };

  afterEach(() => {
    AndroidCtrlProxyClient.resetInstances();
  });

  test("a second module record resolves the same singleton registry", async () => {
    const secondRecord =
      await import("../../../../src/features/observe/android/AndroidCtrlProxyClient?registry-identity-dup");
    const SecondRecordClient = secondRecord.AndroidCtrlProxyClient;

    // The two class objects must be distinct records for this to exercise the
    // bug; if bun ever deduped them the assertion below would pass trivially.
    expect(SecondRecordClient).not.toBe(AndroidCtrlProxyClient);

    // Register through the primary record (as the observe feature would)...
    const created = AndroidCtrlProxyClient.getInstance(device, new FakeAdbClientFactory());

    // ...and the second record (as deviceTools' teardown would) must observe the
    // same singleton rather than an empty per-record registry.
    expect(SecondRecordClient.getExistingInstance(device.deviceId)).toBe(created);

    // Eviction through either record must clear the shared registry so a
    // re-booted same-serial emulator never reuses a closed client.
    SecondRecordClient.removeInstance(device.deviceId);
    expect(AndroidCtrlProxyClient.getExistingInstance(device.deviceId)).toBeNull();
  });
});
