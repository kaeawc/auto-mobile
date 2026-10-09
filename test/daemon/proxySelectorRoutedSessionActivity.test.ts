import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { DaemonMcpProxy } from "../../src/daemon/daemonMcpProxy";
import { DaemonClient } from "../../src/daemon/client";
import {
  DAEMON_BOUND_SESSION_REPLAY_TTL_MS,
  DAEMON_OWNED_SESSIONS_PARAM,
  DAEMON_VERSION,
} from "../../src/daemon/constants";
import { withRoutedSessionMeta } from "../../src/server/routedSessionMeta";
import { SESSION_RELEASED_NOTIFICATION_METHOD } from "../../src/server/sessionReleaseBroadcast";
import { FakeDaemonManager } from "../fakes/FakeDaemonManager";
import { FakeDaemonClient } from "../fakes/FakeDaemonClient";
import { FakeIdGenerator } from "../fakes/FakeIdGenerator";
import { FakeTimer } from "../fakes/FakeTimer";
import { logger } from "../../src/utils/logger";

// #10692: a device driven through a `platform`/`deviceId` selector (no `sessionUuid`) is in use.
// Those calls are forwarded without a session UUID, so they never restarted the idle clock of the
// session they reached: the proxy fenced its own binding as replay-lease-expired (and stopped
// heartbeating a held session) one idle window after acquisition while the agent kept calling.
// Each call must restart the idle clock of the session it reached, and a session that only stops
// being called must still be released one idle window after its last call.
//
// #10974: the proxy no longer infers that session from the selector. The daemon echoes the session
// it routed an admitted control call to in the result's `_meta`, and the proxy credits exactly that
// one. The fake daemon below routes as the daemon does: a `deviceId` reaches the session holding
// that device, a `platform` the only session on that platform (none when ambiguous); reads and
// refused calls carry no echo.

const INTERVAL_MS = 2_000;
const IDLE_WINDOW_MS = DAEMON_BOUND_SESSION_REPLAY_TTL_MS;
const ANDROID = { sessionUuid: "android-session", deviceId: "emulator-5554", platform: "android" };
const IOS = { sessionUuid: "ios-session", deviceId: "SIM-UDID-1", platform: "ios" };
const PROVISIONED = {
  sessionUuid: "provisioned-session",
  deviceId: "emulator-5556",
  platform: "android",
};
/** A control call: a read (observe) is watching, never use (#10964). */
const CONTROL = "tapOn";
const CONTROL_ARGS = { action: "tap", text: "OK" };

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

/** provisionDevice's shape: the description nests under `device` beside a top-level `sessionId`. */
function provisionDeviceResult(device: typeof ANDROID) {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify({
          device: {
            name: "Pixel_Provisioned",
            platform: device.platform,
            runtime: { deviceId: device.deviceId },
          },
          sessionId: device.sessionUuid,
          source: "created",
        }),
      },
    ],
  };
}

