import { afterEach, beforeAll, beforeEach, expect, spyOn, test } from "bun:test";
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
import { drainMicrotasks } from "../../helpers/fakeTimerStepping";

// HUNT (proxy-cli-ingress-parity-1): one stdio proxy holding two sessions.
//
// The connection's binding is the session its last acquisition minted (iOS). A call that names
// the other held session (Android) targets that one call and leaves the binding alone (#11347),
// so a sessionless control call keeps going to iOS, and once iOS is released terminally a
// sessionless control call is refused: the agent is told its device session is gone.
//
// That holds when the release lands with nothing in flight. When it lands while a call naming the
// sibling is in flight, the call's completion (rememberSessionUuid) drops the fence the release
// just raised and makes the sibling the binding. The release of iOS is then never reported, and
// the next sessionless control call is forwarded to the Android session: a tap meant for the iOS
// device drives the Android one. Which of the two answers the agent gets depends only on whether
// the sibling call ended a moment before or a moment after the release.

const ANDROID = { sessionUuid: "android-session", deviceId: "emulator-5554", platform: "android" };
const IOS = { sessionUuid: "ios-session", deviceId: "SIM-UDID-1", platform: "ios" };

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
/** While set, a tapOn naming the Android session stays in flight at the daemon. */
let siblingCallGate: Promise<void> | undefined;

const setUp = (): void => {
  siblingCallGate = undefined;
  client = new FakeDaemonClient({
    onCallTool: async (name, params) => {
      if (name === "tapOn" && params.sessionUuid === ANDROID.sessionUuid && siblingCallGate) {
        await siblingCallGate;
      }
    },
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
  } finally {
    await tearDown();
  }
});

beforeEach(setUp);
afterEach(tearDown);

/** Acquire both devices; iOS is the binding and Android is held beside it. */
async function acquireBoth(): Promise<void> {
  await proxy.callTool("getAndroid", {});
  await proxy.callTool("getApple", {});
}

/** Sessions the sessionless taps (`text: "next"`) were forwarded to. */
function sessionlessTapTargets(): unknown[] {
  return client.callToolCalls
    .filter((call) => call.toolName === "tapOn" && call.params.text === "next")
    .map((call) => call.params.sessionUuid);
}

test("control: the sibling call ends before the binding is released, so the next sessionless control call is refused", async () => {
  await acquireBoth();
  await proxy.callTool("tapOn", { text: "sibling", sessionUuid: ANDROID.sessionUuid });
  client.emitNotification(SESSION_RELEASED_NOTIFICATION_METHOD, IOS.sessionUuid, "lazy-expiry");

  await expect(proxy.callTool("tapOn", { text: "next" })).rejects.toMatchObject({
    reason: "lazy-expiry",
  });
  expect(sessionlessTapTargets()).toEqual([]);
});

test("the binding is released while a call naming the held sibling is in flight: the next sessionless control call is still refused, never sent to the sibling", async () => {
  await acquireBoth();
  const { promise, resolve } = Promise.withResolvers<void>();
  siblingCallGate = promise;
  // Named beside a live binding: this call targets Android only (#11347).
  const siblingCall = proxy.callTool("tapOn", {
    text: "sibling",
    sessionUuid: ANDROID.sessionUuid,
  });
  await drainMicrotasks(32);

  client.emitNotification(SESSION_RELEASED_NOTIFICATION_METHOD, IOS.sessionUuid, "lazy-expiry");
  resolve();
  // The sibling's own call is not disturbed by the other session's release.
  await expect(siblingCall).resolves.toMatchObject({ content: [{ text: "ok" }] });

  // The agent's sessionless call was going to iOS, which is gone: it must be told so.
  const next = proxy.callTool("tapOn", { text: "next" }).then(
    () => "forwarded",
    (error: unknown) => (error as { reason?: unknown }).reason,
  );
  expect({ answer: await next, forwardedTo: sessionlessTapTargets() }).toEqual({
    answer: "lazy-expiry",
    forwardedTo: [],
  });
});
