import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { AndroidCtrlProxyClient } from "../../../../src/features/observe/android";
import { BootedDevice } from "../../../../src/models";
import { AndroidCtrlProxyManager } from "../../../../src/utils/CtrlProxyManager";
import { FakeAdbExecutor } from "../../../fakes/FakeAdbExecutor";
import { FakeAdbClientFactory } from "../../../fakes/FakeAdbClientFactory";
import { FakeTimer } from "../../../fakes/FakeTimer";
import { FakeWebSocket } from "../../../fakes/FakeWebSocket";

// Regression coverage for #5493: when killDevice closes the per-device
// AndroidCtrlProxyClient, an in-flight screenshot capture must not leak a
// signal-less ADB screencap fallback that outlives close(). The client latches
// a `closed` flag in close() so captureScreenshotViaAdb() short-circuits.
describe("AndroidCtrlProxyClient close() suppresses the ADB screencap fallback", function () {
  let fakeAdb: FakeAdbExecutor;
  let fakeTimer: FakeTimer;
  let testDevice: BootedDevice;

  beforeEach(function () {
    fakeTimer = new FakeTimer();
    fakeAdb = new FakeAdbExecutor();
    fakeAdb.setCommandResponse("forward", { stdout: "8765", stderr: "" });
    // Configure a *successful* screencap so any fallback that fires would visibly
    // succeed — the suppression under test is the only reason it must not.
    fakeAdb.setCommandResponse("screencap", { stdout: "aGVsbG8=", stderr: "" });
    fakeAdb.setScreenState(true);
    testDevice = {
      deviceId: "test-device-close-fallback",
      platform: "android",
      isEmulator: true,
      name: "Test Device",
    };
    AndroidCtrlProxyManager.resetInstances();
    AndroidCtrlProxyClient.resetInstances();
    AndroidCtrlProxyManager.getInstance(
      testDevice,
      new FakeAdbClientFactory(),
    ).clearAvailabilityCache();
  });

  afterEach(async function () {
    AndroidCtrlProxyClient.resetInstances();
  });

  function createClient(): AndroidCtrlProxyClient {
    return AndroidCtrlProxyClient.createForTesting(
      testDevice,
      fakeAdb,
      (url) => new FakeWebSocket(url, "none", 0, fakeTimer) as unknown as WebSocket,
      fakeTimer,
    );
  }

  test("issues no ADB screencap once the client is closed", async function () {
    const client = createClient();
    // Force the a11y-unsupported branch so captureScreenshotForObservationStream()
    // routes straight to the ADB fallback, isolating the guard under test.
    (client as unknown as { a11yScreenshotSupported: boolean }).a11yScreenshotSupported = false;

    await client.close();
    fakeAdb.clearHistory();

    const result = await client.captureScreenshotForObservationStream();

    expect(result.success).toBe(false);
    expect(fakeAdb.wasCommandExecuted("screencap")).toBe(false);
  });

  test("still falls back to ADB screencap when merely disconnected (not closed)", async function () {
    const client = createClient();
    (client as unknown as { a11yScreenshotSupported: boolean }).a11yScreenshotSupported = false;

    try {
      // No close(): a transient disconnect / never-connected client must still
      // serve the ADB fallback, proving the suppression is close-specific.
      const result = await client.captureScreenshotForObservationStream();

      expect(result.success).toBe(true);
      expect(fakeAdb.wasCommandExecuted("screencap")).toBe(true);
    } finally {
      await client.close();
    }
  });
});
