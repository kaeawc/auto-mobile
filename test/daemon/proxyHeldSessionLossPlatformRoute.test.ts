import { afterEach, beforeAll, beforeEach, expect, spyOn, test } from "bun:test";
import {
  DaemonBoundSessionExpiredError,
  DaemonMcpProxy,
  DaemonSessionStalledError,
} from "../../src/daemon/daemonMcpProxy";
import { DAEMON_VERSION } from "../../src/daemon/constants";
import { DAEMON_SESSION_NOT_FOUND_CODE } from "../../src/daemon/types";
import type { LivenessHandover } from "../../src/daemon/proxyLivenessRecovery";
import { sessionOwnershipLostPayload } from "../../src/server/deviceSessionResult";
import { withRoutedSessionMeta } from "../../src/server/routedSessionMeta";
import { SESSION_RELEASED_NOTIFICATION_METHOD } from "../../src/server/sessionReleaseBroadcast";
import { logger } from "../../src/utils/logger";
import { FakeDaemonClient } from "../fakes/FakeDaemonClient";
import { FakeDaemonManager } from "../fakes/FakeDaemonManager";
import { FakeIdGenerator } from "../fakes/FakeIdGenerator";
import { FakeTimer } from "../fakes/FakeTimer";
import { drainUntilQuiescent } from "../helpers/fakeTimerStepping";

interface Device {
  sessionUuid: string;
  deviceId: string;
  platform?: "android" | "ios";
}
const IOS: Device = { sessionUuid: "ios-session", deviceId: "SIM-1", platform: "ios" };
const ANDROID: Device = {
  sessionUuid: "android-session",
  deviceId: "emulator-5554",
  platform: "android",
};
const INTERVAL_MS = 2_000;

let client: FakeDaemonClient;
let proxy: DaemonMcpProxy;
let timer: FakeTimer;
let apple: Device;
let android: Device;
let selected: Device;
let heartbeatError: unknown;
let appleResultOverride: unknown;
let silentIos: boolean;
let thrownNamedAnswer: boolean;
let ended: Map<string, string>;
let handovers: LivenessHandover[];
let spies: Array<ReturnType<typeof spyOn>>;

function deviceResult(device: Device) {
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

function setUp(initialSessionUuid?: string): void {
  timer = new FakeTimer();
  apple = IOS;
  android = ANDROID;
  selected = IOS;
  ended = new Map();
  handovers = [];
  heartbeatError = undefined;
  appleResultOverride = undefined;
  silentIos = false;
  thrownNamedAnswer = false;
  client = new FakeDaemonClient({
    onCallTool: (_name, args) => {
      const reason = ended.get(args.sessionUuid);
      if (reason && thrownNamedAnswer) {
        throw new DaemonBoundSessionExpiredError(args.sessionUuid, reason);
      }
    },
    toolResultFor: (name, args) => {
      if (name === "getApple") {
        return appleResultOverride ?? deviceResult(apple);
      }
      if (name === "getAndroid") {
        return deviceResult(android);
      }
      if (name === "setActiveDevice") {
        return { content: [{ type: "text", text: JSON.stringify(selected) }] };
      }
      const reason = ended.get(args.sessionUuid);
      if (reason) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: JSON.stringify(
                sessionOwnershipLostPayload({
                  sessionUuid: args.sessionUuid,
                  reason,
                  message: "ended",
                }),
              ),
            },
          ],
        };
      }
      return withRoutedSessionMeta(
        { content: [{ type: "text", text: "ok" }] },
        name === "observe" ? undefined : args.sessionUuid,
      );
    },
    onCallDaemonMethod: (method, args) => {
      if (method === "daemon/heartbeat" && args.sessionId === IOS.sessionUuid) {
        if (heartbeatError) {
          throw heartbeatError;
        }
        if (silentIos) {
          return new Promise<never>(() => {});
        }
      }
      return undefined;
    },
  });
  const daemonManager = new FakeDaemonManager();
  daemonManager.statusResult = { ...daemonManager.statusResult, version: DAEMON_VERSION };
  proxy = new DaemonMcpProxy({
    clientFactory: () => client,
    daemonAvailabilityProbe: async () => true,
    daemonManager,
    autoStartDaemon: false,
    timer,
    idGenerator: new FakeIdGenerator(),
    heartbeatTimeoutMs: 10_000,
    heartbeatIntervalMs: INTERVAL_MS,
    ...(initialSessionUuid ? { initialSessionUuid } : {}),
  });
  proxy.onLivenessHandover((handover) => handovers.push(handover));
}

