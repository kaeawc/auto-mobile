import { afterEach, beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { DAEMON_BOUND_SESSION_PARAM } from "../../src/daemon/constants";
import { DaemonState } from "../../src/daemon/daemonState";
import { DevicePool } from "../../src/daemon/devicePool";
import { DeviceSessionRegistry } from "../../src/daemon/deviceSessionRegistry";
import { DEVICE_OWNED_BY_OTHER_SESSION_CODE } from "../../src/daemon/inputDeviceOwnership";
import { SessionManager } from "../../src/daemon/sessionManager";
import { UnixSocketServer } from "../../src/daemon/socketServer";
import type { DaemonResponse } from "../../src/daemon/types";
import type { BootedDevice } from "../../src/models";
import {
  registerDeviceTools,
  resetDeviceToolsDependencies,
  setDeviceToolsDependencies,
} from "../../src/server/deviceTools";
import { registerToolSelectionTools } from "../../src/server/toolSelectionTools";
import {
  resetVideoRecordingManagerDependencies,
  setVideoRecordingManagerDependencies,
} from "../../src/server/videoRecordingManager";
import { PlatformDeviceManagerFactory } from "../../src/utils/factories/PlatformDeviceManagerFactory";
import { logger } from "../../src/utils/logger";
import { FakeDbWriteBarrier } from "../fakes/FakeDbWriteBarrier";
import { FakeDeviceSessionPersistence } from "../fakes/FakeDeviceSessionPersistence";
import { FakeDeviceUtils } from "../fakes/FakeDeviceUtils";
import { FakeSocket } from "../fakes/FakeNetServer";
import { FakeTimer } from "../fakes/FakeTimer";
import { McpTestFixture } from "../fixtures/mcpTestFixture";
import { createDevicePoolDependencies } from "../helpers/devicePoolDependencies";
import { RealToolCallPath } from "../helpers/realToolCallPath";

/**
 * #11555 item 3: can a call that names NO `sessionUuid` get, as its implicit routing session, a
 * session another still-connected connection owns, and so run a control call as that owner?
 *
 * Driven through the real `UnixSocketServer` routing (two socket connections) into the real MCP
 * ingress: every loopback client key the socket opens gets its own `createMcpServer` with its own
 * `SessionToolBinding`, seeded exactly as the daemon's HTTP endpoint seeds it. Only the loopback
 * HTTP hop (an in-memory transport instead) and the device boundary are fake.
 *
 * Established:
 * - A connection that sends only public arguments never gets a foreign-owned implicit routing
 *   session. Its sessionless calls route to its own loopback (`socket:<id>`), a read,
 *   `setToolEnabled` or refused control call naming the owner's session never binds its socket
 *   route, and on the loopback both connections share (`device:<id>`, reached by a top-level
 *   `deviceId`) a device call resolves its session per connection from the pool, while every plain
 *   control tool rejects a top-level `deviceId` in its strict schema before its handler runs.
 * - One path IS reachable (the last describe block): a call that marks the session it names as
 *   its connection's bound session (`DAEMON_BOUND_SESSION_PARAM`, the wire shape the proxy uses
 *   for its own binding, including an `--initial-session-uuid` startup binding). The socket strips
 *   `sessionUuid` and seeds the loopback with it, so the ingress sees a sessionless call whose
 *   routing session is the owner's and its owner rule judges nothing. A public MCP caller cannot
 *   send the marker (the proxy strips it); a proxy sends it only for its own binding. Left as is:
 *   see the OPEN note on that block.
 */
class RecordingKillDeviceManager extends FakeDeviceUtils {
  readonly killed: string[] = [];

  override async killDevice(device: BootedDevice): Promise<void> {
    this.killed.push(device.deviceId);
    throw new Error("platform kill reached");
  }
}

const held: BootedDevice = { name: "Pixel A", deviceId: "emulator-5554", platform: "android" };
const other: BootedDevice = { name: "Pixel B", deviceId: "emulator-5556", platform: "android" };
const HOLDER = "holder-session";
const SHARED_LOOPBACK = `device:${held.deviceId}`;

interface Connection {
  id: string;
  call(name: string, args: Record<string, unknown>): Promise<DaemonResponse>;
}

function payload(response: DaemonResponse): Record<string, unknown> {
  const result = response.result as { content?: { text: string }[] } | undefined;
  const text = result?.content?.[0]?.text ?? "";
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    // A prose tool error is not JSON; the assertions read `text`.
    return { text };
  }
}

