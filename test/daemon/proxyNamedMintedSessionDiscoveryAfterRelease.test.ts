import { afterEach, beforeAll, beforeEach, expect, spyOn, test } from "bun:test";
import { DaemonBoundSessionExpiredError, DaemonMcpProxy } from "../../src/daemon/daemonMcpProxy";
import { DaemonClient } from "../../src/daemon/client";
import { DAEMON_OWNED_SESSIONS_PARAM, DAEMON_VERSION } from "../../src/daemon/constants";
import {
  withForeignOwnedSessionMeta,
  withRoutedSessionMeta,
} from "../../src/server/routedSessionMeta";
import { SESSION_RELEASED_NOTIFICATION_METHOD } from "../../src/server/sessionReleaseBroadcast";
import { logger } from "../../src/utils/logger";
import { FakeDaemonManager } from "../fakes/FakeDaemonManager";
import { FakeDaemonClient } from "../fakes/FakeDaemonClient";
import { FakeIdGenerator } from "../fakes/FakeIdGenerator";
import { FakeTimer } from "../fakes/FakeTimer";

// #11483 item 4 (stdio proxy contract): a multi-device agent on a generic connection. Both
// sessions were minted by this proxy's own getAndroid/getApple calls, so after either is released
// the connection recovers in-band and discovery must keep working (#9997: tools/list,
// resources/list and resources/templates/list serve the unbound surface after a result-minted
// release, and tools/list_changed prompts the re-list).
//
// The binding can return to an earlier minted session without an acquisition: setActiveDevice
// selects it. That move used to mark the binding "client-declared", so the fence for its release
// carried fromResultMint=false and discovery failed with session_ownership_lost on every request.
// Naming a held session never moves the binding (#11347), nor replaces one that was released
// (#11656): the connection stays unbound until setActiveDevice or an acquisition.

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
let timer: FakeTimer;
let namedReadResponse: { fail: boolean; marked: boolean } | undefined;

function namedReadResult(response: { fail: boolean; marked: boolean }) {
  // Even an admission echo cannot override the do-not-remember marker on errors.
  const result = withRoutedSessionMeta(
    { content: [{ type: "text", text: "read result" }], isError: response.fail },
    response.fail ? "ownerless-session" : undefined,
  );
  return response.marked ? withForeignOwnedSessionMeta(result, "ownerless-session") : result;
}

const setUp = (): void => {
  namedReadResponse = undefined;
  timer = new FakeTimer();
  client = new FakeDaemonClient({
    daemonMethodResults: new Map<string, unknown>([
      ["tools/list", { tools: TOOLS }],
      ["resources/list", { resources: [] }],
      ["resources/list-templates", { resourceTemplates: [] }],
    ]),
    toolResultFor: (name, params) =>
      name === "getAndroid"
        ? deviceStartResult(ANDROID)
        : name === "getApple"
          ? deviceStartResult(IOS)
          : name === "setActiveDevice"
            ? {
                content: [
                  {
                    type: "text",
                    text: JSON.stringify({
                      deviceId: ANDROID.deviceId,
                      sessionUuid: ANDROID.sessionUuid,
                    }),
                  },
                ],
              }
            : name === "observe" && namedReadResponse !== undefined
              ? namedReadResult(namedReadResponse)
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
    timer,
    idGenerator: new FakeIdGenerator(),
    heartbeatTimeoutMs: 4_000,
    heartbeatIntervalMs: 2_000,
  });
};

const tearDown = async (): Promise<void> => {
  await proxy.close();
  for (const spy of spies) {
    spy.mockRestore();
  }
};

// The first acquisition pays the proxy's one-time module cost; pay it outside the timed tests.
beforeAll(async () => {
  setUp();
  try {
    await proxy.callTool("getAndroid", {});
    await proxy.listTools();
  } finally {
    await tearDown();
  }
});

beforeEach(setUp);
afterEach(tearDown);