beforeAll(async () => {
  setUp();
  await proxy.callTool("getApple", {});
  await proxy.close();
});
beforeEach(() => {
  spies = [
    spyOn(logger, "info").mockImplementation(() => {}),
    spyOn(logger, "warn").mockImplementation(() => {}),
    spyOn(logger, "error").mockImplementation(() => {}),
  ];
  setUp();
});
afterEach(async () => {
  await proxy.close();
  for (const spy of spies) {
    spy.mockRestore();
  }
});

async function acquireBoth(): Promise<void> {
  await proxy.callTool("getApple", {});
  await proxy.callTool("getAndroid", {});
  client.callToolCalls.length = 0;
}
function release(session = IOS, reason = "device-killed"): void {
  ended.set(session.sessionUuid, reason);
  client.emitNotification(SESSION_RELEASED_NOTIFICATION_METHOD, session.sessionUuid, reason);
}
async function refused(session = IOS, reason = "device-killed"): Promise<void> {
  const before = client.callToolCalls.length;
  const answer = await proxy.callTool("homeScreen", { platform: session.platform }).then(
    () => undefined,
    (error: unknown) => error,
  );
  expect(answer).toBeInstanceOf(DaemonBoundSessionExpiredError);
  expect(answer).toMatchObject({ sessionUuid: session.sessionUuid, reason });
  expect(client.callToolCalls).toHaveLength(before);
}
async function forwarded(
  tool = "homeScreen",
  args: Record<string, unknown> = { platform: "ios" },
  sessionUuid?: string,
): Promise<void> {
  const before = client.callToolCalls.length;
  await proxy.callTool(tool, args);
  expect(client.callToolCalls).toHaveLength(before + 1);
  expect(client.callToolCalls.at(-1)?.params.sessionUuid).toBe(sessionUuid);
}
const advance = (ms: number) => timer.advanceTimeAsync(ms, () => drainUntilQuiescent(timer));

for (const reason of ["device-killed", "cleanup-expired"]) {
  test(`held terminal ${reason} is refused once, then forwarded sessionless`, async () => {
    await acquireBoth();
    release(IOS, reason);
    await refused(IOS, reason);
    await forwarded();
  });
}

test("a read goes through and leaves the held loss for the next control", async () => {
  await acquireBoth();
  release();
  await forwarded("observe");
  await refused();
  await forwarded();
});

test("Android and sessionless controls leave the iOS loss untouched", async () => {
  await acquireBoth();
  release();
  await forwarded("tapOn", { platform: "android" }, ANDROID.sessionUuid);
  await forwarded("tapOn", {}, ANDROID.sessionUuid);
  await refused();
});

for (const thrown of [false, true]) {
  test(`pin: named terminal ${thrown ? "error" : "result"} repeats and clears the platform report`, async () => {
    await acquireBoth();
    release();
    thrownNamedAnswer = thrown;
    for (let i = 0; i < 2; i++) {
      const answer = await proxy.callTool("homeScreen", { sessionUuid: IOS.sessionUuid }).then(
        (result) => result,
        (error: unknown) => error,
      );
      if (thrown) {
        expect(answer).toMatchObject({ sessionUuid: IOS.sessionUuid, reason: "device-killed" });
      } else {
        expect(answer).toMatchObject({ isError: true });
      }
      expect(client.callToolCalls.at(-1)?.params.sessionUuid).toBe(IOS.sessionUuid);
    }
    await forwarded();
  });
}

test("a new acquisition clears every loss of its platform", async () => {
  await acquireBoth();
  release();
  apple = { ...IOS, sessionUuid: "ios-2", deviceId: "SIM-2" };
  await proxy.callTool("getApple", {});
  await forwarded("homeScreen", { platform: "ios" }, apple.sessionUuid);
});

