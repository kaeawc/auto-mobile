import { afterEach, beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { INTERNAL_MCP_SESSION_PARAM } from "../../src/daemon/constants";
import { DaemonState } from "../../src/daemon/daemonState";
import { DevicePool } from "../../src/daemon/devicePool";
import { DeviceSessionRegistry } from "../../src/daemon/deviceSessionRegistry";
import { DEVICE_OWNED_BY_OTHER_SESSION_CODE } from "../../src/daemon/inputDeviceOwnership";
import { SessionManager } from "../../src/daemon/sessionManager";
import type { BootedDevice, PlanStep } from "../../src/models";
import {
  getDeviceGestureRecordingStatus,
  isDeviceGestureRecordingOwnedBy,
  resetStoppedDeviceGestureRecordings,
  startDeviceGestureRecording,
  stopDeviceGestureRecording,
} from "../../src/server/deviceGestureRecordingManager";
import { PlatformDeviceManagerFactory } from "../../src/utils/factories/PlatformDeviceManagerFactory";
import { CountingIdGenerator } from "../../src/utils/IdGenerator";
import { logger } from "../../src/utils/logger";
import { FakeDbWriteBarrier } from "../fakes/FakeDbWriteBarrier";
import { FakeDeviceSessionPersistence } from "../fakes/FakeDeviceSessionPersistence";
import { FakeDeviceUtils } from "../fakes/FakeDeviceUtils";
import { FakeTimer } from "../fakes/FakeTimer";
import { McpTestFixture } from "../fixtures/mcpTestFixture";
import { createDevicePoolDependencies } from "../helpers/devicePoolDependencies";
import { installHermeticServerFixture } from "../helpers/hermeticServerFixture";
import { RealToolCallPath } from "../helpers/realToolCallPath";

const held: BootedDevice = { name: "Pixel A", deviceId: "emulator-5554", platform: "android" };
const free: BootedDevice = { name: "Pixel B", deviceId: "emulator-5556", platform: "android" };
const unheld: BootedDevice = { name: "Pixel C", deviceId: "emulator-5558", platform: "android" };
const HOLDER = "sess-holder";
const STRANGER = "sess-stranger";
const OWNER = "conn-holder";
const OTHER = "conn-stranger";
const step: PlanStep = { tool: "tapOn", params: { text: "OK" } };

/**
 * `exportPlan` stops the daemon's one live device gesture recording and returns its plan. It is a plain
 * tool (no device routing), so ToolRegistry's device-holder check never sees it, and the MCP
 * ingress only judges the session a call NAMES (#11344/#11542). Its handler therefore checks the
 * holder of the recording's device itself (#11647), as `killDevice`/`deleteDevice` do
 * (`assertLifecycleCallerHoldsDevice`, `device_owned_by_other_session`) and as the device-gesture-recording
 * socket's `stop` does: a call from another connection that names its own session, or none,
 * neither stops the holder's recording nor receives its plan.
 */
describe("exportPlan from a connection that does not hold the recording's device", () => {
  let timer: FakeTimer;
  let manager: SessionManager;
  let pool: DevicePool;
  let tools: RealToolCallPath;
  let fixture: McpTestFixture | undefined;
  let spies: Array<ReturnType<typeof spyOn>>;
  let previousAutolock: string | undefined;
  let recorderStops: number;
  let recordingId: string;

  const exportPlan = (connection: string, sessionUuid?: string) =>
    fixture!.client.callTool({
      name: "exportPlan",
      arguments: {
        ...(sessionUuid ? { sessionUuid } : {}),
        [INTERNAL_MCP_SESSION_PARAM]: connection,
      },
    });

  const bind = (sessionUuid: string, device: BootedDevice, connection: string) =>
    pool.bindOrReuseDeviceSession(
      sessionUuid,
      device.deviceId,
      "android",
      undefined,
      undefined,
      undefined,
      false,
      undefined,
      undefined,
      undefined,
      connection,
    );

  /** Starts a recording through the real manager with a fake recorder that counts its stops. */
  const record = (device: BootedDevice, idPrefix: string, ownerSessionUuid?: string) =>
    startDeviceGestureRecording(
      device,
      timer,
      new CountingIdGenerator(idPrefix),
      () => ({
        stepCount: 1,
        start: async () => undefined,
        stop: async () => {
          recorderStops += 1;
          return { steps: [step], stepCount: 1 };
        },
      }),
      ownerSessionUuid,
    );

  beforeAll(async () => {
    // Pay the server module's cold import outside any test's budget.
    const restore = installHermeticServerFixture();
    const warm = new McpTestFixture({ daemonMode: true });
    await warm.setup();
    await warm.teardown();
    restore();
  });

  beforeEach(async () => {
    previousAutolock = process.env.AUTOMOBILE_DEVICE_POOL_AUTOLOCK;
    delete process.env.AUTOMOBILE_DEVICE_POOL_AUTOLOCK;
    spies = [
      spyOn(logger, "info").mockImplementation(() => {}),
      spyOn(logger, "warn").mockImplementation(() => {}),
      spyOn(logger, "error").mockImplementation(() => {}),
    ];
    timer = new FakeTimer();
    manager = new SessionManager(timer, new FakeDeviceSessionPersistence(), {
      barrier: () => {
        return new FakeDbWriteBarrier();
      },
    });
    manager.stopCleanupTimer();
    const discovery = new FakeDeviceUtils();
    discovery.setBootedDevices("android", [held, free, unheld]);
    discovery.setBootedDevices("ios", []);
    PlatformDeviceManagerFactory.setInstance(discovery);
    pool = new DevicePool(
      createDevicePoolDependencies(manager, "export-plan-stranger-daemon", {
        timer,
        deviceManager: discovery,
      }),
    );
    await pool.initializeWithDevices([held, free, unheld]);
    DaemonState.getInstance().initialize(manager, pool, new DeviceSessionRegistry(timer));
    tools = new RealToolCallPath([held, free, unheld]).install();
    await bind(HOLDER, held, OWNER);
    manager.setDeviceReadiness(HOLDER, "automationReady");
    await bind(STRANGER, free, OTHER);
    manager.setDeviceReadiness(STRANGER, "automationReady");
    // The real server registration: exportPlan keeps its real handler.
    fixture = new McpTestFixture({ daemonMode: true });
    await fixture.setup();

    // The holder's session records on the device it holds (the real manager, a fake recorder).
    recorderStops = 0;
    const started = await record(held, "recording", HOLDER);
    recordingId = started.recordingId;
  });

  afterEach(async () => {
    if (getDeviceGestureRecordingStatus()) {
      await stopDeviceGestureRecording(undefined, undefined, timer).catch(() => undefined);
    }
    resetStoppedDeviceGestureRecordings();
    await fixture?.teardown();
    fixture = undefined;
    tools.uninstall();
    PlatformDeviceManagerFactory.setInstance(null);
    DaemonState.getInstance().reset();
    manager.stopCleanupTimer();
    for (const spy of spies) {
      spy.mockRestore();
    }
    if (previousAutolock === undefined) {
      delete process.env.AUTOMOBILE_DEVICE_POOL_AUTOLOCK;
    } else {
      process.env.AUTOMOBILE_DEVICE_POOL_AUTOLOCK = previousAutolock;
    }
  });

  test("precondition: the holder's session owns the live recording on the device it holds", () => {
    expect(manager.getSessionForDevice(held.deviceId)).toBe(HOLDER);
    expect(pool.isSessionOwnedByOtherConnection(HOLDER, OTHER)).toBe(true);
    expect(isDeviceGestureRecordingOwnedBy(HOLDER, held.deviceId)).toBe(true);
    expect(getDeviceGestureRecordingStatus()?.recordingId).toBe(recordingId);
  });

  test("naming its own session, another connection does not stop the holder's recording", async () => {
    const result = await exportPlan(OTHER, STRANGER);

    expect(recorderStops).toBe(0);
    expect(getDeviceGestureRecordingStatus()?.recordingId).toBe(recordingId);
    expect(JSON.stringify(result)).not.toContain("planContent");
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).toContain(DEVICE_OWNED_BY_OTHER_SESSION_CODE);
  });

  test("a sessionless call from another connection does not stop the holder's recording", async () => {
    const result = await exportPlan(OTHER);

    expect(recorderStops).toBe(0);
    expect(getDeviceGestureRecordingStatus()?.recordingId).toBe(recordingId);
    expect(JSON.stringify(result)).not.toContain("planContent");
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).toContain(DEVICE_OWNED_BY_OTHER_SESSION_CODE);
  });

  test("control: the holder's own connection exports its recording", async () => {
    const result = await exportPlan(OWNER, HOLDER);

    expect(result.isError).not.toBe(true);
    expect(recorderStops).toBe(1);
    expect(JSON.stringify(result)).toContain(recordingId);
    expect(getDeviceGestureRecordingStatus()).toBeNull();
  });

  test("the connection that acquired the holding session exports without naming it", async () => {
    const result = await exportPlan(OWNER);

    expect(result.isError).not.toBe(true);
    expect(recorderStops).toBe(1);
    expect(JSON.stringify(result)).toContain(recordingId);
  });

  test("a call with no session and no connection identity is refused, and is not offered force", async () => {
    const result = await fixture!.client.callTool({ name: "exportPlan", arguments: {} });

    expect(recorderStops).toBe(0);
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).toContain(DEVICE_OWNED_BY_OTHER_SESSION_CODE);
    expect(JSON.stringify(result)).not.toContain("force");
  });

  test("a recording on a device no session holds stays exportable by any caller", async () => {
    await stopDeviceGestureRecording(undefined, undefined, timer);
    recorderStops = 0;
    expect(manager.getSessionForDevice(unheld.deviceId)).toBeNull();
    const started = await record(unheld, "unheld");

    const result = await exportPlan(OTHER);

    expect(result.isError).not.toBe(true);
    expect(recorderStops).toBe(1);
    expect(JSON.stringify(result)).toContain(started.recordingId);
  });

  test("an ownerless recording on a held device is exported only by the device's holder", async () => {
    await stopDeviceGestureRecording(undefined, undefined, timer);
    recorderStops = 0;
    const started = await record(held, "ownerless");

    const refused = await exportPlan(OTHER, STRANGER);
    expect(refused.isError).toBe(true);
    expect(JSON.stringify(refused)).toContain(DEVICE_OWNED_BY_OTHER_SESSION_CODE);
    expect(recorderStops).toBe(0);

    const exported = await exportPlan(OWNER, HOLDER);
    expect(exported.isError).not.toBe(true);
    expect(JSON.stringify(exported)).toContain(started.recordingId);
  });
});
