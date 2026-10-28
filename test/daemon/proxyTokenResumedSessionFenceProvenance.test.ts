import { afterEach, beforeAll, beforeEach, expect, spyOn, test } from "bun:test";
import { DaemonBoundSessionExpiredError, DaemonMcpProxy } from "../../src/daemon/daemonMcpProxy";
import { DaemonClient } from "../../src/daemon/client/client";
import {
  DAEMON_TOKEN_OWNED_SESSIONS_METHOD,
  DAEMON_VERSION,
} from "../../src/daemon/wire/constants";
import { withRoutedSessionMeta } from "../../src/daemon/routedSessionMeta";
import { SESSION_RELEASED_NOTIFICATION_METHOD } from "../../src/daemon/sessionReleaseBroadcast";
import { logger } from "../../src/utils/logger";
import { FakeDaemonManager } from "../fakes/FakeDaemonManager";
import { FakeDaemonClient } from "../fakes/FakeDaemonClient";
import { FakeIdGenerator } from "../fakes/FakeIdGenerator";
import { FakeTimer } from "../fakes/FakeTimer";

// #11483 item 4, the token-resume case. A proxy restarted with a stable owner token resumes the
// sessions that token owns (#10990); they are claimable like a minted session. Fence provenance is
// derived from that, so two things are pinned here:
//  - with a startup binding, a resumed session never displaces it, so the DECLARED fence of the
//    startup session is exactly as strict as before (discovery fails with ownership lost);
//  - without one, a resumed session the connection adopts is the same owner's earlier acquisition:
//    its release leaves a generic connection that recovers in-band, so discovery keeps working.

const STARTUP = "startup-session";
const RESUMED = "resumed-session";
const TOOLS = [{ name: "getAndroid", inputSchema: { type: "object" } }];

let timer: FakeTimer;
let client: FakeDaemonClient;
let proxy: DaemonMcpProxy | undefined;
let spies: Array<ReturnType<typeof spyOn>>;

const setUp = (): void => {
  timer = new FakeTimer();
  client = new FakeDaemonClient({
    daemonMethodResults: new Map<string, unknown>([
      ["tools/list", { tools: TOOLS }],
      ["resources/list", { resources: [] }],
      [
        DAEMON_TOKEN_OWNED_SESSIONS_METHOD,
        {
          sessions: [
            {
              sessionId: RESUMED,
              deviceId: "emulator-5554",
              platform: "android",
              lastUsedAt: timer.now(),
            },
          ],
        },
      ],
    ]),
    // The daemon echoes the session an admitted control call used (#10974).
    toolResultFor: (_name, params) =>
      withRoutedSessionMeta(
        { content: [{ type: "text", text: "ok" }] },
        typeof params.sessionUuid === "string" ? params.sessionUuid : undefined,
      ),
  });
  spies = [
    spyOn(DaemonClient, "isAvailable").mockResolvedValue(true),
    spyOn(logger, "warn").mockImplementation(() => {}),
    spyOn(logger, "info").mockImplementation(() => {}),
    spyOn(logger, "error").mockImplementation(() => {}),
  ];
};

const tearDown = async (): Promise<void> => {
  await proxy?.close();
  proxy = undefined;
  for (const spy of spies) {
    spy.mockRestore();
  }
};

// The first connection pays the proxy's one-time module cost; pay it outside the timed tests.
beforeAll(async () => {
  setUp();
  try {
    const warm = connect(STARTUP);
    await warm.listTools();
    await warm.callTool("tapOn", { text: "OK", sessionUuid: RESUMED });
  } finally {
    await tearDown();
  }
});

beforeEach(setUp);
afterEach(tearDown);

function connect(initialSessionUuid?: string): DaemonMcpProxy {
  const daemonManager = new FakeDaemonManager();
  daemonManager.statusResult = { ...daemonManager.statusResult, version: DAEMON_VERSION };
  proxy = new DaemonMcpProxy({
    ...(initialSessionUuid ? { initialSessionUuid } : {}),
    livenessOwnerToken: "stable-owner-token",
    clientFactory: () => client,
    daemonManager,
    autoStartDaemon: false,
    timer,
    idGenerator: new FakeIdGenerator(),
    heartbeatTimeoutMs: 4_000,
    heartbeatIntervalMs: 2_000,
  });
  return proxy;
}

test("a resumed session beside a startup binding leaves the declared fence as strict as before", async () => {
  const startupBound = connect(STARTUP);
  await startupBound.listTools();
  // The agent uses and selects the resumed session; the startup binding stays the binding.
  await startupBound.callTool("tapOn", { text: "OK", sessionUuid: RESUMED });
  await startupBound.callTool("setActiveDevice", { deviceId: "emulator-5554" });
  const listChanged: string[] = [];
  startupBound.onListChanged((kind) => listChanged.push(kind));

  client.emitNotification(SESSION_RELEASED_NOTIFICATION_METHOD, STARTUP, "lazy-expiry");

  await expect(startupBound.listTools()).rejects.toBeInstanceOf(DaemonBoundSessionExpiredError);
  await expect(startupBound.listResources()).rejects.toBeInstanceOf(DaemonBoundSessionExpiredError);
  // Naming the resumed session does not lift it either.
  await expect(
    startupBound.callTool("tapOn", { text: "OK", sessionUuid: RESUMED }),
  ).rejects.toBeInstanceOf(DaemonBoundSessionExpiredError);
  await expect(startupBound.listTools()).rejects.toBeInstanceOf(DaemonBoundSessionExpiredError);
  expect(listChanged).not.toContain("tools");
});

test("releasing the resumed session beside a startup binding fences nothing", async () => {
  const startupBound = connect(STARTUP);
  await startupBound.listTools();
  await startupBound.callTool("tapOn", { text: "OK", sessionUuid: RESUMED });

  client.emitNotification(SESSION_RELEASED_NOTIFICATION_METHOD, RESUMED, "lazy-expiry");

  await expect(startupBound.listTools()).resolves.toEqual(TOOLS);
  await startupBound.callTool("tapOn", { text: "OK" });
  expect(client.callToolCalls.at(-1)?.params.sessionUuid).toBe(STARTUP);
});

test("a generic connection that adopted a resumed session keeps discovery after its release", async () => {
  const generic = connect();
  await generic.listTools();
  // No binding yet: the connection adopts the resumed session the agent names.
  await generic.callTool("tapOn", { text: "OK", sessionUuid: RESUMED });
  const listChanged: string[] = [];
  generic.onListChanged((kind) => listChanged.push(kind));

  client.emitNotification(SESSION_RELEASED_NOTIFICATION_METHOD, RESUMED, "lazy-expiry");

  await expect(generic.listTools()).resolves.toEqual(TOOLS);
  await expect(generic.listResources()).resolves.toEqual([]);
  expect(listChanged).toContain("tools");
});
