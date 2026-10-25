import { createTestUnixSocketServer } from "../helpers/createTestUnixSocketServer";
import { afterEach, beforeAll, describe, expect, spyOn, test } from "bun:test";
import {
  DAEMON_BOUND_SESSION_PARAM,
  DAEMON_OWNED_SESSIONS_OWNER_TOKEN_PARAM,
  DAEMON_OWNED_SESSIONS_PARAM,
} from "../../src/daemon/wire/constants";
import { DaemonState } from "../../src/daemon/daemonState";
import { DevicePool } from "../../src/daemon/devicePool";
import { DeviceSessionRegistry } from "../../src/daemon/deviceSessionRegistry";
import { DEVICE_OWNED_BY_OTHER_SESSION_CODE } from "../../src/daemon/inputDeviceOwnership";
import { SessionManager } from "../../src/daemon/sessionManager";
import { type UnixSocketServer } from "../../src/daemon/socketServer";
import { currentForwardSessionKey } from "../../src/daemon/socketServer/forwardSessionKey";
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
} from "../../src/daemon/videoRecordingManager";
import { PlatformDeviceManagerFactory } from "../../src/utils/factories/PlatformDeviceManagerFactory";
import { logger } from "../../src/utils/logger";
import { FakeDbWriteBarrier } from "../fakes/FakeDbWriteBarrier";
import { FakeDeviceSessionPersistence } from "../fakes/FakeDeviceSessionPersistence";
import { FakeDeviceUtils } from "../fakes/FakeDeviceUtils";
import { FakeSocket } from "../fakes/FakeNetServer";
import { FakeTimer } from "../fakes/FakeTimer";
import { McpTestFixture } from "../fixtures/mcpTestFixture";
import { createDevicePoolDependencies } from "../helpers/devicePoolDependencies";
import { asPlanAllocation } from "../helpers/planLabelAllocation";
import { RealToolCallPath } from "../helpers/realToolCallPath";
import { isolateToolRegistry } from "../helpers/withTemporaryTool";