test.each([false, true])(
  "a marked named read leaves the next call without the session and discovery unfenced (failure=%s)",
  async (fail) => {
    namedReadResponse = { fail, marked: true };
    await proxy.callTool("observe", { sessionUuid: "ownerless-session" });
    await proxy.callTool("observe", {});
    const next = client.callToolCalls.at(-1)!.params;
    expect(next.sessionUuid).toBeUndefined();
    expect(next[DAEMON_OWNED_SESSIONS_PARAM]).toBeUndefined();
    client.emitNotification(
      SESSION_RELEASED_NOTIFICATION_METHOD,
      "ownerless-session",
      "lazy-expiry",
    );
    await expect(proxy.listTools()).resolves.toEqual(TOOLS);
  },
);

test.each([false, true])(
  "control: the same named read without the marker binds the session carried by the next call (failure=%s)",
  async (fail) => {
    namedReadResponse = { fail, marked: false };
    await proxy.callTool("observe", { sessionUuid: "ownerless-session" });
    await proxy.callTool("observe", {});
    const next = client.callToolCalls.at(-1)!.params;
    expect(next.sessionUuid).toBe("ownerless-session");
  },
);

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

test("naming a held minted session leaves the binding alone, so its release fences nothing", async () => {
  await acquireBoth();
  await proxy.callTool("tapOn", { text: "OK", sessionUuid: ANDROID.sessionUuid });

  client.emitNotification(SESSION_RELEASED_NOTIFICATION_METHOD, ANDROID.sessionUuid, "lazy-expiry");

  await expect(proxy.listTools()).resolves.toEqual(TOOLS);
  await expect(proxy.listResources()).resolves.toEqual([]);
});

/** Discovery serves the unbound surface and the client was prompted to re-list. */
async function expectDiscoveryAfterRelease(listChanged: string[]): Promise<void> {
  await expect(proxy.listTools()).resolves.toEqual(TOOLS);
  await expect(proxy.listResources()).resolves.toEqual([]);
  await expect(proxy.listResourceTemplates()).resolves.toEqual([]);
  // The binding scoped the tool list the client last fetched, as for any minted session.
  expect(listChanged).toContain("tools");
}

test("discovery keeps working after a minted session selected with setActiveDevice is released", async () => {
  await acquireBoth();
  // The agent makes its first device the connection's default again.
  await proxy.callTool("setActiveDevice", { deviceId: ANDROID.deviceId });
  const listChanged: string[] = [];
  proxy.onListChanged((kind) => listChanged.push(kind));

  client.emitNotification(SESSION_RELEASED_NOTIFICATION_METHOD, ANDROID.sessionUuid, "lazy-expiry");

  await expectDiscoveryAfterRelease(listChanged);
});

test("a held minted session named once the latest binding was gone stays unbound: its own release leaves discovery on the unbound surface", async () => {
  await acquireBoth();
  client.emitNotification(SESSION_RELEASED_NOTIFICATION_METHOD, IOS.sessionUuid, "lazy-expiry");
  // The call runs on the surviving session; a named call never becomes the binding (#11656).
  await proxy.callTool("tapOn", { text: "OK", sessionUuid: ANDROID.sessionUuid });
  const listChanged: string[] = [];
  proxy.onListChanged((kind) => listChanged.push(kind));

  client.emitNotification(SESSION_RELEASED_NOTIFICATION_METHOD, ANDROID.sessionUuid, "lazy-expiry");

  await expect(proxy.listTools()).resolves.toEqual(TOOLS);
  await expect(proxy.listResources()).resolves.toEqual([]);
  await expect(proxy.listResourceTemplates()).resolves.toEqual([]);
  // The connection was unbound already (the client was prompted when iOS went): nothing to re-list.
  expect(listChanged).toEqual([]);
});

test("a session only named by the caller keeps the client-declared fence", async () => {
  // Never minted here: another owner's session the agent names on an unbound connection.
  await proxy.callTool("tapOn", { text: "OK", sessionUuid: "foreign-session" });

  client.emitNotification(SESSION_RELEASED_NOTIFICATION_METHOD, "foreign-session", "lazy-expiry");

  await expect(proxy.listTools()).rejects.toBeInstanceOf(DaemonBoundSessionExpiredError);
});
