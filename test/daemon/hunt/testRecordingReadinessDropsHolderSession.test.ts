import { describe, expect, test } from "bun:test";
import {
  TestRecordingSocketServer,
  type TestRecordingDeviceResolution,
} from "../../../src/daemon/testRecordingSocketServer";
import type { TestRecordingCommand } from "../../../src/daemon/testRecordingSocketTypes";
import { ActionableError, type BootedDevice } from "../../../src/models";

/**
 * HUNT: a test-recording `start` readies its device with no session identity, so readiness's
 * appearance-on-connect write uses the GLOBAL appearance config instead of the holder's own.
 *
 * `TestRecordingDeviceResolution.readyDevice(device)` takes the device only, and the production
 * implementation is `DeviceSessionManager.ensureDeviceReady(device.platform, device.deviceId)` with
 * no options. `finishReadinessSelection` then calls
 * `applyAppearanceOnConnect(device, deps, resolveAppearanceSessionKey(options?.sessionId))`: with
 * no sessionId the key is undefined and `getAppearanceConfig()` returns the global row, whose
 * default is `{ syncWithHost: true, defaultMode: "auto", applyOnConnect: true }`.
 *
 * So a holder that chose `set_appearance light` (stored under its session: syncWithHost false,
 * #10976) gets `cmd uimode night yes` on its device when it starts a test recording on a dark
 * host, and the background sync never puts it back because that session's sync is off.
 * test/server/DeviceSessionManager.appearanceSync.test.ts ("applyOnConnect reads the connecting
 * session's own config only") states the contract the tool path honours by passing `sessionId`.
 */
class TestableServer extends TestRecordingSocketServer {
  invoke(request: TestRecordingCommand) {
    return this.handleRequest(request);
  }
}

describe("HUNT: test-recording start readies the holder's device without the holder's session", () => {
  test("the session that starts a recording on its own device reaches device readiness", async () => {
    const held: BootedDevice = { deviceId: "emulator-5554", name: "Pixel", platform: "android" };
    const readinessArguments: unknown[][] = [];
    const resolution: TestRecordingDeviceResolution = {
      selectDevice: async () => held,
      readyDevice: async (...args: unknown[]) => {
        readinessArguments.push(args);
        // Stops before a real recorder is built on the readied device.
        throw new ActionableError("stop after readiness");
      },
    };
    const server = new TestableServer(
      undefined,
      undefined,
      { authorize: () => {} },
      { assertDeviceActionable: () => {} },
      resolution,
      async () => {},
    );

    await expect(
      server.invoke({
        command: "start",
        sessionUuid: "holder-session",
        deviceId: held.deviceId,
        platform: "android",
      }),
    ).rejects.toThrow("stop after readiness");

    expect(readinessArguments).toHaveLength(1);
    expect(readinessArguments[0]?.[0]).toEqual(held);
    // FAILS: readiness receives the device alone, so appearance-on-connect cannot read the
    // holder's config and falls back to the global one.
    expect(JSON.stringify(readinessArguments[0])).toContain("holder-session");
  });
});