test("a mint released while the previous keeper stops preserves the older platform loss", async () => {
  await acquireBoth();
  release();
  apple = { ...IOS, sessionUuid: "ios-never-published", deviceId: "SIM-2" };
  const clearInterval = timer.clearInterval.bind(timer);
  const stop = spyOn(timer, "clearInterval").mockImplementationOnce((handle) => {
    clearInterval(handle);
    release(apple, "heartbeat-timeout");
  });
  try {
    await expect(proxy.callTool("getApple", {})).rejects.toMatchObject({
      name: "DaemonBoundSessionExpiredError",
      sessionUuid: apple.sessionUuid,
      reason: "heartbeat-timeout",
    });
    await refused();
    await forwarded();
  } finally {
    stop.mockRestore();
  }
});

test("a new acquisition clears an older loss before the acquired session is held and lost", async () => {
  await acquireBoth();
  release();
  apple = { ...IOS, sessionUuid: "ios-2", deviceId: "SIM-2" };
  await proxy.callTool("getApple", {});
  await proxy.callTool("getAndroid", {});
  release(apple);
  await refused(apple);
  await forwarded();
});

test("setActiveDevice clears the loss for the platform named by the call", async () => {
  await acquireBoth();
  release();
  selected = { sessionUuid: "ios-new", deviceId: "SIM-2" };
  await proxy.callTool("setActiveDevice", { ...selected, platform: "ios" });
  await forwarded();
});

test("setActiveDevice reselecting the lost UUID clears its own loss without a platform", async () => {
  await acquireBoth();
  release();
  ended.delete(IOS.sessionUuid);
  selected = { sessionUuid: IOS.sessionUuid, deviceId: IOS.deviceId };
  await proxy.callTool("setActiveDevice", selected);
  await forwarded();
});

test("a named held terminal answer under the default fence consumes its platform loss", async () => {
  await acquireBoth();
  release();
  // A client-declared default reports the named UUID at the fence entry gate.
  selected = { ...ANDROID, sessionUuid: "android-declared" };
  await proxy.callTool("setActiveDevice", selected);
  client.callToolCalls.length = 0;
  release(selected, "explicit-release");
  await expect(
    proxy.callTool("homeScreen", { sessionUuid: IOS.sessionUuid }),
  ).rejects.toMatchObject({
    name: "DaemonBoundSessionExpiredError",
    sessionUuid: IOS.sessionUuid,
    reason: "explicit-release",
  });
  expect(client.callToolCalls).toHaveLength(0);
  android = { ...ANDROID, sessionUuid: "android-2" };
  await proxy.callTool("getAndroid", {});
  await forwarded();
});

test("setActiveDevice selecting known iOS clears its platform loss", async () => {
  await proxy.callTool("getApple", {});
  apple = { ...IOS, sessionUuid: "ios-2", deviceId: "SIM-2" };
  await proxy.callTool("getApple", {});
  await proxy.callTool("getAndroid", {});
  release();
  selected = apple;
  await proxy.callTool("setActiveDevice", { deviceId: selected.deviceId });
  // Select Android before losing iOS, so the second loss is a held loss too.
  selected = ANDROID;
  await proxy.callTool("setActiveDevice", { deviceId: selected.deviceId });
  release(apple);
  await refused(apple);
  await forwarded();
});

test("setActiveDevice selecting an unknown platform clears nothing", async () => {
  await acquireBoth();
  release();
  selected = { sessionUuid: "unknown-session", deviceId: "unknown-device" };
  await proxy.callTool("setActiveDevice", { deviceId: selected.deviceId });
  await refused();
});

test("a surviving held iOS session wins and clears the loss", async () => {
  await proxy.callTool("getApple", {});
  apple = { ...IOS, sessionUuid: "ios-2", deviceId: "SIM-2" };
  await proxy.callTool("getApple", {});
  await proxy.callTool("getAndroid", {});
  release();
  await forwarded("homeScreen", { platform: "ios" }, apple.sessionUuid);
  release(apple);
  await refused(apple);
  await forwarded();
});

test("two live iOS sessions retain ambiguity without consuming pending losses", async () => {
  await proxy.callTool("getApple", {});
  apple = { ...IOS, sessionUuid: "ios-2", deviceId: "SIM-2" };
  await proxy.callTool("getApple", {});
  apple = { ...IOS, sessionUuid: "ios-3", deviceId: "SIM-3" };
  await proxy.callTool("getApple", {});
  await proxy.callTool("getAndroid", {});
  release();
  const before = client.callToolCalls.length;
  await expect(proxy.callTool("homeScreen", { platform: "ios" })).rejects.toMatchObject({
    name: "DaemonAmbiguousSessionSelectorError",
  });
  expect(client.callToolCalls).toHaveLength(before);
  release({ ...IOS, sessionUuid: "ios-2" });
  release(apple);
  await refused();
  await refused({ ...IOS, sessionUuid: "ios-2" });
  await refused(apple);
  await forwarded();
});