isolateToolRegistry();

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
 *   session. Its sessionless calls run as its own forwards, a read, `setToolEnabled` or refused
 *   control call naming the owner's session never binds its socket route, and on the route both
 *   connections share (`device:<id>`, reached by a top-level `deviceId`) a device call resolves
 *   its session per connection from the pool, while every plain
 *   control tool rejects a top-level `deviceId` in its strict schema before its handler runs.
 * - A marker echoing the named session (`DAEMON_BOUND_SESSION_PARAM`, including the proxy's
 *   `--initial-session-uuid` shape) is honoured unless another connected client owns that session
 *   and its recorded liveness token differs from the call's token. Then `sessionUuid` stays for
 *   the ingress owner rule: control is refused without use or socket rebinding, reads still run.
 *   Matching tokens, the owning connection, disconnected owners and tokenless sessions retain
 *   the bound-session path.
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
const OWNER_TOKEN = "holder-owner-token";

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
    server.testHooks.transport.handleConnection(socket);
    const id = [...server.testHooks.sessions.keys()].at(-1)!;
    let sequence = 0;
    return {
      id,
      call: async (name, args) =>
        (await server.testHooks.transport.handleRequest(id, socket, {
          id: `${id}-${sequence++}`,
          type: "mcp_request",
          method: "tools/call",
          params: { name, arguments: args },
        }))!,
    };
  };

  /** The session each forward's client was seeded with, keyed by the connection that sent it. */
  let forwards: Array<{ connection: string | undefined; boundSessionUuid: string | undefined }>;
  const forwardsOf = (connection: Connection) =>
    forwards.filter((forward) => forward.connection === connection.id);
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
    expect(server.testHooks.boundMcpClientFor(stranger.id)?.sessionUuid).not.toBe(HOLDER);
  };

  const build = async (): Promise<void> => {
    timer = new FakeTimer();
    sessionManager = new SessionManager(timer, new FakeDeviceSessionPersistence(), {
      barrier: () => {
        return new FakeDbWriteBarrier();
      },
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
    server = createTestUnixSocketServer(
      "/fake/implicit-routing.sock",
      DaemonState.getInstance(),
      timer,
    );
    server.testHooks.acceptingRequests = true;
    loopbacks = [];
    forwards = [];
    // One real MCP server per loopback client key, seeded as the daemon's HTTP endpoint seeds it.
    server.mcpClientFactory = async (boundSessionUuid, profileUuid, releasedSessionUuid) => {
      forwards.push({ connection: currentForwardSessionKey(), boundSessionUuid });
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
    pool.declareMcpSessionLivenessOwnerToken(owner.id, OWNER_TOKEN);
    await pool.bindOrReuseDeviceSession({
      sessionId: HOLDER,
      deviceId: held.deviceId,
      platform: "android",
      allowSessionRebind: false,
      mcpSessionId: owner.id,
    });
    expect(sessionManager.getSession(HOLDER)?.livenessOwnerToken).toBe(OWNER_TOKEN);
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

  async function arrangeHarness(): Promise<void> {
    previousAutolock = process.env.AUTOMOBILE_DEVICE_POOL_AUTOLOCK;
    delete process.env.AUTOMOBILE_DEVICE_POOL_AUTOLOCK;
    spies = silenceLogger();
    await build();
  }

  // Builds the DevicePool harness inside each test, so its cost is paid honestly in the test body.
  function arranged(name: string, fn: () => void | Promise<void>, timeout?: number): void {
    test(
      name,
      async () => {
        await arrangeHarness();
        await fn();
      },
      timeout,
    );
  }

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

  arranged(
    "another connection's first sessionless control calls are refused on its own loopback",
    async () => {
      expect(pool.isSessionOwnedByOtherConnection(HOLDER, stranger.id)).toBe(true);

      await expectStrangerRefused();

      // The plain and the bare call ran as the stranger's own forwards, never seeded for HOLDER.
      expect(forwardsOf(stranger).length).toBeGreaterThan(0);
      expect(forwardsOf(stranger).some((forward) => forward.boundSessionUuid === HOLDER)).toBe(
        false,
      );
    },
  );

  arranged(
    "a read naming the owner's session does not bind the reader's later sessionless calls",
    async () => {
      const before = sessionManager.getSession(HOLDER)!.lastUsedAt;
      timer.advanceTime(60_000);

      const read = await stranger.call("observe", { sessionUuid: HOLDER });

      expect(isToolError(read)).toBe(false);
      await expectStrangerRefused();
      expect(sessionManager.getSession(HOLDER)!.lastUsedAt).toBe(before);
    },
  );

  arranged(
    "setToolEnabled naming the owner's session does not bind the caller's later sessionless calls",
    async () => {
      const edit = await stranger.call("setToolEnabled", {
        toolName: "tapAt",
        enabled: true,
        sessionUuid: HOLDER,
      });

      expect(isToolError(edit)).toBe(false);
      await expectStrangerRefused();
    },
  );

  arranged(
    "a refused control call naming the owner's session does not bind later sessionless calls",
    async () => {
      const named = await stranger.call("tapAt", { x: 1, y: 1, sessionUuid: HOLDER });
      const namedKill = await stranger.call("killDevice", { device: held, sessionUuid: HOLDER });

      expect(payload(named).code).toBe(DEVICE_OWNED_BY_OTHER_SESSION_CODE);
      expect(payload(namedKill).code).toBe(DEVICE_OWNED_BY_OTHER_SESSION_CODE);
      await expectStrangerRefused();
    },
  );

  arranged(
    "on the route both connections share, the owner's binding does not carry to the other",
    async () => {
      // The owner's sessionless calls with a top-level deviceId run on the shared device route, and
      // its setActiveDevice binds the owner's session for the owner's connection.
      const selected = await owner.call("setActiveDevice", {
        deviceId: held.deviceId,
        platform: "android",
      });
      const ownerTap = await owner.call("tapAt", { x: 1, y: 1, deviceId: held.deviceId });
      expect(payload(selected).sessionUuid).toBe(HOLDER);
      expect(isToolError(ownerTap)).toBe(false);

      const tap = await stranger.call("tapAt", { x: 1, y: 1, deviceId: held.deviceId });
      const labelled = await stranger.call("tapAt", {
        x: 1,
        y: 1,
        deviceId: held.deviceId,
        device: "A",
      });
      // Each call runs as its own forward (#11820): none of the stranger's carries the owner's binding.
      expect(forwardsOf(stranger).some((forward) => forward.boundSessionUuid === HOLDER)).toBe(
        false,
      );
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
    },
  );

  arranged("the owner's own sessionless control calls on its device still run", async () => {
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
    expect(server.testHooks.boundMcpClientFor(owner.id)?.sessionUuid).toBe(HOLDER);
    expect(devices.killed).toEqual([held.deviceId]);
  });

  for (const sessionUuid of [null, 5]) {
    arranged(
      `the owner's unmarked tap with sessionUuid ${sessionUuid} still runs as HOLDER`,
      async () => {
        const tap = await owner.call("tapAt", {
          x: 1,
          y: 1,
          deviceId: held.deviceId,
          sessionUuid,
        });

        expect(isToolError(tap)).toBe(false);
        expect(heldRuns().map((run) => run.sessionUuid)).toEqual([HOLDER]);
      },
    );
  }

  arranged(
    "with autolock on, a sessionless call never resolves to another connection's autolock",
    async () => {
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
    },
  );

  // #11555 item 3: a foreign connected owner's binding requires its recorded liveness token.
  describe("a call marking the owner's session as its own bound session", () => {
    const marked = { sessionUuid: HOLDER, [DAEMON_BOUND_SESSION_PARAM]: HOLDER };

    for (const token of [undefined, "someone-else"]) {
      arranged(
        `refuses stranger control with ${token === undefined ? "no" : "a different"} owner token`,
        async () => {
          const before = sessionManager.getSession(HOLDER)!.lastUsedAt;
          timer.advanceTime(60_000);
          const args = {
            ...marked,
            ...(token ? { [DAEMON_OWNED_SESSIONS_OWNER_TOKEN_PARAM]: token } : {}),
          };
          const tap = await stranger.call("tapAt", { x: 1, y: 1, ...args });
          const kill = await stranger.call("killDevice", { device: held, ...args });

          expect(payload(tap).code).toBe(DEVICE_OWNED_BY_OTHER_SESSION_CODE);
          expect(payload(kill).code).toBe(DEVICE_OWNED_BY_OTHER_SESSION_CODE);
          expect(heldRuns()).toEqual([]);
          expect(devices.killed).toEqual([]);
          expect(sessionManager.getSession(HOLDER)!.lastUsedAt).toBe(before);
          expect(server.testHooks.boundMcpClientFor(stranger.id)?.sessionUuid).not.toBe(HOLDER);
        },
      );
    }

    arranged(
      "runs stranger control carrying the recorded owner token before reconnect restore",
      async () => {
        const tap = await stranger.call("tapAt", {
          x: 1,
          y: 1,
          ...marked,
          [DAEMON_OWNED_SESSIONS_OWNER_TOKEN_PARAM]: OWNER_TOKEN,
        });
        expect(isToolError(tap)).toBe(false);
        expect(heldRuns().map((run) => run.sessionUuid)).toEqual([HOLDER]);
        expect(pool.isSessionOwnedByOtherConnection(HOLDER, stranger.id)).toBe(true);
      },
    );

    arranged(
      "restores ownership and runs a fresh connection's marked tap in one call",
      async () => {
        const reconnected = connect();
        expect(pool.isSessionOwnedByOtherConnection(HOLDER, owner.id)).toBe(false);
        expect(pool.isSessionOwnedByOtherConnection(HOLDER, reconnected.id)).toBe(true);

        const tap = await reconnected.call("tapAt", {
          x: 1,
          y: 1,
          ...marked,
          [DAEMON_OWNED_SESSIONS_OWNER_TOKEN_PARAM]: OWNER_TOKEN,
          [DAEMON_OWNED_SESSIONS_PARAM]: [HOLDER],
        });

        expect(isToolError(tap)).toBe(false);
        expect(heldRuns().map((run) => run.sessionUuid)).toEqual([HOLDER]);
        // The existing restore rule transfers ownership rather than retaining two owners.
        expect(pool.isSessionOwnedByOtherConnection(HOLDER, owner.id)).toBe(true);
        expect(pool.isSessionOwnedByOtherConnection(HOLDER, reconnected.id)).toBe(false);
      },
    );

    arranged("refuses a stranger's marked tap and restore with a wrong owner token", async () => {
      const before = sessionManager.peekSession(HOLDER)!.lastUsedAt;
      expect(pool.isSessionOwnedByOtherConnection(HOLDER, owner.id)).toBe(false);
      expect(pool.isSessionOwnedByOtherConnection(HOLDER, stranger.id)).toBe(true);

      const tap = await stranger.call("tapAt", {
        x: 1,
        y: 1,
        ...marked,
        [DAEMON_OWNED_SESSIONS_OWNER_TOKEN_PARAM]: "someone-else",
        [DAEMON_OWNED_SESSIONS_PARAM]: [HOLDER],
      });

      // Targeted restore refusal is a daemon error before any loopback tool call.
      expect(tap.success).toBe(false);
      expect(tap.code).toBe(DEVICE_OWNED_BY_OTHER_SESSION_CODE);
      expect(tap.retryable).toBe(false);
      expect(tools.runs).toEqual([]);
      expect(forwards).toEqual([]);
      expect(pool.isSessionOwnedByOtherConnection(HOLDER, owner.id)).toBe(false);
      expect(pool.isSessionOwnedByOtherConnection(HOLDER, stranger.id)).toBe(true);
      expect(sessionManager.peekSession(HOLDER)!.livenessOwnerToken).toBe(OWNER_TOKEN);
      expect(sessionManager.peekSession(HOLDER)!.lastUsedAt).toBe(before);
    });

    arranged("runs the owning connection's marked call with its token", async () => {
      const tap = await owner.call("tapAt", {
        x: 1,
        y: 1,
        ...marked,
        [DAEMON_OWNED_SESSIONS_OWNER_TOKEN_PARAM]: OWNER_TOKEN,
      });
      expect(isToolError(tap)).toBe(false);
      expect(heldRuns().map((run) => run.sessionUuid)).toEqual([HOLDER]);
    });

    arranged(
      "judges a derived binding by its base owner's token, not the label's token",
      async () => {
        const label = `${HOLDER}:B`;
        sessionManager.setDeviceLabels(HOLDER, { A: HOLDER, B: label });
        await asPlanAllocation(sessionManager, HOLDER, [label], () =>
          pool.assignMultipleDevices([label], 300_000, "android"),
        );
        // Model a label's existing distinct liveness record; only its base owns the connection.
        sessionManager.peekSession(label)!.livenessOwnerToken = "label-token";
        expect(sessionManager.peekSession(label)?.livenessOwnerToken).toBe("label-token");
        expect(sessionManager.ownershipSessionUuid(label)).toBe(HOLDER);
        const before = sessionManager.peekSession(HOLDER)!.lastUsedAt;
        timer.advanceTime(60_000);
        const markedLabel = { sessionUuid: label, [DAEMON_BOUND_SESSION_PARAM]: label };
        const refused = await stranger.call("tapAt", {
          x: 1,
          y: 1,
          ...markedLabel,
          [DAEMON_OWNED_SESSIONS_OWNER_TOKEN_PARAM]: "label-token",
        });
        expect(payload(refused).code).toBe(DEVICE_OWNED_BY_OTHER_SESSION_CODE);
        expect(tools.runs).toEqual([]);
        expect(sessionManager.peekSession(HOLDER)!.lastUsedAt).toBe(before);
        const tap = await stranger.call("tapAt", {
          x: 1,
          y: 1,
          ...markedLabel,
          [DAEMON_OWNED_SESSIONS_OWNER_TOKEN_PARAM]: OWNER_TOKEN,
        });
        expect(isToolError(tap)).toBe(false);
        expect(tools.runs.map((run) => run.sessionUuid)).toEqual([label]);
      },
    );

    arranged(
      "remaining tokenless case of #11555 item 3 still runs stranger marked control",
      async () => {
        const TOKENLESS = "tokenless-session";
        const tokenlessOwner = connect();
        await pool.bindOrReuseDeviceSession({
          sessionId: TOKENLESS,
          deviceId: other.deviceId,
          platform: "android",
          allowSessionRebind: false,
          mcpSessionId: tokenlessOwner.id,
        });
        expect(sessionManager.peekSession(TOKENLESS)?.livenessOwnerToken).toBeUndefined();
        expect(pool.isSessionOwnedByOtherConnection(TOKENLESS, stranger.id)).toBe(true);
        const tap = await stranger.call("tapAt", {
          x: 1,
          y: 1,
          sessionUuid: TOKENLESS,
          [DAEMON_BOUND_SESSION_PARAM]: TOKENLESS,
        });
        expect(isToolError(tap)).toBe(false);
        expect(tools.runs.map((run) => run.sessionUuid)).toEqual([TOKENLESS]);
      },
    );

    arranged(
      "runs marked control without a token after the tokened owner's disconnect",
      async () => {
        pool.releaseMcpSessionBindings(owner.id);
        expect(pool.isSessionOwnedByOtherConnection(HOLDER, stranger.id)).toBe(false);
        expect(sessionManager.peekSession(HOLDER)?.livenessOwnerToken).toBe(OWNER_TOKEN);
        const tap = await stranger.call("tapAt", { x: 1, y: 1, ...marked });
        expect(isToolError(tap)).toBe(false);
        expect(heldRuns().map((run) => run.sessionUuid)).toEqual([HOLDER]);
      },
    );

    arranged("is still answered when it is a read, and does not extend the session", async () => {
      const before = sessionManager.getSession(HOLDER)!.lastUsedAt;
      timer.advanceTime(60_000);

      const read = await stranger.call("observe", marked);

      expect(isToolError(read)).toBe(false);
      expect(sessionManager.getSession(HOLDER)!.lastUsedAt).toBe(before);
    });

    arranged("still runs on a bound session no connected client owns", async () => {
      const OWNERLESS = "ownerless-session";
      await pool.bindOrReuseDeviceSession({
        sessionId: OWNERLESS,
        deviceId: other.deviceId,
        platform: "android",
      });
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