function isToolError(response: DaemonResponse): boolean {
  return !response.success || (response.result as { isError?: boolean })?.isError === true;
}

describe("the implicit routing session of a call that names none", () => {
  let timer: FakeTimer;
  let sessionManager: SessionManager;
  let pool: DevicePool;
  let devices: RecordingKillDeviceManager;
  let tools: RealToolCallPath;
  let server: UnixSocketServer;
  let loopbacks: McpTestFixture[];
  let spies: Array<ReturnType<typeof spyOn>>;
  let previousAutolock: string | undefined;
  let owner: Connection;
  let stranger: Connection;

  const connect = (): Connection => {
    const socket = new FakeSocket();
    server["handleConnection"](socket);
    const id = [...server["sessions"].keys()].at(-1)!;
    let sequence = 0;
    return {
      id,
      call: async (name, args) =>
        (await server["handleRequest"](id, socket, {
          id: `${id}-${sequence++}`,
          type: "mcp_request",
          method: "tools/call",
          params: { name, arguments: args },
        }))!,
    };
  };

  const loopbackKeys = (): string[] => [...server["mcpClients"].keys()];
  const heldRuns = () => tools.runs.filter((run) => run.deviceId === held.deviceId);

  /** The stranger's sessionless control calls on the owner's device: refused, nothing runs. */
  const expectStrangerRefused = async (): Promise<void> => {
    const runsBefore = heldRuns().length;
    const kill = await stranger.call("killDevice", { device: held });
    const tap = await stranger.call("tapAt", { x: 1, y: 1, deviceId: held.deviceId });
    const bareTap = await stranger.call("tapAt", { x: 1, y: 1 });

    expect(payload(kill).code).toBe(DEVICE_OWNED_BY_OTHER_SESSION_CODE);
    expect(payload(tap).code).toBe(DEVICE_OWNED_BY_OTHER_SESSION_CODE);
    expect(isToolError(bareTap)).toBe(true);
    expect(devices.killed).toEqual([]);
    expect(heldRuns()).toHaveLength(runsBefore);
    // The socket never bound the stranger's default route to the owner's session.
    expect(server["boundMcpClientKeysBySocketSession"].get(stranger.id)?.sessionUuid).not.toBe(
      HOLDER,
    );
  };

  const build = async (): Promise<void> => {
    timer = new FakeTimer();
    sessionManager = new SessionManager(timer, new FakeDeviceSessionPersistence(), () => {
      return new FakeDbWriteBarrier();
    });
    sessionManager.stopCleanupTimer();
    devices = new RecordingKillDeviceManager();
    devices.setBootedDevices("android", [held, other]);
    devices.setBootedDevices("ios", []);
    PlatformDeviceManagerFactory.setInstance(devices);
    pool = new DevicePool(
      createDevicePoolDependencies(sessionManager, "implicit-routing-daemon", {
        timer,
        deviceManager: devices,
      }),
    );
    await pool.initializeWithDevices([held, other]);
    DaemonState.getInstance().initialize(sessionManager, pool, new DeviceSessionRegistry(timer));
    tools = new RealToolCallPath([held, other]).install();
    await setVideoRecordingManagerDependencies({
      videoRecorderService: {} as never,
      recordingRepository: { listRecordings: async () => [] } as never,
      configRepository: {} as never,
      highlightClient: {} as never,
      timer,
      now: () => new Date(0),
    });
    setDeviceToolsDependencies({
      deviceManagerFactory: () => devices,
      notifyResourcesChanged: async () => {},
      ensureCtrlProxyReady: async () => {},
      clearInstalledAppsForDevice: async () => {},
      timer,
    });
    registerDeviceTools();
    registerToolSelectionTools();
    server = new UnixSocketServer(
      "/fake/implicit-routing.sock",
      "http://localhost:0/mcp",
      DaemonState.getInstance(),
      timer,
    );
    server["acceptingRequests"] = true;
    loopbacks = [];
    // One real MCP server per loopback client key, seeded as the daemon's HTTP endpoint seeds it.
    server.mcpClientFactory = async (boundSessionUuid, profileUuid, releasedSessionUuid) => {
      const loopback = new McpTestFixture({
        daemonMode: true,
        sessionContext: {
          ...(boundSessionUuid ? { initialSessionToolBinding: boundSessionUuid } : {}),
          ...(profileUuid ? { initialToolSelectionProfile: profileUuid } : {}),
          ...(releasedSessionUuid ? { initialReleasedSession: releasedSessionUuid } : {}),
        },
      });
      await loopback.setup();
      loopbacks.push(loopback);
      return loopback.client;
    };
    owner = connect();
    stranger = connect();
    // The owner's connection acquires the session that holds the device.
    await pool.bindOrReuseDeviceSession(
      HOLDER,
      held.deviceId,
      "android",
      undefined,
      undefined,
      undefined,
      false,
      undefined,
      undefined,
      undefined,
      owner.id,
    );
  };

  const destroy = async (): Promise<void> => {
    for (const loopback of loopbacks.splice(0)) {
      await loopback.teardown();
    }
    tools.uninstall();
    resetDeviceToolsDependencies();
    resetVideoRecordingManagerDependencies();
    PlatformDeviceManagerFactory.setInstance(null);
    DaemonState.getInstance().reset();
    sessionManager.stopCleanupTimer();
  };

  const silenceLogger = () => [
    spyOn(logger, "info").mockImplementation(() => {}),
    spyOn(logger, "warn").mockImplementation(() => {}),
    spyOn(logger, "error").mockImplementation(() => {}),
  ];

  beforeAll(async () => {
    // Pay the cold imports and first-call compilation outside any test's budget.
    const warmSpies = silenceLogger();
    await build();
    await owner.call("tapAt", { x: 1, y: 1, sessionUuid: HOLDER });
    await owner.call("setActiveDevice", { deviceId: held.deviceId, platform: "android" });
    await stranger.call("observe", { sessionUuid: HOLDER });
    await stranger.call("setToolEnabled", { toolName: "tapAt", enabled: true });
    await stranger.call("killDevice", { device: held });
    await destroy();
    for (const spy of warmSpies) {
      spy.mockRestore();
    }
  });

  beforeEach(async () => {
    previousAutolock = process.env.AUTOMOBILE_DEVICE_POOL_AUTOLOCK;
    delete process.env.AUTOMOBILE_DEVICE_POOL_AUTOLOCK;
    spies = silenceLogger();
    await build();
  });

  afterEach(async () => {
    await destroy();
    for (const spy of spies) {
      spy.mockRestore();
    }
    if (previousAutolock === undefined) {
      delete process.env.AUTOMOBILE_DEVICE_POOL_AUTOLOCK;
    } else {
      process.env.AUTOMOBILE_DEVICE_POOL_AUTOLOCK = previousAutolock;
    }
  });

  test("another connection's first sessionless control calls are refused on its own loopback", async () => {
    expect(pool.isSessionOwnedByOtherConnection(HOLDER, stranger.id)).toBe(true);

    await expectStrangerRefused();

    // The plain and the bare call ran on the stranger's own loopback, never one seeded for HOLDER.
    expect(loopbackKeys()).toContain(`socket:${stranger.id}`);
    expect(loopbackKeys().some((key) => key.includes(`session:${HOLDER}`))).toBe(false);
  });

  test("a read naming the owner's session does not bind the reader's later sessionless calls", async () => {
    const before = sessionManager.getSession(HOLDER)!.lastUsedAt;
    timer.advanceTime(60_000);

    const read = await stranger.call("observe", { sessionUuid: HOLDER });

    expect(isToolError(read)).toBe(false);
    await expectStrangerRefused();
    expect(sessionManager.getSession(HOLDER)!.lastUsedAt).toBe(before);
  });

  test("setToolEnabled naming the owner's session does not bind the caller's later sessionless calls", async () => {
    const edit = await stranger.call("setToolEnabled", {
      toolName: "tapAt",
      enabled: true,
      sessionUuid: HOLDER,
    });

    expect(isToolError(edit)).toBe(false);
    await expectStrangerRefused();
  });

  test("a refused control call naming the owner's session does not bind later sessionless calls", async () => {
    const named = await stranger.call("tapAt", { x: 1, y: 1, sessionUuid: HOLDER });
    const namedKill = await stranger.call("killDevice", { device: held, sessionUuid: HOLDER });

    expect(payload(named).code).toBe(DEVICE_OWNED_BY_OTHER_SESSION_CODE);
    expect(payload(namedKill).code).toBe(DEVICE_OWNED_BY_OTHER_SESSION_CODE);
    await expectStrangerRefused();
  });

  test("on the loopback both connections share, the owner's binding does not carry to the other", async () => {
    // The owner's sessionless calls with a top-level deviceId run on the shared loopback, and its
    // setActiveDevice binds that loopback's SessionToolBinding to the owner's session.
    const selected = await owner.call("setActiveDevice", {
      deviceId: held.deviceId,
      platform: "android",
    });
    const ownerTap = await owner.call("tapAt", { x: 1, y: 1, deviceId: held.deviceId });
    expect(payload(selected).sessionUuid).toBe(HOLDER);
    expect(isToolError(ownerTap)).toBe(false);
    expect(loopbackKeys()).toEqual([SHARED_LOOPBACK]);

    const tap = await stranger.call("tapAt", { x: 1, y: 1, deviceId: held.deviceId });
    const labelled = await stranger.call("tapAt", {
      x: 1,
      y: 1,
      deviceId: held.deviceId,
      device: "A",
    });
    // Both of the stranger's calls reached the same loopback the owner bound.
    expect(loopbackKeys()).toEqual([SHARED_LOOPBACK]);
    // A plain control tool cannot be steered there: its strict schema rejects a top-level deviceId.
    const steeredKill = await stranger.call("killDevice", {
      device: held,
      deviceId: held.deviceId,
    });

    expect(payload(tap).code).toBe(DEVICE_OWNED_BY_OTHER_SESSION_CODE);
    expect(isToolError(labelled)).toBe(true);
    expect(isToolError(steeredKill)).toBe(true);
    expect(devices.killed).toEqual([]);
    expect(heldRuns()).toHaveLength(1);
    await expectStrangerRefused();
  });

  test("the owner's own sessionless control calls on its device still run", async () => {
    const tap = await owner.call("tapAt", { x: 1, y: 1, deviceId: held.deviceId });
    // The proxy's shape for a call on its own binding; it binds the owner's socket route.
    const boundTap = await owner.call("tapAt", {
      x: 1,
      y: 1,
      sessionUuid: HOLDER,
      [DAEMON_BOUND_SESSION_PARAM]: HOLDER,
    });
    await owner.call("killDevice", { device: held });

    expect(isToolError(tap)).toBe(false);
    expect(isToolError(boundTap)).toBe(false);
    expect(heldRuns().map((run) => run.sessionUuid)).toEqual([HOLDER, HOLDER]);
    expect(server["boundMcpClientKeysBySocketSession"].get(owner.id)?.sessionUuid).toBe(HOLDER);
    expect(devices.killed).toEqual([held.deviceId]);
  });

  test("with autolock on, a sessionless call never resolves to another connection's autolock", async () => {
    process.env.AUTOMOBILE_DEVICE_POOL_AUTOLOCK = "1";
    const autolock = (await pool.autolockDevice(other.deviceId, "android", owner.id))!;
    expect(pool.resolveAutolockSessionForMcpSession(owner.id)).toBe(autolock);

    const bareTap = await stranger.call("tapAt", { x: 1, y: 1 });
    const tap = await stranger.call("tapAt", { x: 1, y: 1, deviceId: other.deviceId });
    const kill = await stranger.call("killDevice", { device: other });

    expect(pool.resolveAutolockSessionForMcpSession(stranger.id)).toBeUndefined();
    expect(isToolError(bareTap)).toBe(true);
    expect(payload(tap).code).toBe(DEVICE_OWNED_BY_OTHER_SESSION_CODE);
    expect(payload(kill).code).toBe(DEVICE_OWNED_BY_OTHER_SESSION_CODE);
    expect(tools.runs).toEqual([]);
    expect(devices.killed).toEqual([]);

    // The owner's sessionless calls resolve to its own autolock and run.
    const ownerTap = await owner.call("tapAt", { x: 1, y: 1 });
    await owner.call("killDevice", { device: other });

    expect(isToolError(ownerTap)).toBe(false);
    expect(tools.runs.map((run) => run.deviceId)).toEqual([other.deviceId]);
    expect(devices.killed).toEqual([other.deviceId]);
  });

  // The one reachable path (#11555 item 3). A call that marks the session it names as its
  // connection's bound session has `sessionUuid` stripped by the socket
  // (`withSocketSessionAutolockKey`) and lands on a loopback seeded with it
  // (`sessionScopedForwardRoute`), so the ingress sees no named session. Unjudged, the tap reaches
  // the owner's device and killDevice passes the holder check without `force`.
  describe("a call marking the owner's session as its own bound session", () => {
    const marked = { sessionUuid: HOLDER, [DAEMON_BOUND_SESSION_PARAM]: HOLDER };

    // OPEN (#11555 item 3): this pins what happens today, not what should. Refusing here by
    // connection ownership would also refuse a proxy that took the session over by a liveness
    // claim while the acquiring connection stays connected (a liveness claim records no
    // connection ownership), so which ownership governs a declared binding is the owner's call.
    test("REACHABLE: its control calls run as the owner's session", async () => {
      const tap = await stranger.call("tapAt", { x: 1, y: 1, ...marked });
      await stranger.call("killDevice", { device: held, ...marked });

      expect(isToolError(tap)).toBe(false);
      expect(heldRuns().map((run) => run.sessionUuid)).toEqual([HOLDER]);
      // Unforced: the lifecycle holder check took the declared binding for the holder.
      expect(devices.killed).toEqual([held.deviceId]);
      // The pool still records the acquiring connection as the session's owner.
      expect(pool.isSessionOwnedByOtherConnection(HOLDER, stranger.id)).toBe(true);
    });

    test("is still answered when it is a read, and does not extend the session", async () => {
      const before = sessionManager.getSession(HOLDER)!.lastUsedAt;
      timer.advanceTime(60_000);

      const read = await stranger.call("observe", marked);

      expect(isToolError(read)).toBe(false);
      expect(sessionManager.getSession(HOLDER)!.lastUsedAt).toBe(before);
    });

    test("still runs on a bound session no connected client owns", async () => {
      const OWNERLESS = "ownerless-session";
      await pool.bindOrReuseDeviceSession(OWNERLESS, other.deviceId, "android");
      expect(pool.isSessionOwnedByOtherConnection(OWNERLESS, stranger.id)).toBe(false);

      const tap = await stranger.call("tapAt", {
        x: 1,
        y: 1,
        sessionUuid: OWNERLESS,
        [DAEMON_BOUND_SESSION_PARAM]: OWNERLESS,
      });

      expect(isToolError(tap)).toBe(false);
      expect(tools.runs.map((run) => run.sessionUuid)).toEqual([OWNERLESS]);
    });
  });
});