test("two held losses are reported in loss order", async () => {
  await proxy.callTool("getApple", {});
  apple = { ...IOS, sessionUuid: "ios-2", deviceId: "SIM-2" };
  await proxy.callTool("getApple", {});
  await proxy.callTool("getAndroid", {});
  release(apple, "explicit-release");
  release();
  await refused(apple, "explicit-release");
  await refused();
  await forwarded();
});

test("pin: a default loss uses its fence and adds no held report", async () => {
  await proxy.callTool("getAndroid", {});
  await proxy.callTool("getApple", {});
  release();
  const before = client.callToolCalls.length;
  await expect(proxy.callTool("homeScreen", { platform: "ios" })).rejects.toMatchObject({
    name: "DaemonConnectionSessionReleasedError",
    reason: "device-killed",
  });
  expect(client.callToolCalls).toHaveLength(before);
  android = { ...ANDROID, sessionUuid: "android-2" };
  await proxy.callTool("getAndroid", {});
  await forwarded();
});

test("the default fence wins repeatedly and leaves a sibling loss pending", async () => {
  await acquireBoth();
  release();
  release(ANDROID, "explicit-release");
  for (let i = 0; i < 2; i++) {
    await expect(proxy.callTool("homeScreen", { platform: "ios" })).rejects.toMatchObject({
      name: "DaemonConnectionSessionReleasedError",
      reason: "explicit-release",
    });
  }
  expect(client.callToolCalls).toHaveLength(0);
  android = { ...ANDROID, sessionUuid: "android-2" };
  await proxy.callTool("getAndroid", {});
  await refused();
  await forwarded();
});

for (const kind of ["expired", "ended"] as const) {
  test(`keeper ${kind} heartbeat records the held platform loss`, async () => {
    await acquireBoth();
    heartbeatError =
      kind === "expired"
        ? new DaemonBoundSessionExpiredError(IOS.sessionUuid, "device-killed")
        : Object.assign(new Error("Session not found"), {
            code: DAEMON_SESSION_NOT_FOUND_CODE,
            releaseReason: "device-killed",
          });
    await advance(INTERVAL_MS);
    expect(
      client.callDaemonMethodCalls.some(
        (call) => call.method === "daemon/heartbeat" && call.params.sessionId === IOS.sessionUuid,
      ),
    ).toBe(true);
    await refused();
    await forwarded();
  });
}

test("a terminal held stall uses and consumes its single pending stalled answer", async () => {
  await acquireBoth();
  silentIos = true;
  for (let elapsed = 0; elapsed < 60_000 && handovers.length === 0; elapsed += 2_000) {
    await advance(2_000);
  }
  expect(handovers[0]?.code).toBe("daemon_stalled");
  release();
  const answer = await proxy.callTool("homeScreen", { platform: "ios" }).then(
    () => undefined,
    (error: unknown) => error,
  );
  expect(answer).toBeInstanceOf(DaemonSessionStalledError);
  expect(answer).toMatchObject({ sessionUuid: IOS.sessionUuid });
  expect(client.callToolCalls).toHaveLength(0);
  await forwarded();
  // Consuming the platform answer also consumed the old named pending loss.
  ended.delete(IOS.sessionUuid);
  silentIos = false;
  await forwarded("homeScreen", { sessionUuid: IOS.sessionUuid }, IOS.sessionUuid);
});

test("pin: a recoverable held handoff does not record a terminal platform report", async () => {
  await acquireBoth();
  client.emitNotification(
    SESSION_RELEASED_NOTIFICATION_METHOD,
    IOS.sessionUuid,
    "device-restart:SIM-1",
  );
  await forwarded("homeScreen", { platform: "ios" }, IOS.sessionUuid);
});

