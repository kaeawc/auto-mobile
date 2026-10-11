import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { DaemonState } from "../../src/daemon/daemonState";
import { DevicePool } from "../../src/daemon/devicePool";
import { SessionManager } from "../../src/daemon/sessionManager";
import type { BootedDevice } from "../../src/models";
import { createSetActiveDeviceHandler } from "../../src/server/setActiveDevice";
import { shapeToolCallError } from "../../src/server/shapeToolCallError";
import { logger } from "../../src/utils/logger";
import { createDevicePoolDependencies } from "../helpers/devicePoolDependencies";
import { FakeDbWriteBarrier } from "../fakes/FakeDbWriteBarrier";
import { FakeDeviceSessionPersistence } from "../fakes/FakeDeviceSessionPersistence";
import { FakeDeviceUtils } from "../fakes/FakeDeviceUtils";
import { FakeTimer } from "../fakes/FakeTimer";

/**
 * #11511 typed incomplete Android discovery as retryable `discovery_incomplete` for startDevice
 * and getAndroid. setActiveDevice meets the same situation (adb discovery failed, the requested
 * device is not pooled) and answers a plain `Error: ...` string with no code or retryable.
 */
const device: BootedDevice = { deviceId: "emulator-5554", name: "Pixel", platform: "android" };
let sessions: SessionManager;
let pool: DevicePool;
const spies: Array<{ mockRestore(): void }> = [];

beforeEach(async () => {
  const timer = new FakeTimer();
  sessions = new SessionManager(
    timer,
    new FakeDeviceSessionPersistence(),
    () => new FakeDbWriteBarrier(),
  );
  sessions.stopCleanupTimer();
  pool = new DevicePool(
    createDevicePoolDependencies(sessions, "hunt-daemon", {
      timer,
      deviceManager: new FakeDeviceUtils(),
    }),
  );
  await pool.initializeWithDevices([device]);
  await sessions.createSession("one", device.deviceId, "android");
  DaemonState.getInstance().initialize(sessions, pool);
  for (const level of ["info", "warn", "error", "debug"] as const) {
    spies.push(spyOn(logger, level).mockImplementation(() => {}));
  }
});

afterEach(() => {
  spies.splice(0).forEach((spy) => spy.mockRestore());
  sessions.stopCleanupTimer();
  DaemonState.getInstance().reset();
});

test("setActiveDevice with incomplete Android discovery is the typed retryable discovery_incomplete", async () => {
  const refresh = spyOn(pool, "refreshDevicesWithOutcome").mockResolvedValue({
    addedCount: 0,
    failure: "adb devices failed",
  });
  try {
    const handler = createSetActiveDeviceHandler({ resumeCtrlProxy: async () => {} });
    const error = await handler({ deviceId: "emulator-5556", sessionUuid: "one" }).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(Error);
    const text = shapeToolCallError(error, { toolName: "setActiveDevice", source: "MCP" })
      .content[0].text;
    expect(text.startsWith("{")).toBe(true);
    expect(JSON.parse(text)).toMatchObject({ code: "discovery_incomplete", retryable: true });
  } finally {
    refresh.mockRestore();
  }
});

test("a refresh that threw is typed by the platform the requested id belongs to (#11586)", async () => {
  const refresh = spyOn(pool, "refreshDevicesWithOutcome").mockResolvedValue({
    addedCount: 0,
    failure: "tracking persistence unavailable",
  });
  try {
    const handler = createSetActiveDeviceHandler({ resumeCtrlProxy: async () => {} });
    const select = (deviceId: string) =>
      handler({ deviceId, sessionUuid: "one" }).then(
        () => undefined,
        (e: unknown) => e,
      );

    expect(await select("0F1E2D3C-4B5A-4978-8695-A4B3C2D1E0F9")).toMatchObject({
      code: "discovery_incomplete",
      platform: "ios",
      retryable: true,
    });
    expect(await select("emulator-5556")).toMatchObject({
      code: "discovery_incomplete",
      platform: "android",
    });
  } finally {
    refresh.mockRestore();
  }
});
