import { afterEach, beforeAll, beforeEach, expect, spyOn, test } from "bun:test";
import { DaemonMcpProxy } from "../../src/daemon/daemonMcpProxy";
import { DaemonClient } from "../../src/daemon/client";
import { DAEMON_VERSION } from "../../src/daemon/constants";
import { withRoutedSessionMeta } from "../../src/server/routedSessionMeta";
import { SESSION_RELEASED_NOTIFICATION_METHOD } from "../../src/server/sessionReleaseBroadcast";
import { logger } from "../../src/utils/logger";
import { FakeDaemonManager } from "../fakes/FakeDaemonManager";
import { FakeDaemonClient } from "../fakes/FakeDaemonClient";
import { FakeIdGenerator } from "../fakes/FakeIdGenerator";
import { FakeTimer } from "../fakes/FakeTimer";
import { drainMicrotasks } from "../helpers/fakeTimerStepping";

// One stdio proxy holding two sessions (#11656 item 2, owner decision 2026-10-11).
//
// The connection's binding is the session its last acquisition minted (iOS). A call that names
// the other held session (Android) targets that one call and never moves the binding (#11347).
// When iOS is released terminally the agent is told before anything else happens to its
// sessionless calls: a sessionless control call is refused with that release, whether a call
// naming Android was in flight when the release landed, ended before it or was made after it.
// The named call itself runs. Afterwards the connection has no binding until the agent chooses
// one: `setActiveDevice` for the surviving session, or a new acquisition. Naming the survivor on
// each call keeps working throughout.

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
let timer: FakeTimer;
/** The session the next `getApple` mints. */
let appleSession: typeof IOS;
/** The session the daemon's `setActiveDevice` answer selects. */
let activeDeviceSelection: typeof ANDROID;
let spies: Array<ReturnType<typeof spyOn>>;
/** While set, a tapOn naming the Android session stays in flight at the daemon. */
let siblingCallGate: Promise<void> | undefined;

const setUp = (): void => {
  siblingCallGate = undefined;
  appleSession = IOS;
  activeDeviceSelection = ANDROID;
  timer = new FakeTimer();
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
          ? deviceStartResult(appleSession)
          : name === "setActiveDevice"
            ? {
                content: [
                  {
                    type: "text",
                    text: JSON.stringify({
                      sessionUuid: activeDeviceSelection.sessionUuid,
                      deviceId: activeDeviceSelection.deviceId,
                    }),
                  },
                ],
              }
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

/** The sessions heartbeated since the daemon-method log was last cleared. */
function heartbeatSessions(): unknown[] {
  return client.callDaemonMethodCalls
    .filter((call) => call.method === "daemon/heartbeat")
    .map((call) => (call.params as { sessionId?: unknown }).sessionId);
}

/** Sessions the sessionless taps (`text: "next"`) were forwarded to. */
function sessionlessTapTargets(): unknown[] {
  return client.callToolCalls
    .filter((call) => call.toolName === "tapOn" && call.params.text === "next")
    .map((call) => call.params.sessionUuid);
}

const SESSIONLESS_TAP = { text: "next" };

/** What the agent's sessionless control call was answered, and where it was forwarded. */
async function sessionlessTap(): Promise<{ answer: unknown; forwardedTo: unknown[] }> {
  const answer = await proxy.callTool("tapOn", SESSIONLESS_TAP).then(
    () => "forwarded",
    (error: unknown) => {
      const refusal = error as { name?: unknown; reason?: unknown };
      return `${String(refusal.name)}: ${String(refusal.reason)}`;
    },
  );
  return { answer, forwardedTo: sessionlessTapTargets() };
}

function releaseIos(): void {
  client.emitNotification(SESSION_RELEASED_NOTIFICATION_METHOD, IOS.sessionUuid, "lazy-expiry");
}

async function tapAndroidByName(): Promise<unknown> {
  return await proxy.callTool("tapOn", { text: "sibling", sessionUuid: ANDROID.sessionUuid });
}

/** Sessions the taps naming the sibling (`text: "sibling"`) were forwarded to. */
function namedTapTargets(): unknown[] {
  return client.callToolCalls
    .filter((call) => call.toolName === "tapOn" && call.params.text === "sibling")
    .map((call) => call.params.sessionUuid);
}

const RELEASE_REPORTED = {
  answer: "DaemonConnectionSessionReleasedError: lazy-expiry",
  forwardedTo: [],
};

test("control: the sibling call ends before the binding is released, so the next sessionless control call is refused", async () => {
  await acquireBoth();
  await tapAndroidByName();
  releaseIos();

  expect(await sessionlessTap()).toEqual(RELEASE_REPORTED);
});

test("the binding is released while a call naming the held sibling is in flight: the next sessionless control call is still refused, never sent to the sibling", async () => {
  await acquireBoth();
  const { promise, resolve } = Promise.withResolvers<void>();
  siblingCallGate = promise;
  const siblingCall = tapAndroidByName();
  await drainMicrotasks(32);

  releaseIos();
  resolve();
  // The sibling's own call is not disturbed by the other session's release.
  await expect(siblingCall).resolves.toMatchObject({ content: [{ text: "ok" }] });

  // The agent's sessionless call was going to iOS, which is gone: it must be told so.
  expect(await sessionlessTap()).toEqual(RELEASE_REPORTED);
});

test("a call naming the held sibling after the release runs, and the release is still reported to the next sessionless control call", async () => {
  await acquireBoth();
  releaseIos();

  await expect(tapAndroidByName()).resolves.toMatchObject({ content: [{ text: "ok" }] });

  expect(await sessionlessTap()).toEqual(RELEASE_REPORTED);
});

test("once the release was reported, naming the sibling still binds nothing: sessionless control calls stay refused and named ones keep running", async () => {
  await acquireBoth();
  releaseIos();
  const reported = await sessionlessTap();

  await tapAndroidByName();
  const afterNamed = await sessionlessTap();
  await tapAndroidByName();

  expect({ reported, afterNamed, namedCallsForwarded: namedTapTargets() }).toEqual({
    reported: RELEASE_REPORTED,
    afterNamed: RELEASE_REPORTED,
    namedCallsForwarded: [ANDROID.sessionUuid, ANDROID.sessionUuid],
  });
});

test("setActiveDevice for the surviving session is what binds it: sessionless control calls then go there", async () => {
  await acquireBoth();
  releaseIos();
  const reported = await sessionlessTap();

  activeDeviceSelection = ANDROID;
  await proxy.callTool("setActiveDevice", { deviceId: ANDROID.deviceId, platform: "android" });

  expect({ reported, next: await sessionlessTap() }).toEqual({
    reported: RELEASE_REPORTED,
    next: { answer: "forwarded", forwardedTo: [ANDROID.sessionUuid] },
  });
});

test("a new acquisition binds its session: sessionless control calls then go there", async () => {
  await acquireBoth();
  releaseIos();
  await tapAndroidByName();

  const NEXT_IOS = { ...IOS, sessionUuid: "ios-session-2" };
  appleSession = NEXT_IOS;
  await proxy.callTool("getApple", {});

  expect(await sessionlessTap()).toEqual({
    answer: "forwarded",
    forwardedTo: [NEXT_IOS.sessionUuid],
  });
});

test("the surviving session keeps its heartbeats while the connection has no binding", async () => {
  await acquireBoth();
  releaseIos();
  await sessionlessTap();
  await tapAndroidByName();
  client.callDaemonMethodCalls.length = 0;

  await timer.advanceTimeAsync(2_000);

  expect(heartbeatSessions()).toEqual([ANDROID.sessionUuid]);
});