test("acquisition, inventory and profile control leave the loss pending", async () => {
  await acquireBoth();
  release();
  await proxy.callTool("listDevices", { platform: "ios" });
  await proxy.callTool("setToolEnabled", {
    platform: "ios",
    toolName: "homeScreen",
    enabled: true,
  });
  android = { ...ANDROID, sessionUuid: "android-2" };
  await proxy.callTool("getAndroid", { platform: "ios" });
  await refused();
});

test("pin: initialSessionUuid proxies do not refuse platform control for held loss", async () => {
  await proxy.close();
  setUp("initial-session");
  await acquireBoth();
  release();
  await forwarded();
});

test("pin: two live iOS sessions are ambiguous without any loss", async () => {
  await proxy.callTool("getApple", {});
  apple = { ...IOS, sessionUuid: "ios-2", deviceId: "SIM-2" };
  await proxy.callTool("getApple", {});
  await proxy.callTool("getAndroid", {});
  const before = client.callToolCalls.length;
  await expect(proxy.callTool("homeScreen", { platform: "ios" })).rejects.toMatchObject({
    name: "DaemonAmbiguousSessionSelectorError",
  });
  expect(client.callToolCalls).toHaveLength(before);
});

test("a non-minting acquisition result cannot clear a held loss", async () => {
  await acquireBoth();
  release();
  appleResultOverride = { content: [{ type: "text", text: JSON.stringify({ platform: "ios" }) }] };
  await proxy.callTool("getApple", {});
  await refused();
});

test("a live default iOS session wins and clears older held losses", async () => {
  await proxy.callTool("getApple", {});
  apple = { ...IOS, sessionUuid: "ios-2", deviceId: "SIM-2" };
  await proxy.callTool("getApple", {});
  release();
  await forwarded("homeScreen", { platform: "ios" }, apple.sessionUuid);
  await proxy.callTool("getAndroid", {});
  release(apple);
  await refused(apple);
  await forwarded();
});

test("a second notification cannot enqueue the same session twice", async () => {
  await acquireBoth();
  release();
  release();
  await refused();
  await forwarded();
});

test("notification release snapshot and fallback reason are preserved", async () => {
  await acquireBoth();
  const snapshot = {
    sessionId: IOS.sessionUuid,
    deviceId: IOS.deviceId,
    releaseReason: "released",
    releasedAtMs: timer.now(),
    terminal: true,
    heartbeat: {
      lastHeartbeatMs: timer.now(),
      hasReceivedHeartbeat: true,
      timeoutMs: 10_000,
      ageMs: 0,
    },
  };
  client.emitNotification(
    SESSION_RELEASED_NOTIFICATION_METHOD,
    IOS.sessionUuid,
    undefined,
    snapshot,
  );
  const answer = await proxy.callTool("homeScreen", { platform: "ios" }).then(
    () => undefined,
    (error: unknown) => error,
  );
  expect(answer).toBeInstanceOf(DaemonBoundSessionExpiredError);
  expect(answer).toMatchObject({
    sessionUuid: IOS.sessionUuid,
    reason: "released",
    release: snapshot,
  });
  expect(client.callToolCalls).toHaveLength(0);
  await forwarded();
});

test("exhausting a held owner-conflict leash reports the default path's reason", async () => {
  await acquireBoth();
  heartbeatError = Object.assign(new Error("Other owner"), { code: "liveness_owner_conflict" });
  await advance(40_000);
  await refused(IOS, "liveness-owner-conflict");
  await forwarded();
});

test("pin: a held not-found stop without a terminal reason does not report a loss", async () => {
  await acquireBoth();
  heartbeatError = Object.assign(new Error("Session not found"), {
    code: DAEMON_SESSION_NOT_FOUND_CODE,
  });
  await advance(INTERVAL_MS * 2);
  await forwarded();
});

test("pin: a held loss with an unknown platform cannot report a platform loss", async () => {
  apple = { sessionUuid: IOS.sessionUuid, deviceId: IOS.deviceId };
  await acquireBoth();
  release();
  await forwarded();
});

test("Android held losses do not refuse iOS controls", async () => {
  await proxy.callTool("getAndroid", {});
  await proxy.callTool("getApple", {});
  release(ANDROID);
  await forwarded("homeScreen", { platform: "ios" }, IOS.sessionUuid);
  await refused(ANDROID);
  await forwarded("homeScreen", { platform: "android" });
});
