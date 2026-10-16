import { afterEach, beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { INTERNAL_MCP_SESSION_PARAM } from "../../src/daemon/constants";
import { DaemonState } from "../../src/daemon/daemonState";
import { DevicePool } from "../../src/daemon/devicePool";
import { DeviceSessionRegistry } from "../../src/daemon/deviceSessionRegistry";
import { DEVICE_OWNED_BY_OTHER_SESSION_CODE } from "../../src/daemon/inputDeviceOwnership";
import { SessionManager } from "../../src/daemon/sessionManager";
import type { BootedDevice } from "../../src/models";
import { buildDeviceLabelMap } from "../../src/server/deviceLabelMapping";
import { PlatformDeviceManagerFactory } from "../../src/utils/factories/PlatformDeviceManagerFactory";
import { logger } from "../../src/utils/logger";
import { FakeDbWriteBarrier } from "../fakes/FakeDbWriteBarrier";
import { FakeDeviceSessionPersistence } from "../fakes/FakeDeviceSessionPersistence";
import { FakeDeviceUtils } from "../fakes/FakeDeviceUtils";
import { FakeTimer } from "../fakes/FakeTimer";
import { McpTestFixture } from "../fixtures/mcpTestFixture";
import { createDevicePoolDependencies } from "../helpers/devicePoolDependencies";
import { installHermeticServerFixture } from "../helpers/hermeticServerFixture";
import { asPlanAllocation } from "../helpers/planLabelAllocation";
import { RealToolCallPath } from "../helpers/realToolCallPath";

const primary: BootedDevice = { name: "Pixel A", deviceId: "emulator-5554", platform: "android" };
const labelled: BootedDevice = { name: "Pixel B", deviceId: "emulator-5556", platform: "android" };
const BASE = "sess-a";
const OWNER = "conn-1";
const OTHER = "conn-2";

function wire(result: { content?: unknown }): Record<string, unknown> {
  const content = result.content as { text: string }[];
  return JSON.parse(content[0].text) as Record<string, unknown>;
}

describe("a derived label session of a base another connection owns", () => {
  let manager: SessionManager;
  let pool: DevicePool;
  let tools: RealToolCallPath;
  let fixture: McpTestFixture | undefined;
  let spies: Array<ReturnType<typeof spyOn>>;
  let previousAutolock: string | undefined;
  let labelSession: string;

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
    const timer = new FakeTimer();
    manager = new SessionManager(timer, new FakeDeviceSessionPersistence(), {
      barrier: () => {
        return new FakeDbWriteBarrier();
      },
    });
    manager.stopCleanupTimer();
    const discovery = new FakeDeviceUtils();
    discovery.setBootedDevices("android", [primary, labelled]);
    discovery.setBootedDevices("ios", []);
    PlatformDeviceManagerFactory.setInstance(discovery);
    pool = new DevicePool(
      createDevicePoolDependencies(manager, "label-session-daemon", {
        timer,
        deviceManager: discovery,
      }),
    );
    await pool.initializeWithDevices([primary, labelled]);
    DaemonState.getInstance().initialize(manager, pool, new DeviceSessionRegistry(timer));
    tools = new RealToolCallPath([primary, labelled]).install();
    // OWNER acquires the base session, then its executePlan allocates the plan's second label
    // exactly as PlanExecutionOrchestrator.allocateDevices does: publish the label map on the
    // base, then hand the derived session to the pool allocator.
    await pool.bindOrReuseDeviceSession(
      BASE,
      primary.deviceId,
      "android",
      undefined,
      undefined,
      undefined,
      false,
      undefined,
      undefined,
      undefined,
      OWNER,
    );
    const labels = buildDeviceLabelMap(["A", "B"], BASE);
    labelSession = labels.B;
    manager.setDeviceLabels(BASE, labels);
    await asPlanAllocation(manager, BASE, [labelSession], () =>
      pool.assignMultipleDevices([labelSession], 1_000, "android"),
    );
    fixture = new McpTestFixture({ daemonMode: true });
    await fixture.setup();
  });

  afterEach(async () => {
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

  test("the setup is the plan's: the derived session holds the second device", () => {
    expect(labelSession).toBe(`${BASE}:B`);
    expect(pool.getDevice(labelled.deviceId)?.sessionId).toBe(labelSession);
    expect(pool.isSessionOwnedByOtherConnection(BASE, OTHER)).toBe(true);
  });

  test("control naming the base from another connection is refused (the #11344 rule)", async () => {
    const result = await fixture!.client.callTool({
      name: "tapAt",
      arguments: { x: 10, y: 10, sessionUuid: BASE, [INTERNAL_MCP_SESSION_PARAM]: OTHER },
    });

    expect(result.isError).toBe(true);
    expect(wire(result).code).toBe(DEVICE_OWNED_BY_OTHER_SESSION_CODE);
    expect(tools.runs).toEqual([]);
  });

  test("control naming the derived label session from another connection is refused too", async () => {
    const result = await fixture!.client.callTool({
      name: "tapAt",
      arguments: { x: 10, y: 10, sessionUuid: labelSession, [INTERNAL_MCP_SESSION_PARAM]: OTHER },
    });

    // No input reaches the owner's labelled device.
    expect(tools.runs).toEqual([]);
    expect(result.isError).toBe(true);
    expect(wire(result).code).toBe(DEVICE_OWNED_BY_OTHER_SESSION_CODE);
  });

  test("the derived session's name does not reach the owner's base device through a label", async () => {
    const result = await fixture!.client.callTool({
      name: "tapAt",
      arguments: {
        x: 10,
        y: 10,
        sessionUuid: labelSession,
        device: "A",
        [INTERNAL_MCP_SESSION_PARAM]: OTHER,
      },
    });

    expect(tools.runs).toEqual([]);
    expect(result.isError).toBe(true);
    expect(wire(result).code).toBe(DEVICE_OWNED_BY_OTHER_SESSION_CODE);
  });

  test("the pool predicate counts a derived session as its base", () => {
    expect(pool.isSessionOwnedByOtherConnection(labelSession, OTHER)).toBe(true);
    expect(pool.isSessionOwnedByOtherConnection(labelSession, OWNER)).toBe(false);
  });

  test("a derived session whose base has no connected owner is foreign to no one", () => {
    pool.releaseMcpSessionBindings(OWNER);

    expect(pool.isSessionOwnedByOtherConnection(labelSession, OTHER)).toBe(false);
  });

  test("a caller with no connection identity is not told apart from the owner", () => {
    expect(pool.isSessionOwnedByOtherConnection(labelSession)).toBe(false);
  });

  test("a read naming the derived session from another connection is not refused", async () => {
    const before = manager.getSession(labelSession)!.lastUsedAt;

    const result = await fixture!.client.callTool({
      name: "observe",
      arguments: { sessionUuid: labelSession, [INTERNAL_MCP_SESSION_PARAM]: OTHER },
    });

    expect(result.isError).not.toBe(true);
    expect(tools.runs.map((run) => run.deviceId)).toEqual([labelled.deviceId]);
    expect(manager.getSession(labelSession)!.lastUsedAt).toBe(before);
  });

  test("the owner's own calls on its labelled devices run", async () => {
    for (const device of ["B", "A"]) {
      const result = await fixture!.client.callTool({
        name: "tapAt",
        arguments: { x: 10, y: 10, sessionUuid: BASE, device, [INTERNAL_MCP_SESSION_PARAM]: OWNER },
      });
      expect(result.isError).not.toBe(true);
    }

    expect(tools.runs.map((run) => run.deviceId)).toEqual([labelled.deviceId, primary.deviceId]);
  });

  test("the owner naming its derived session runs on the labelled device", async () => {
    const result = await fixture!.client.callTool({
      name: "tapAt",
      arguments: { x: 10, y: 10, sessionUuid: labelSession, [INTERNAL_MCP_SESSION_PARAM]: OWNER },
    });

    expect(result.isError).not.toBe(true);
    expect(tools.runs.map((run) => run.deviceId)).toEqual([labelled.deviceId]);
  });
});
