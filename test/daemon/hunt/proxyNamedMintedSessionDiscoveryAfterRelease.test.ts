import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { DaemonMcpProxy } from "../../../src/daemon/daemonMcpProxy";
import { DaemonClient } from "../../../src/daemon/client";
import { DAEMON_VERSION } from "../../../src/daemon/constants";
import { withRoutedSessionMeta } from "../../../src/server/routedSessionMeta";
import { SESSION_RELEASED_NOTIFICATION_METHOD } from "../../../src/server/sessionReleaseBroadcast";
import { logger } from "../../../src/utils/logger";
import { FakeDaemonManager } from "../../fakes/FakeDaemonManager";
import { FakeDaemonClient } from "../../fakes/FakeDaemonClient";
import { FakeIdGenerator } from "../../fakes/FakeIdGenerator";
import { FakeTimer } from "../../fakes/FakeTimer";

// Hunt (stdio proxy contract): a multi-device agent on a generic connection. Both sessions were
// minted by this proxy's own getAndroid/getApple calls, so after either is released the connection
// recovers in-band and discovery must keep working (#9997: tools/list, resources/list and
// resources/templates/list serve the unbound surface after a result-minted release).
//
// Naming one of those sessions in a call's `sessionUuid` (how an agent addresses one of two
// devices) moves the latest binding to it through updateBoundSessionUuid, which marks the binding
// "client-declared". When that session is then released, the fence carries fromResultMint=false:
// tools/list, resources/list and resources/templates/list fail with session_ownership_lost on
// every request, and no tools/list_changed is sent, although nothing was declared at startup and
// the same release without the explicit naming keeps discovery working.

const ANDROID = { sessionUuid: "android-session", deviceId: "emulator-5554", platform: "android" };
const IOS = { sessionUuid: "ios-session", deviceId: "SIM-UDID-1", platform: "ios" };
const TOOLS = [{ name: "getAndroid", inputSchema: { type: "object" } }];

function deviceStartResult(device: typeof ANDROID) {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify({
          platform: device.platform,
          runtime: { deviceId: device.deviceId, session: { sessionUuid: device.sessionUuid } },
        }),
      },
    ],
  };
}

let client: FakeDaemonClient;
let proxy: DaemonMcpProxy;
let spies: Array<ReturnType<typeof spyOn>>;

beforeEach(() => {
  client = new FakeDaemonClient({
    daemonMethodResults: new Map<string, unknown>([
      ["tools/list", { tools: TOOLS }],
      ["resources/list", { resources: [] }],
    ]),
    toolResultFor: (name, params) =>
      name === "getAndroid"
        ? deviceStartResult(ANDROID)
        : name === "getApple"
          ? deviceStartResult(IOS)
          : // The daemon echoes the session an admitted control call used (#10974).
            withRoutedSessionMeta(
              { content: [{ type: "text", text: "ok" }] },
              typeof params.sessionUuid === "string" ? params.sessionUuid : undefined,
            ),
  });
  const daemonManager = new FakeDaemonManager();
  daemonManager.statusResult = { ...daemonManager.statusResult, version: DAEMON_VERSION };
  spies = [
    spyOn(DaemonClient, "isAvailable").mockResolvedValue(true),
    spyOn(logger, "warn").mockImplementation(() => {}),
    spyOn(logger, "info").mockImplementation(() => {}),
    spyOn(logger, "error").mockImplementation(() => {}),
  ];
  proxy = new DaemonMcpProxy({
    clientFactory: () => client,
    daemonManager,
    autoStartDaemon: false,
    timer: new FakeTimer(),
    idGenerator: new FakeIdGenerator(),
    heartbeatTimeoutMs: 4_000,
    heartbeatIntervalMs: 2_000,
  });
});

afterEach(async () => {
  await proxy.close();
  for (const spy of spies) {
    spy.mockRestore();
  }
});

/** Acquire both devices; iOS is the latest binding and Android is held beside it. */
async function acquireBoth(): Promise<void> {
  await proxy.callTool("getAndroid", {});
  await proxy.callTool("getApple", {});
}

test("control: discovery keeps working after the latest minted session is released", async () => {
  await acquireBoth();
  client.emitNotification(SESSION_RELEASED_NOTIFICATION_METHOD, IOS.sessionUuid, "lazy-expiry");

  await expect(proxy.listTools()).resolves.toEqual(TOOLS);
  await expect(proxy.listResources()).resolves.toEqual([]);
});

test("discovery keeps working after a minted session the agent named by sessionUuid is released", async () => {
  await acquireBoth();
  // The agent addresses its first device by the session UUID getAndroid returned.
  await proxy.callTool("tapOn", { text: "OK", sessionUuid: ANDROID.sessionUuid });
  const listChanged: string[] = [];
  proxy.onListChanged((kind) => listChanged.push(kind));

  client.emitNotification(SESSION_RELEASED_NOTIFICATION_METHOD, ANDROID.sessionUuid, "lazy-expiry");

  // FAILS: both reject with DaemonBoundSessionExpiredError (session_ownership_lost), every time.
  await expect(proxy.listTools()).resolves.toEqual(TOOLS);
  await expect(proxy.listResources()).resolves.toEqual([]);
  // The binding scoped the tool list the client last fetched, as for any minted session.
  expect(listChanged).toContain("tools");
});