describe("#10692: a selector-routed call keeps the session it reached in use", () => {
  let timer: FakeTimer;
  let client: FakeDaemonClient;
  let proxy: DaemonMcpProxy;
  let isAvailableSpy: ReturnType<typeof spyOn>;
  let warnSpy: ReturnType<typeof spyOn>;
  let infoSpy: ReturnType<typeof spyOn>;
  /** Sessions the fake daemon issued, in order. */
  let acquired: Array<typeof ANDROID>;
  /** The fake daemon refuses control calls (e.g. a non-holder on a held device). */
  let refuseControl: boolean;

  /** The session the daemon would route a call to and admit, as it resolves its selector. */
  function daemonRoutes(params: Record<string, unknown>): string | undefined {
    if (typeof params.sessionUuid === "string") {
      return params.sessionUuid;
    }
    const candidates = acquired.filter((device) =>
      typeof params.deviceId === "string"
        ? device.deviceId === params.deviceId
        : device.platform === params.platform,
    );
    return candidates.length === 1 ? candidates[0].sessionUuid : undefined;
  }

  function heartbeatSessions(): string[] {
    return client.callDaemonMethodCalls
      .filter((call) => call.method === "daemon/heartbeat")
      .map((call) => call.params.sessionId as string);
  }

  /** Session ids the keeper heartbeats over the next few ticks. */
  async function nextTicksHeartbeat(): Promise<string[]> {
    const before = heartbeatSessions().length;
    await timer.advanceTimeAsync(INTERVAL_MS * 3);
    return [...new Set(heartbeatSessions().slice(before))].sort();
  }

  /** Call `name` with `args` every `everyMs` for `forMs`; every call must succeed. */
  async function callEvery(
    name: string,
    args: Record<string, unknown>,
    everyMs: number,
    forMs: number,
  ): Promise<void> {
    const until = timer.now() + forMs;
    while (timer.now() + everyMs <= until) {
      await timer.advanceTimeAsync(everyMs);
      await proxy.callTool(name, args);
    }
  }

  beforeEach(() => {
    timer = new FakeTimer();
    acquired = [];
    refuseControl = false;
    client = new FakeDaemonClient({
      toolResultFor: (name, params) => {
        const device =
          name === "getAndroid"
            ? ANDROID
            : name === "getApple"
              ? IOS
              : name === "provisionDevice"
                ? PROVISIONED
                : undefined;
        if (device) {
          acquired.push(device);
          return device === PROVISIONED
            ? provisionDeviceResult(PROVISIONED)
            : deviceStartResult(device);
        }
        if (refuseControl && name !== "observe") {
          return {
            isError: true,
            content: [{ type: "text", text: "device_owned_by_other_session" }],
          };
        }
        return withRoutedSessionMeta(
          { content: [{ type: "text", text: "ok" }] },
          name === "observe" ? undefined : daemonRoutes(params),
        );
      },
    });
    isAvailableSpy = spyOn(DaemonClient, "isAvailable").mockResolvedValue(true);
    warnSpy = spyOn(logger, "warn").mockImplementation(() => {});
    infoSpy = spyOn(logger, "info").mockImplementation(() => {});
    const daemonManager = new FakeDaemonManager();
    daemonManager.statusResult = { ...daemonManager.statusResult, version: DAEMON_VERSION };
    proxy = new DaemonMcpProxy({
      clientFactory: () => client,
      daemonManager,
      autoStartDaemon: false,
      timer,
      idGenerator: new FakeIdGenerator(),
      heartbeatTimeoutMs: 4_000,
      heartbeatIntervalMs: INTERVAL_MS,
    });
  });

  afterEach(async () => {
    await proxy.close();
    isAvailableSpy.mockRestore();
    warnSpy.mockRestore();
    infoSpy.mockRestore();
  });

  for (const [form, args] of [
    ["no selector", {}],
    ["platform", { platform: "android" }],
    ["deviceId", { deviceId: ANDROID.deviceId }],
    ["explicit sessionUuid", { sessionUuid: ANDROID.sessionUuid }],
  ] as const) {
    test(`${form}: calls every half window keep the binding past several windows, then it is released one window after the last call`, async () => {
      await proxy.callTool("getAndroid", {});
      await callEvery(
        CONTROL,
        { ...CONTROL_ARGS, ...args },
        IDLE_WINDOW_MS / 2,
        IDLE_WINDOW_MS * 4,
      );
      const lastCallAt = timer.now();
      expect(await nextTicksHeartbeat()).toEqual([ANDROID.sessionUuid]);

      // Kept while in use: one tick short of a window after the last call, still heartbeating.
      await timer.advanceTimeAsync(lastCallAt + IDLE_WINDOW_MS - INTERVAL_MS * 4 - timer.now());
      expect(await nextTicksHeartbeat()).toEqual([ANDROID.sessionUuid]);

      // Released when idle: past the window, the next call is told to acquire a new device
      // (a read after that goes through without a session, #10971).
      await timer.advanceTimeAsync(INTERVAL_MS * 2);
      await expect(proxy.callTool(CONTROL, { ...CONTROL_ARGS, ...args })).rejects.toThrow(
        /released/,
      );
      expect(await nextTicksHeartbeat()).toEqual([]);
    });
  }

  test("a held device used through deviceId keeps heartbeating while the other device idles out", async () => {
    await proxy.callTool("getAndroid", {});
    await proxy.callTool("getApple", {});
    // Android is now held behind the iOS binding; only it is used, through its device id.
    await callEvery(
      CONTROL,
      { ...CONTROL_ARGS, deviceId: ANDROID.deviceId },
      IDLE_WINDOW_MS / 3,
      IDLE_WINDOW_MS * 3,
    );
    expect(client.callToolCalls.at(-1)?.params).toMatchObject({
      deviceId: ANDROID.deviceId,
      [DAEMON_OWNED_SESSIONS_PARAM]: expect.arrayContaining([ANDROID.sessionUuid]),
    });
    expect(client.callToolCalls.at(-1)?.params.sessionUuid).toBeUndefined();
    expect(await nextTicksHeartbeat()).toEqual([ANDROID.sessionUuid]);

    // A pause shorter than the window does not cost the held device.
    await timer.advanceTimeAsync(IDLE_WINDOW_MS - INTERVAL_MS * 6);
    expect(await nextTicksHeartbeat()).toEqual([ANDROID.sessionUuid]);

    // A pause past the window releases it too.
    await timer.advanceTimeAsync(INTERVAL_MS * 4);
    expect(await nextTicksHeartbeat()).toEqual([]);
  });

  test("a platform selector reaches only that platform's session", async () => {
    await proxy.callTool("getAndroid", {});
    await proxy.callTool("getApple", {});
    await callEvery(
      CONTROL,
      { ...CONTROL_ARGS, platform: "ios" },
      IDLE_WINDOW_MS / 3,
      IDLE_WINDOW_MS * 2,
    );
    expect(await nextTicksHeartbeat()).toEqual([IOS.sessionUuid]);
  });

  // #10971: read-only access never requires a session, in any situation.
  test("after an idle release, reads are forwarded without a session once the release was reported; control calls stay fenced", async () => {
    await proxy.callTool("getAndroid", {});
    await timer.advanceTimeAsync(IDLE_WINDOW_MS + INTERVAL_MS * 2);

    // The first call learns of the release.
    await expect(proxy.callTool("observe", { deviceId: ANDROID.deviceId })).rejects.toThrow(
      /released/,
    );
    const forwardedBefore = client.callToolCalls.length;
    for (const [name, args] of [
      ["observe", { deviceId: ANDROID.deviceId }],
      ["observe", { deviceId: IOS.deviceId }],
      ["listApps", {}],
    ] as const) {
      await expect(proxy.callTool(name, args)).resolves.toBeDefined();
      const forwarded = client.callToolCalls.at(-1)!;
      expect(forwarded.toolName).toBe(name);
      expect(forwarded.params.sessionUuid).toBeUndefined();
      expect(forwarded.params[DAEMON_OWNED_SESSIONS_PARAM]).toBeUndefined();
    }
    expect(client.callToolCalls.length).toBe(forwardedBefore + 3);

    // Control keeps the fence and the reacquire guidance, every time.
    for (let attempt = 0; attempt < 2; attempt++) {
      await expect(
        proxy.callTool(CONTROL, { ...CONTROL_ARGS, deviceId: ANDROID.deviceId }),
      ).rejects.toThrow(/Call getAndroid or getApple/);
    }
    expect(client.callToolCalls.length).toBe(forwardedBefore + 3);
  });

  describe("#10974: the proxy credits exactly the session the daemon echoes", () => {
    test("P6: a read naming a released device's serial credits nothing, not the only live session", async () => {
      await proxy.callTool("getAndroid", {});
      await proxy.callTool("getApple", {});
      client.emitNotification(SESSION_RELEASED_NOTIFICATION_METHOD, ANDROID.sessionUuid, "idle");
      acquired = acquired.filter((device) => device !== ANDROID);
      const acquiredAt = timer.now();
      await callEvery(
        "observe",
        { deviceId: ANDROID.deviceId },
        IDLE_WINDOW_MS / 4,
        IDLE_WINDOW_MS - INTERVAL_MS,
      );
      // Another device's read never kept iOS in use: it idles out one window after acquisition.
      await timer.advanceTimeAsync(acquiredAt + IDLE_WINDOW_MS + INTERVAL_MS - timer.now());
      expect(await nextTicksHeartbeat()).toEqual([]);
    });

    test("a serial the proxy never recorded credits the session the daemon routed it to", async () => {
      await proxy.callTool("getAndroid", {});
      // The same device came back on another serial; the daemon matches it by stable identity.
      acquired = [{ ...ANDROID, deviceId: "emulator-5560" }];
      await callEvery(
        CONTROL,
        { ...CONTROL_ARGS, deviceId: "emulator-5560" },
        IDLE_WINDOW_MS / 2,
        IDLE_WINDOW_MS * 3,
      );
      expect(await nextTicksHeartbeat()).toEqual([ANDROID.sessionUuid]);
    });

    test("an ambiguous platform selector credits neither same-platform session", async () => {
      await proxy.callTool("getAndroid", {});
      await proxy.callTool("provisionDevice", {});
      await callEvery(
        CONTROL,
        { ...CONTROL_ARGS, platform: "android" },
        IDLE_WINDOW_MS / 3,
        IDLE_WINDOW_MS * 2,
      );
      expect(await nextTicksHeartbeat()).toEqual([]);
    });

    test("a call the daemon refused credits nothing", async () => {
      await proxy.callTool("getAndroid", {});
      await proxy.callTool("getApple", {});
      refuseControl = true;
      await callEvery(
        CONTROL,
        { ...CONTROL_ARGS, deviceId: ANDROID.deviceId },
        IDLE_WINDOW_MS / 3,
        IDLE_WINDOW_MS * 2,
      );
      expect(await nextTicksHeartbeat()).toEqual([]);
    });
  });

  // #10821: provisionDevice nests the description under `device`, so the proxy never learned the
  // provisioned session's platform or device id and no selector-routed call ever credited it.
  for (const [form, args] of [
    ["deviceId", { deviceId: PROVISIONED.deviceId }],
    ["platform", { platform: "android" }],
  ] as const) {
    test(`#10821 ${form}: a provisionDevice session driven by selector keeps heartbeating beside a second session`, async () => {
      await proxy.callTool("provisionDevice", {});
      await proxy.callTool("getApple", {});
      await callEvery(
        CONTROL,
        { ...CONTROL_ARGS, ...args },
        IDLE_WINDOW_MS / 3,
        IDLE_WINDOW_MS * 3,
      );
      expect(await nextTicksHeartbeat()).toEqual([PROVISIONED.sessionUuid]);

      // A pause past the window still releases it once the calls stop.
      await timer.advanceTimeAsync(IDLE_WINDOW_MS);
      expect(await nextTicksHeartbeat()).toEqual([]);
    });
  }
});
