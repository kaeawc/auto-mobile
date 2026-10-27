import { afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import { DaemonMcpProxy } from "../../src/daemon/daemonMcpProxy";
import {
  DAEMON_BOUND_SESSION_PARAM,
  DAEMON_BOUND_SESSION_REPLAY_TTL_MS,
  DAEMON_OWNED_SESSIONS_PARAM,
  DAEMON_VERSION,
} from "../../src/daemon/wire/constants";
import { withRoutedSessionMeta } from "../../src/daemon/routedSessionMeta";
import { SESSION_RELEASED_NOTIFICATION_METHOD } from "../../src/daemon/sessionReleaseBroadcast";
import { FakeDaemonClient } from "../fakes/FakeDaemonClient";
import { FakeDaemonManager } from "../fakes/FakeDaemonManager";
import { FakeIdGenerator } from "../fakes/FakeIdGenerator";
import { FakeTimer } from "../fakes/FakeTimer";

const ANDROID = { sessionUuid: "android-session", deviceId: "emulator-5554", platform: "android" };
const IOS = { sessionUuid: "ios-session", deviceId: "SIM-UDID-1", platform: "ios" };

let client: FakeDaemonClient;
let proxy: DaemonMcpProxy;
let timer: FakeTimer;
let android: { sessionUuid: string; deviceId?: string; platform: string };
let forwarded: Array<{ name: string; args: Record<string, unknown> }>;

function startResult(device: typeof android) {
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

function setUp(): void {
  android = ANDROID;
  forwarded = [];
  timer = new FakeTimer();
  client = new FakeDaemonClient({
    onCallTool: (name, args) => {
      forwarded.push({ name, args: { ...args } });
    },
    toolResultFor: (name, args) =>
      name === "getAndroid"
        ? startResult(android)
        : name === "getApple"
          ? startResult(IOS)
          : name === "setActiveDevice"
            ? { content: [{ type: "text", text: JSON.stringify(ANDROID) }] }
            : withRoutedSessionMeta(
                { content: [{ type: "text", text: "ok" }] },
                name === "observe"
                  ? undefined
                  : typeof args.sessionUuid === "string"
                    ? args.sessionUuid
                    : args.deviceId === ANDROID.deviceId || args.platform === "android"
                      ? ANDROID.sessionUuid
                      : undefined,
              ),
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
    heartbeatTimeoutMs: 4_000,
    // Let a call itself discover replay expiry, before the keeper does.
    heartbeatIntervalMs: DAEMON_BOUND_SESSION_REPLAY_TTL_MS * 2,
  });
}

beforeAll(async () => {
  setUp();
  try {
    await proxy.callTool("getAndroid", {});
  } finally {
    await proxy.close();
  }
});
beforeEach(setUp);
afterEach(async () => {
  await proxy.close();
});

async function acquireBoth(release = true): Promise<void> {
  await proxy.callTool("getAndroid", {});
  await proxy.callTool("getApple", {});
  if (release) {
    client.emitNotification(SESSION_RELEASED_NOTIFICATION_METHOD, IOS.sessionUuid, "lazy-expiry");
  }
  forwarded.length = 0;
}

async function refused(args: Record<string, unknown>, reason = "lazy-expiry"): Promise<void> {
  const before = forwarded.length;
  const answer = await proxy.callTool("tapOn", { text: "next", ...args }).then(
    () => "forwarded",
    (error: unknown) => error,
  );
  expect(answer).toMatchObject({ name: "DaemonConnectionSessionReleasedError", reason });
  expect(forwarded).toHaveLength(before);
}

for (const [label, args] of [
  ["survivor platform", { platform: "android" }],
  ["ended platform", { platform: "ios" }],
  ["ended device", { deviceId: IOS.deviceId }],
  ["unknown device", { deviceId: "nobody" }],
  ["device label", { device: "android", deviceId: ANDROID.deviceId }],
] as const) {
  test(`fenced control refuses ${label}, repeatedly, without forwarding`, async () => {
    await acquireBoth();
    await refused(args);
    await refused(args);
  });
}

for (const args of [
  { deviceId: ANDROID.deviceId },
  { deviceId: ANDROID.deviceId, platform: "android" },
  { deviceId: ANDROID.deviceId, platform: "ios" },
] as const) {
  test(`fenced device control names the survivor and leaves the fence: ${JSON.stringify(args)}`, async () => {
    await acquireBoth();
    await expect(proxy.callTool("tapOn", args)).resolves.toMatchObject({
      content: [{ text: "ok" }],
    });
    expect(forwarded).toHaveLength(1);
    expect(forwarded[0]?.args).toMatchObject({
      ...args,
      sessionUuid: ANDROID.sessionUuid,
      [DAEMON_BOUND_SESSION_PARAM]: IOS.sessionUuid,
      [DAEMON_OWNED_SESSIONS_PARAM]: [ANDROID.sessionUuid],
    });
    // The admitted device call has not surfaced the release for subsequent reads.
    await expect(proxy.callTool("observe", {})).rejects.toMatchObject({ reason: "lazy-expiry" });
    await refused({});
  });
}

test("a held session with no learned device cannot be selected", async () => {
  android = { sessionUuid: ANDROID.sessionUuid, platform: ANDROID.platform };
  await acquireBoth();
  await refused({ deviceId: ANDROID.deviceId });
});

test("an unknown held device prevents proving a known holder is unique", async () => {
  await proxy.callTool("getAndroid", {});
  android = { sessionUuid: "unknown-session", platform: "android" };
  await acquireBoth();
  await refused({ deviceId: ANDROID.deviceId });
});

test("two held sessions claiming the same device are refused", async () => {
  await proxy.callTool("getAndroid", {});
  android = { ...ANDROID, sessionUuid: "duplicate-session" };
  await acquireBoth();
  await refused({ deviceId: ANDROID.deviceId });
});

test("a stale device learned from a successful named call remains the proxy's routing authority", async () => {
  await acquireBoth(false);
  await proxy.callTool("tapOn", { sessionUuid: ANDROID.sessionUuid, deviceId: "stale-device" });
  client.emitNotification(SESSION_RELEASED_NOTIFICATION_METHOD, IOS.sessionUuid, "lazy-expiry");
  forwarded.length = 0;
  await refused({ deviceId: ANDROID.deviceId });
  await proxy.callTool("tapOn", { deviceId: "stale-device" });
  expect(forwarded).toHaveLength(1);
  expect(forwarded[0]?.args.sessionUuid).toBe(ANDROID.sessionUuid);
  await refused({});
});

test("a device-named control carries the same session capabilities as an explicitly named control", async () => {
  await acquireBoth();
  const args = { deviceId: ANDROID.deviceId, platform: "android" };
  await proxy.callTool("tapOn", { ...args, sessionUuid: ANDROID.sessionUuid });
  await proxy.callTool("tapOn", args);
  expect(forwarded).toHaveLength(2);
  expect(forwarded[1]?.args).toEqual(forwarded[0]?.args);
  expect(forwarded[0]?.args[DAEMON_BOUND_SESSION_PARAM]).toBe(IOS.sessionUuid);
});

test("a platform refusal surfaces the release so a sessionless read goes through", async () => {
  await acquireBoth();
  await refused({ platform: "android" });
  await expect(proxy.callTool("observe", {})).resolves.toMatchObject({ content: [{ text: "ok" }] });
  expect(forwarded).toHaveLength(1);
  expect(forwarded[0]?.args.sessionUuid).toBeUndefined();
});

for (const args of [{ platform: "android" }, { deviceId: ANDROID.deviceId }] as const) {
  test(`a selector read before the release is surfaced stays sessionless: ${JSON.stringify(args)}`, async () => {
    await acquireBoth();
    await proxy.callTool("observe", args);
    expect(forwarded[0]?.args).toMatchObject({
      ...args,
      [DAEMON_OWNED_SESSIONS_PARAM]: [ANDROID.sessionUuid],
    });
    expect(forwarded[0]?.args.sessionUuid).toBeUndefined();
    expect(forwarded[0]?.args[DAEMON_BOUND_SESSION_PARAM]).toBeUndefined();
    await expect(proxy.callTool("observe", {})).rejects.toMatchObject({ reason: "lazy-expiry" });
  });
}

test("setActiveDevice stays sessionless and rebinds platform-only calls to the new default", async () => {
  await acquireBoth();
  const args = { deviceId: ANDROID.deviceId, platform: "android" };
  await proxy.callTool("setActiveDevice", args);
  expect(forwarded[0]?.args).toMatchObject(args);
  expect(forwarded[0]?.args.sessionUuid).toBeUndefined();
  await proxy.callTool("tapOn", { platform: "android" });
  expect(forwarded[1]?.args.platform).toBe("android");
  expect(forwarded[1]?.args.sessionUuid).toBe(ANDROID.sessionUuid);
  await proxy.callTool("tapOn", {});
  expect(forwarded[2]?.args.sessionUuid).toBe(ANDROID.sessionUuid);
});

for (const args of [{ deviceId: ANDROID.deviceId }, { platform: "android" }] as const) {
  test(`without a fence the sibling control ${"platform" in args ? "names its own platform session" : "remains unchanged and sessionless"}: ${JSON.stringify(args)}`, async () => {
    await acquireBoth(false);
    await proxy.callTool("tapOn", args);
    expect(forwarded[0]?.args).toMatchObject({
      ...args,
      [DAEMON_OWNED_SESSIONS_PARAM]: [IOS.sessionUuid, ANDROID.sessionUuid],
    });
    if ("platform" in args) {
      expect(forwarded[0]?.args.sessionUuid).toBe(ANDROID.sessionUuid);
      expect(forwarded[0]?.args[DAEMON_BOUND_SESSION_PARAM]).toBe(IOS.sessionUuid);
    } else {
      expect(forwarded[0]?.args.sessionUuid).toBeUndefined();
      expect(forwarded[0]?.args[DAEMON_BOUND_SESSION_PARAM]).toBeUndefined();
    }
  });
}

for (const selector of ["platform", "deviceId"] as const) {
  test(`the ${selector} control itself discovers replay expiry and follows the fence rule`, async () => {
    await acquireBoth(false);
    await timer.advanceTimeAsync(DAEMON_BOUND_SESSION_REPLAY_TTL_MS / 2);
    await proxy.callTool("tapOn", { deviceId: ANDROID.deviceId });
    await timer.advanceTimeAsync(DAEMON_BOUND_SESSION_REPLAY_TTL_MS / 2 + 1);
    forwarded.length = 0;
    if (selector === "platform") {
      await refused({ platform: "android" }, "replay-lease-expired");
    }
    await proxy.callTool("tapOn", { deviceId: ANDROID.deviceId });
    expect(forwarded).toHaveLength(1);
    expect(forwarded[0]?.args).toMatchObject({
      sessionUuid: ANDROID.sessionUuid,
      [DAEMON_BOUND_SESSION_PARAM]: IOS.sessionUuid,
    });
    await refused({}, "replay-lease-expired");
    expect(timer.getSleepHistory()).toEqual([]);
  });
}
