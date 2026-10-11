import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { installFakeCtrlProxyManagers } from "../../helpers/hermeticDeviceTools";
import { maskRealCtrlProxyWebSocketOptIn } from "../../helpers/maskRealCtrlProxyWebSocketOptIn";
import { createDevicePoolDependencies } from "../../helpers/devicePoolDependencies";
import { isolateToolRegistry } from "../../helpers/withTemporaryTool";
import { ForcedRestartBudget } from "../../../src/ctrlProxy/ForcedRestartBudget";
import { DaemonState } from "../../../src/daemon/daemonState";
import { DevicePool } from "../../../src/daemon/devicePool";
import { SessionManager } from "../../../src/daemon/sessionManager";
import { AndroidCtrlProxyClient } from "../../../src/features/observe/android/AndroidCtrlProxyClient";
import type { BootedDevice } from "../../../src/models";
import { ToolRegistry } from "../../../src/server/toolRegistry";
import { registerUtilityTools } from "../../../src/server/utilityTools";
import { PlatformDeviceManagerFactory } from "../../../src/utils/factories/PlatformDeviceManagerFactory";
import { FakeAdbExecutor } from "../../fakes/FakeAdbExecutor";
import { FakeDbWriteBarrier } from "../../fakes/FakeDbWriteBarrier";
import { FakeDeviceSessionPersistence } from "../../fakes/FakeDeviceSessionPersistence";
import { FakeDeviceUtils } from "../../fakes/FakeDeviceUtils";
import { FakeTimer } from "../../fakes/FakeTimer";
import { createInstantFailureWebSocketFactory } from "../../fakes/FakeWebSocket";

isolateToolRegistry();

/**
 * HUNT (provisioning-6): a session-scoped setActiveDevice resumes CtrlProxy on the named device
 * BEFORE it checks who holds it (selectSessionDevice: resumeCtrlProxy, then assertDeviceOwner).
 * On Android the resume re-arms the device's forced-restart budget as "an explicit device start"
 * (#11246) and invalidates the admitted attempt's token. A session that does not hold the device is
 * refused `device_owned_by_other_session` — after it has already reset the holder's exhausted
 * budget (re-opening the restart loop the budget closed) or orphaned the holder's recovery in
 * flight. Control on a device another session holds must be refused before any side effect.
 */
describe("hunt: a refused setActiveDevice from a non-holder leaves the holder's CtrlProxy alone", () => {
  maskRealCtrlProxyWebSocketOptIn();

  const device: BootedDevice = {
    deviceId: "emulator-5554",
    name: "Pixel_8_API_34",
    platform: "android",
    isEmulator: true,
  };
  let timer: FakeTimer;
  /** The client's own clock, so stepping through restart backoff does not idle the holder out. */
  let clientTimer: FakeTimer;
  let sessions: SessionManager;
  let client: AndroidCtrlProxyClient;
  let restoreProviders: () => void;
  let previousFactory: ReturnType<typeof PlatformDeviceManagerFactory.getInstance>;

  beforeEach(async () => {
    restoreProviders = installFakeCtrlProxyManagers();
    timer = new FakeTimer();
    sessions = new SessionManager(
      timer,
      new FakeDeviceSessionPersistence(),
      () => new FakeDbWriteBarrier(),
    );
    const utils = new FakeDeviceUtils();
    utils.setBootedDevices("android", [device]);
    previousFactory = PlatformDeviceManagerFactory.getInstance();
    PlatformDeviceManagerFactory.setInstance(utils);
    const pool = new DevicePool(
      createDevicePoolDependencies(sessions, "hunt-rearm-daemon", { timer, deviceManager: utils }),
    );
    await pool.initializeWithDevices([device]);
    DaemonState.getInstance().initialize(sessions, pool);

    const adb = new FakeAdbExecutor();
    adb.setDeviceStates([{ deviceId: device.deviceId, state: "device" }]);
    clientTimer = new FakeTimer();
    client = AndroidCtrlProxyClient.createForTesting(
      device,
      adb,
      createInstantFailureWebSocketFactory(clientTimer),
      clientTimer,
    );
    AndroidCtrlProxyClient.registerForTesting(client, device.deviceId);
    registerUtilityTools();
    // The holder takes the device through the same tool, before any budget state is set up.
    await ToolRegistry.getTool("setActiveDevice")!.handler({
      deviceId: device.deviceId,
      sessionUuid: "holder",
    });
    expect(pool.getDevice(device.deviceId)?.sessionId).toBe("holder");
  });

  afterEach(async () => {
    await client.close();
    AndroidCtrlProxyClient.clearInstanceRegistryForTesting();
    sessions.stopCleanupTimer();
    DaemonState.getInstance().reset();
    PlatformDeviceManagerFactory.setInstance(previousFactory);
    restoreProviders();
  });

  const budget = (): ForcedRestartBudget =>
    (client as unknown as { forcedRestartBudget: ForcedRestartBudget }).forcedRestartBudget;

  const intruderSelects = async (): Promise<unknown> =>
    ToolRegistry.getTool("setActiveDevice")!
      .handler({ deviceId: device.deviceId, sessionUuid: "intruder" })
      .then(
        () => undefined,
        (error: unknown) => error,
      );

  test("an exhausted forced-restart budget stays exhausted", async () => {
    for (let attempt = 0; attempt < 3; attempt++) {
      budget().recordFailure("service recovery failed", budget().tryBeginAttempt()!);
      clientTimer.advanceTime(600_000);
    }
    expect(client.getRestartBudgetSnapshot()).toMatchObject({ state: "exhausted", attempts: 3 });

    const refusal = await intruderSelects();

    expect(refusal).toMatchObject({ code: "device_owned_by_other_session" });
    expect(client.getRestartBudgetSnapshot()).toMatchObject({ state: "exhausted", attempts: 3 });
  });

  test("the holder's admitted recovery attempt keeps its token", async () => {
    const token = budget().tryBeginAttempt()!;

    const refusal = await intruderSelects();

    expect(refusal).toMatchObject({ code: "device_owned_by_other_session" });
    // The holder's recovery completes: its success must still be accepted.
    expect(budget().recordSuccess(token)).toBe(true);
  });
});
