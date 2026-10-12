import { withProxyOwnerToken } from "../helpers/proxyOwnerToken";
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import {
  DaemonBoundSessionExpiredError,
  DaemonConnectionSessionReleasedError,
  DaemonAmbiguousSessionSelectorError,
  DaemonMcpProxy,
} from "../../src/daemon/daemonMcpProxy";
import { DaemonClient } from "../../src/daemon/client";
import {
  DAEMON_BOUND_SESSION_PARAM,
  DAEMON_BOUND_SESSION_REPLAY_TTL_MS,
  DAEMON_HEARTBEAT_METHOD,
  DAEMON_OWNED_SESSIONS_PARAM,
  DAEMON_TOKEN_OWNED_SESSIONS_METHOD,
  DAEMON_VERSION,
} from "../../src/daemon/constants";
import { SESSION_RELEASED_NOTIFICATION_METHOD } from "../../src/server/sessionReleaseBroadcast";
import { withRoutedSessionMeta } from "../../src/server/routedSessionMeta";
import { getStaticToolDefinitions } from "../../src/daemon/staticToolDefinitions";
import { logger } from "../../src/utils/logger";
import { FakeDaemonClient } from "../fakes/FakeDaemonClient";
import { FakeDaemonManager } from "../fakes/FakeDaemonManager";
import { FakeIdGenerator } from "../fakes/FakeIdGenerator";
import { FakeTimer } from "../fakes/FakeTimer";
import { drainMicrotasks } from "../helpers/fakeTimerStepping";

interface AcquiredDevice {
  sessionUuid: string;
  deviceId: string;
  platform?: "android" | "ios";
}

const ANDROID: AcquiredDevice = {
  sessionUuid: "android-session",
  deviceId: "emulator-5554",
  platform: "android",
};
const IOS: AcquiredDevice = {
  sessionUuid: "ios-session",
  deviceId: "SIM-UDID-1",
  platform: "ios",
};

describe("#11714: an unambiguous platform-only call uses its connection's default session", () => {
  let proxy: DaemonMcpProxy;
  let client: FakeDaemonClient;
  let timer: FakeTimer;
  let acquisitions: AcquiredDevice[];
  let daemonMethodResults: Map<string, unknown>;
  let forwarded: Array<{ name: string; params: Record<string, unknown> }>;
  let spies: Array<ReturnType<typeof spyOn>>;

  beforeEach(() => {
    timer = new FakeTimer();
    acquisitions = [];
    daemonMethodResults = new Map();
    forwarded = [];
    spies = [
      spyOn(DaemonClient, "isAvailable").mockResolvedValue(true),
      spyOn(logger, "warn").mockImplementation(() => {}),
      spyOn(logger, "info").mockImplementation(() => {}),
    ];
    client = new FakeDaemonClient({
      daemonMethodResults,
      onCallTool: (name, params) => {
        // FakeDaemonClient's built-in recording strips the bound-session marker.
        forwarded.push({ name, params: { ...params } });
      },
      toolResultFor: (name, params) => {
        if (["getAndroid", "getApple", "startDevice", "provisionDevice"].includes(name)) {
          const device = acquisitions.shift()!;
          const description = {
            platform: device.platform,
            runtime: { deviceId: device.deviceId, session: { sessionUuid: device.sessionUuid } },
          };
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(
                  name === "provisionDevice"
                    ? { sessionId: device.sessionUuid, device: description }
                    : description,
                ),
              },
            ],
          };
        }
        return withRoutedSessionMeta(
          { content: [{ type: "text", text: "ok" }] },
          typeof params.sessionUuid === "string" ? params.sessionUuid : undefined,
        );
      },
    });
    const daemonManager = new FakeDaemonManager();
    daemonManager.statusResult = { ...daemonManager.statusResult, version: DAEMON_VERSION };
    proxy = new DaemonMcpProxy({
      livenessOwnerToken: "stable-owner-token",
      clientFactory: () => client,
      daemonManager,
      autoStartDaemon: false,
      timer,
      idGenerator: new FakeIdGenerator(),
      heartbeatIntervalMs: 2_000,
      heartbeatTimeoutMs: 10_000,
    });
  });

  afterEach(async () => {
    await proxy.close();
    for (const spy of spies) {
      spy.mockRestore();
    }
  });

  async function acquire(name: string, device: AcquiredDevice): Promise<void> {
    acquisitions.push(device);
    await proxy.callTool(name, {});
  }

  function lastParams(): Record<string, unknown> {
    return forwarded.at(-1)!.params;
  }

  async function expectDefaultRoute(device: AcquiredDevice): Promise<void> {
    await proxy.callTool("homeScreen", {});
    const untargeted = lastParams();
    await proxy.callTool("homeScreen", { platform: device.platform });
    expect(lastParams()).toEqual({ ...untargeted, platform: device.platform });
    expect(lastParams()).toMatchObject({
      sessionUuid: device.sessionUuid,
      [DAEMON_BOUND_SESSION_PARAM]: device.sessionUuid,
      platform: device.platform,
    });
    expect(lastParams()).not.toHaveProperty(DAEMON_OWNED_SESSIONS_PARAM);
  }

  test("1: getAndroid default is injected for platform android", async () => {
    await acquire("getAndroid", ANDROID);
    await expectDefaultRoute(ANDROID);
  });

  test("2: getApple default is injected for platform ios", async () => {
    await acquire("getApple", IOS);
    await expectDefaultRoute(IOS);
  });

  test("3: provisionDevice's nested description supplies the default platform", async () => {
    await acquire("provisionDevice", ANDROID);
    await expectDefaultRoute(ANDROID);
  });

  test("4 PIN: a contradictory platform is still forwarded for the daemon to decide", async () => {
    await acquire("getAndroid", ANDROID);
    await proxy.callTool("homeScreen", { platform: "ios" });
    expect(lastParams()).toMatchObject({
      platform: "ios",
      [DAEMON_OWNED_SESSIONS_PARAM]: [ANDROID.sessionUuid],
    });
    expect(lastParams()).not.toHaveProperty("sessionUuid");
    expect(lastParams()).not.toHaveProperty(DAEMON_BOUND_SESSION_PARAM);
  });

  test("5 PIN: two owned android sessions make a platform selector ambiguous", async () => {
    await acquire("getAndroid", ANDROID);
    const second = { ...ANDROID, sessionUuid: "second-android", deviceId: "emulator-5556" };
    await acquire("getAndroid", second);
    const before = forwarded.length;
    const refusal = await proxy.callTool("homeScreen", { platform: "android" }).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(refusal).toBeInstanceOf(DaemonAmbiguousSessionSelectorError);
    expect(refusal).toMatchObject({
      name: "DaemonAmbiguousSessionSelectorError",
      platform: "android",
      candidates: [
        { sessionUuid: second.sessionUuid, deviceId: second.deviceId },
        { sessionUuid: ANDROID.sessionUuid, deviceId: ANDROID.deviceId },
      ],
      message:
        "Platform 'android' alone matches 2 device sessions this MCP connection holds: " +
        "second-android (device 'emulator-5556'), android-session (device 'emulator-5554'). " +
        "Name one with sessionUuid or deviceId.",
    });
    expect(forwarded.length).toBe(before);
  });

  test("6: ios default is injected beside an older owned android session", async () => {
    await acquire("getAndroid", ANDROID);
    await acquire("getApple", IOS);
    await expectDefaultRoute(IOS);
  });

  for (const args of [
    { platform: "android", deviceId: ANDROID.deviceId },
    { platform: "android", sessionUuid: ANDROID.sessionUuid },
    { platform: "android", device: "A" },
  ]) {
    test(`two android sessions preserve the named route ${JSON.stringify(args)}`, async () => {
      await acquire("getAndroid", ANDROID);
      const second = { ...ANDROID, sessionUuid: "second-android", deviceId: "emulator-5556" };
      await acquire("getAndroid", second);
      const before = forwarded.length;
      await proxy.callTool("homeScreen", args);
      expect(forwarded.length).toBe(before + 1);
      expect(lastParams()).toMatchObject(args);
      if (!("device" in args)) {
        expect(lastParams()).toHaveProperty(DAEMON_OWNED_SESSIONS_PARAM, [
          second.sessionUuid,
          ANDROID.sessionUuid,
        ]);
      }
      if ("deviceId" in args) {
        expect(lastParams()).not.toHaveProperty("sessionUuid");
        expect(lastParams()).not.toHaveProperty(DAEMON_BOUND_SESSION_PARAM);
      } else {
        expect(lastParams()).toMatchObject({
          sessionUuid: "sessionUuid" in args ? ANDROID.sessionUuid : second.sessionUuid,
          [DAEMON_BOUND_SESSION_PARAM]: second.sessionUuid,
        });
      }
    });
  }

  for (const name of ["observe", "setActiveDevice"]) {
    test(`two android sessions leave ${name}'s platform selector open`, async () => {
      await acquire("getAndroid", ANDROID);
      const second = { ...ANDROID, sessionUuid: "second-android", deviceId: "emulator-5556" };
      await acquire("getAndroid", second);
      if (name === "observe") {
        const definition = getStaticToolDefinitions().find((tool) => tool.name === name);
        expect(definition?._meta?.["automobile/deviceReadOnly"]).toBe(true);
      }
      const before = forwarded.length;
      await proxy.callTool(name, { platform: "android" });
      expect(forwarded.length).toBe(before + 1);
      expect(lastParams()).toMatchObject({
        platform: "android",
        [DAEMON_OWNED_SESSIONS_PARAM]: [second.sessionUuid, ANDROID.sessionUuid],
      });
      expect(lastParams()).not.toHaveProperty("sessionUuid");
      expect(lastParams()).not.toHaveProperty(DAEMON_BOUND_SESSION_PARAM);
    });
  }

  test("two android sessions beside ios refuse only android and omit unknown platforms", async () => {
    daemonMethodResults.set(DAEMON_TOKEN_OWNED_SESSIONS_METHOD, {
      sessions: [
        { sessionId: "unknown-platform", deviceId: "unknown-device", lastUsedAt: timer.now() },
      ],
    });
    await acquire("getAndroid", ANDROID);
    const second = { ...ANDROID, sessionUuid: "second-android", deviceId: "emulator-5556" };
    await acquire("getAndroid", second);
    await acquire("getApple", IOS);
    await proxy.callTool("homeScreen", { platform: "ios" });
    expect(lastParams()).toMatchObject({
      platform: "ios",
      [DAEMON_OWNED_SESSIONS_PARAM]: [
        IOS.sessionUuid,
        "unknown-platform",
        ANDROID.sessionUuid,
        second.sessionUuid,
      ],
    });
    expect(lastParams()).not.toHaveProperty("sessionUuid");
    const before = forwarded.length;
    await expect(proxy.callTool("homeScreen", { platform: "android" })).rejects.toMatchObject({
      name: "DaemonAmbiguousSessionSelectorError",
      candidates: [
        { sessionUuid: ANDROID.sessionUuid, deviceId: ANDROID.deviceId },
        { sessionUuid: second.sessionUuid, deviceId: second.deviceId },
      ],
    });
    expect(forwarded.length).toBe(before);
  });

  test("a sibling release removes ambiguity, while a default release preserves the fence", async () => {
    await acquire("getAndroid", ANDROID);
    const second = { ...ANDROID, sessionUuid: "second-android", deviceId: "emulator-5556" };
    await acquire("getAndroid", second);
    client.emitNotification(SESSION_RELEASED_NOTIFICATION_METHOD, ANDROID.sessionUuid, "idle");
    await expectDefaultRoute(second);
    await acquire("getAndroid", ANDROID);
    client.emitNotification(SESSION_RELEASED_NOTIFICATION_METHOD, ANDROID.sessionUuid, "idle");
    const before = forwarded.length;
    await expect(proxy.callTool("homeScreen", { platform: "android" })).rejects.toBeInstanceOf(
      DaemonConnectionSessionReleasedError,
    );
    expect(forwarded.length).toBe(before);
  });

  test("refused platform selectors refresh neither replay lease nor heartbeat activity", async () => {
    await acquire("getAndroid", ANDROID);
    await acquire("getAndroid", {
      ...ANDROID,
      sessionUuid: "second-android",
      deviceId: "emulator-5556",
    });
    const before = forwarded.length;
    const methodsBefore = client.callDaemonMethodCalls.length;
    timer.setCurrentTime(DAEMON_BOUND_SESSION_REPLAY_TTL_MS / 2);
    await expect(proxy.callTool("homeScreen", { platform: "android" })).rejects.toBeInstanceOf(
      DaemonAmbiguousSessionSelectorError,
    );
    expect(client.callDaemonMethodCalls.length).toBe(methodsBefore);
    timer.setCurrentTime(DAEMON_BOUND_SESSION_REPLAY_TTL_MS + 1);
    await expect(proxy.callTool("homeScreen", { platform: "android" })).rejects.toMatchObject({
      name: "DaemonConnectionSessionReleasedError",
      reason: "replay-lease-expired",
    });
    expect(forwarded.length).toBe(before);
  });

  test("token resume learns the bound session's missing platform on reconnect", async () => {
    await acquire("getAndroid", { ...ANDROID, platform: undefined });
    daemonMethodResults.set(DAEMON_TOKEN_OWNED_SESSIONS_METHOD, {
      sessions: [
        {
          sessionId: ANDROID.sessionUuid,
          deviceId: ANDROID.deviceId,
          platform: "android",
          lastUsedAt: timer.now(),
        },
      ],
    });
    client.emitConnectionClosed();
    await proxy.ensureConnected();
    await expectDefaultRoute(ANDROID);
  });

  test("a managed binding keeps platform-only control on its default beside a same-platform sibling", async () => {
    daemonMethodResults.set(DAEMON_TOKEN_OWNED_SESSIONS_METHOD, {
      sessions: [
        {
          sessionId: "managed-1",
          deviceId: "emulator-5554",
          platform: "android",
          lastUsedAt: timer.now(),
        },
        {
          sessionId: "sibling-2",
          deviceId: "emulator-5556",
          platform: "android",
          lastUsedAt: timer.now(),
        },
      ],
    });
    await proxy.holdManagedExecutionSession("managed-1");
    expect(client.callDaemonMethodCalls).toContainEqual({
      method: DAEMON_TOKEN_OWNED_SESSIONS_METHOD,
      params: { livenessOwnerToken: "stable-owner-token" },
    });
    await proxy.callTool("homeScreen", { platform: "android" });
    expect(forwarded).toHaveLength(1);
    expect(forwarded[0]).toMatchObject({
      name: "homeScreen",
      params: { platform: "android", sessionUuid: "managed-1" },
    });
  });

  test("6: the older android platform uses its held session beside the ios default", async () => {
    await acquire("getAndroid", ANDROID);
    await acquire("getApple", IOS);
    await proxy.callTool("homeScreen", { platform: "android" });
    expect(lastParams()).toMatchObject({
      platform: "android",
      sessionUuid: ANDROID.sessionUuid,
      [DAEMON_BOUND_SESSION_PARAM]: IOS.sessionUuid,
      [DAEMON_OWNED_SESSIONS_PARAM]: [IOS.sessionUuid, ANDROID.sessionUuid],
    });
  });

  for (const name of ["homeScreen", "observe"]) {
    for (const flipDefault of [false, true]) {
      test(`${name} routes each own platform with ${flipDefault ? "android" : "ios"} default`, async () => {
        await acquire("getAndroid", ANDROID);
        await acquire("getApple", IOS);
        if (flipDefault) {
          const original = client.callTool.bind(client);
          spies.push(
            spyOn(client, "callTool").mockImplementation(async (...args) => {
              if (args[0] !== "setActiveDevice") {
                return original(...args);
              }
              forwarded.push({ name: args[0], params: { ...args[1] } });
              return { content: [{ type: "text", text: JSON.stringify(ANDROID) }] };
            }),
          );
          await proxy.callTool("setActiveDevice", { platform: "android" });
          expect(lastParams()).not.toHaveProperty("sessionUuid");
        }
        const bound = flipDefault ? ANDROID : IOS;
        const sibling = flipDefault ? IOS : ANDROID;
        const args = { platform: sibling.platform };
        await proxy.callTool(name, { ...args, sessionUuid: sibling.sessionUuid });
        const explicit = lastParams();
        await proxy.callTool(name, args);
        expect(lastParams()).toEqual(explicit);
        expect(lastParams()).toMatchObject({
          sessionUuid: sibling.sessionUuid,
          [DAEMON_BOUND_SESSION_PARAM]: bound.sessionUuid,
          [DAEMON_OWNED_SESSIONS_PARAM]: [bound.sessionUuid, sibling.sessionUuid],
        });
        await proxy.callTool(name, {});
        const untargeted = lastParams();
        await proxy.callTool(name, { platform: bound.platform });
        expect(lastParams()).toEqual({ ...untargeted, platform: bound.platform });
        expect(lastParams()).toMatchObject({
          sessionUuid: bound.sessionUuid,
          [DAEMON_BOUND_SESSION_PARAM]: bound.sessionUuid,
        });
        expect(lastParams()).not.toHaveProperty(DAEMON_OWNED_SESSIONS_PARAM);
        await proxy.callTool("homeScreen", {});
        expect(lastParams().sessionUuid).toBe(bound.sessionUuid);
      });
    }
  }

  for (const iosDefault of [false, true]) {
    test(`${iosDefault ? "PIN: " : ""}three known sessions select ios and keep android ambiguity with ${iosDefault ? "ios" : "android"} default`, async () => {
      const second = { ...ANDROID, sessionUuid: "second-android", deviceId: "emulator-5556" };
      await acquire("getAndroid", ANDROID);
      await acquire(iosDefault ? "getAndroid" : "getApple", iosDefault ? second : IOS);
      await acquire(iosDefault ? "getApple" : "getAndroid", iosDefault ? IOS : second);
      const bound = iosDefault ? IOS : second;
      for (const name of ["homeScreen", "observe"]) {
        await proxy.callTool(name, { platform: "ios" });
        expect(lastParams()).toMatchObject({
          platform: "ios",
          sessionUuid: IOS.sessionUuid,
          [DAEMON_BOUND_SESSION_PARAM]: bound.sessionUuid,
        });
      }
      const before = forwarded.length;
      const refusal = await proxy.callTool("homeScreen", { platform: "android" }).then(
        () => undefined,
        (error: unknown) => error,
      );
      expect(refusal).toBeInstanceOf(DaemonAmbiguousSessionSelectorError);
      expect(refusal).toMatchObject({
        candidates: iosDefault
          ? [
              { sessionUuid: ANDROID.sessionUuid, deviceId: ANDROID.deviceId },
              { sessionUuid: second.sessionUuid, deviceId: second.deviceId },
            ]
          : [
              { sessionUuid: second.sessionUuid, deviceId: second.deviceId },
              { sessionUuid: ANDROID.sessionUuid, deviceId: ANDROID.deviceId },
            ],
      });
      expect(forwarded.length).toBe(before);
      // PIN: ambiguous read-only selectors remain open.
      await proxy.callTool("observe", { platform: "android" });
      expect(lastParams().platform).toBe("android");
      expect(lastParams()).not.toHaveProperty("sessionUuid");
      expect(lastParams()).not.toHaveProperty(DAEMON_BOUND_SESSION_PARAM);
    });
  }

  test("a released android sibling refuses platform control once and is no longer a platform candidate", async () => {
    await acquire("getAndroid", ANDROID);
    await acquire("getApple", IOS);
    client.emitNotification(SESSION_RELEASED_NOTIFICATION_METHOD, ANDROID.sessionUuid, "idle");
    const before = forwarded.length;
    const refusal = await proxy.callTool("homeScreen", { platform: "android" }).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(refusal).toBeInstanceOf(DaemonBoundSessionExpiredError);
    expect(refusal).toMatchObject({ sessionUuid: ANDROID.sessionUuid, reason: "idle" });
    expect(forwarded.length).toBe(before);
    await proxy.callTool("homeScreen", { platform: "android" });
    expect(forwarded.length).toBe(before + 1);
    expect(lastParams()).toMatchObject({
      platform: "android",
      [DAEMON_OWNED_SESSIONS_PARAM]: [IOS.sessionUuid],
    });
    expect(lastParams()).not.toHaveProperty("sessionUuid");
    expect(lastParams()).not.toHaveProperty(DAEMON_BOUND_SESSION_PARAM);
  });

  test("PIN: an unknown android sibling platform keeps android selector routing", async () => {
    await acquire("getAndroid", { ...ANDROID, platform: undefined });
    await acquire("getApple", IOS);
    await proxy.callTool("homeScreen", { platform: "android" });
    expect(lastParams()).toMatchObject({
      platform: "android",
      [DAEMON_OWNED_SESSIONS_PARAM]: [IOS.sessionUuid, ANDROID.sessionUuid],
    });
    expect(lastParams()).not.toHaveProperty("sessionUuid");
  });

  for (const release of ["notification", "replay-expiry"]) {
    test(`PIN: ${release} of the ios default is reported before android sibling routing`, async () => {
      await acquire("getAndroid", ANDROID);
      await acquire("getApple", IOS);
      if (release === "notification") {
        client.emitNotification(SESSION_RELEASED_NOTIFICATION_METHOD, IOS.sessionUuid, "idle");
      } else {
        timer.setCurrentTime(DAEMON_BOUND_SESSION_REPLAY_TTL_MS + 1);
      }
      const before = forwarded.length;
      await expect(proxy.callTool("homeScreen", { platform: "android" })).rejects.toBeInstanceOf(
        DaemonConnectionSessionReleasedError,
      );
      expect(forwarded.length).toBe(before);
    });
  }

  test("PIN: setActiveDevice's android selector stays implicit beside the ios default", async () => {
    await acquire("getAndroid", ANDROID);
    await acquire("getApple", IOS);
    await proxy.callTool("setActiveDevice", { platform: "android" });
    expect(lastParams()).toMatchObject({
      platform: "android",
      [DAEMON_OWNED_SESSIONS_PARAM]: [IOS.sessionUuid, ANDROID.sessionUuid],
    });
    expect(lastParams()).not.toHaveProperty("sessionUuid");
    expect(lastParams()).not.toHaveProperty(DAEMON_BOUND_SESSION_PARAM);
  });

  for (const platform of ["ios", "android", undefined] as const) {
    const label =
      platform === "ios"
        ? "a token-resumed ios session permits the android platform call to use its default"
        : `PIN: a token-resumed session with ${platform ?? "no"} platform keeps the android selector ambiguous`;
    test(label, async () => {
      const resumed = "token-resumed-session";
      daemonMethodResults.set(DAEMON_TOKEN_OWNED_SESSIONS_METHOD, {
        sessions: [
          {
            sessionId: resumed,
            deviceId: platform === "ios" ? IOS.deviceId : "emulator-5556",
            ...(platform === undefined ? {} : { platform }),
            lastUsedAt: timer.now(),
          },
        ],
      });
      await acquire("getAndroid", ANDROID);
      expect(client.callDaemonMethodCalls).toContainEqual({
        method: DAEMON_TOKEN_OWNED_SESSIONS_METHOD,
        params: { livenessOwnerToken: "stable-owner-token" },
      });
      expect(
        client.callDaemonMethodCalls.find(
          (call) => call.method === DAEMON_HEARTBEAT_METHOD && call.params.sessionId === resumed,
        )?.params,
      ).toMatchObject({ livenessOwnerToken: "stable-owner-token", claimLivenessOwnership: true });
      if (platform === "android") {
        const before = forwarded.length;
        await expect(proxy.callTool("tapOn", { platform: "android" })).rejects.toMatchObject({
          name: "DaemonAmbiguousSessionSelectorError",
          platform,
          candidates: [
            { sessionUuid: ANDROID.sessionUuid, deviceId: ANDROID.deviceId },
            { sessionUuid: resumed, deviceId: "emulator-5556" },
          ],
        });
        expect(forwarded.length).toBe(before);
        return;
      }
      await proxy.callTool("tapOn", { platform: "android" });
      expect(lastParams().platform).toBe("android");
      if (platform === "ios") {
        expect(lastParams()).toMatchObject({
          sessionUuid: ANDROID.sessionUuid,
          [DAEMON_BOUND_SESSION_PARAM]: ANDROID.sessionUuid,
        });
      } else {
        expect(lastParams()).toHaveProperty(DAEMON_OWNED_SESSIONS_PARAM, [
          ANDROID.sessionUuid,
          resumed,
        ]);
        expect(lastParams()).not.toHaveProperty("sessionUuid");
        expect(lastParams()).not.toHaveProperty(DAEMON_BOUND_SESSION_PARAM);
      }
    });
  }

  for (const args of [
    { deviceId: ANDROID.deviceId },
    { deviceId: ANDROID.deviceId, platform: "android" },
  ]) {
    test(`7 PIN: ${JSON.stringify(args)} stays a daemon selector`, async () => {
      await acquire("getAndroid", ANDROID);
      await proxy.callTool("homeScreen", args);
      expect(lastParams()).toMatchObject({
        ...args,
        [DAEMON_OWNED_SESSIONS_PARAM]: [ANDROID.sessionUuid],
      });
      expect(lastParams()).not.toHaveProperty("sessionUuid");
      expect(lastParams()).not.toHaveProperty(DAEMON_BOUND_SESSION_PARAM);
    });
  }

  test("8 PIN: setActiveDevice's platform selector stays implicit", async () => {
    await acquire("getAndroid", ANDROID);
    await proxy.callTool("setActiveDevice", { platform: "android" });
    expect(lastParams()).toMatchObject({
      platform: "android",
      [DAEMON_OWNED_SESSIONS_PARAM]: [ANDROID.sessionUuid],
    });
    expect(lastParams()).not.toHaveProperty("sessionUuid");
    expect(lastParams()).not.toHaveProperty(DAEMON_BOUND_SESSION_PARAM);
  });

  test("9 PIN: a released default refuses platform-only control like untargeted control", async () => {
    await acquire("getAndroid", ANDROID);
    client.emitNotification(SESSION_RELEASED_NOTIFICATION_METHOD, ANDROID.sessionUuid, "idle");
    const before = forwarded.length;
    for (const args of [{}, { platform: "android" }]) {
      let refusal: unknown;
      try {
        await proxy.callTool("homeScreen", args);
      } catch (error) {
        refusal = error;
      }
      expect(refusal).toBeInstanceOf(DaemonConnectionSessionReleasedError);
      expect(refusal).toMatchObject({
        reason: "idle",
        message:
          "This MCP connection has no active device session (the previous session was released: idle). " +
          "Call getAndroid or getApple to acquire a new device session.",
      });
    }
    expect(forwarded.length).toBe(before);
  });

  test("10 PIN: explicit sessionUuid with platform keeps its original route", async () => {
    await acquire("getAndroid", ANDROID);
    await acquire("getApple", IOS);
    await proxy.callTool("homeScreen", { sessionUuid: ANDROID.sessionUuid, platform: "ios" });
    expect(lastParams()).toMatchObject({
      sessionUuid: ANDROID.sessionUuid,
      platform: "ios",
      [DAEMON_BOUND_SESSION_PARAM]: IOS.sessionUuid,
      [DAEMON_OWNED_SESSIONS_PARAM]: [IOS.sessionUuid, ANDROID.sessionUuid],
    });
  });

  test("PIN: an unknown default platform keeps selector routing", async () => {
    await acquire("getAndroid", { ...ANDROID, platform: undefined });
    await proxy.callTool("homeScreen", { platform: "android" });
    expect(lastParams()).not.toHaveProperty("sessionUuid");
    expect(lastParams()).toHaveProperty(DAEMON_OWNED_SESSIONS_PARAM, [ANDROID.sessionUuid]);
  });

  test("PIN: another owned session of unknown platform makes the selector ambiguous", async () => {
    await acquire("getAndroid", { ...ANDROID, platform: undefined });
    await acquire("getApple", IOS);
    await proxy.callTool("homeScreen", { platform: "ios" });
    expect(lastParams()).not.toHaveProperty("sessionUuid");
    expect(lastParams()).toHaveProperty(DAEMON_OWNED_SESSIONS_PARAM, [
      IOS.sessionUuid,
      ANDROID.sessionUuid,
    ]);
  });

  test("a repeated acquisition learns the platform even when its session is already bound", async () => {
    await acquire("getAndroid", { ...ANDROID, platform: undefined });
    await acquire("getAndroid", ANDROID);
    await expectDefaultRoute(ANDROID);
  });

  test("A: replay-lease expiry then reacquisition injects the new android default", async () => {
    await acquire("getAndroid", ANDROID);
    // Model missed keeper ticks so the call itself discovers replay-lease expiry.
    timer.setCurrentTime(DAEMON_BOUND_SESSION_REPLAY_TTL_MS + 1);
    const before = forwarded.length;
    await expect(proxy.callTool("homeScreen", {})).rejects.toMatchObject({
      name: "DaemonConnectionSessionReleasedError",
      reason: "replay-lease-expired",
    });
    expect(forwarded.length).toBe(before);

    const second = { ...ANDROID, sessionUuid: "second-android", deviceId: "emulator-5556" };
    await acquire("getAndroid", second);
    await proxy.callTool("homeScreen", { platform: "android" });
    expect(lastParams()).toMatchObject({
      sessionUuid: second.sessionUuid,
      [DAEMON_BOUND_SESSION_PARAM]: second.sessionUuid,
      platform: "android",
    });
    expect(lastParams()).not.toHaveProperty(DAEMON_OWNED_SESSIONS_PARAM);
  });

  test("B: idle eviction of held android keeps the ios platform default injected", async () => {
    await acquire("getAndroid", ANDROID);
    await acquire("getApple", IOS);
    await expectDefaultRoute(IOS);
    const advance = (ms: number): Promise<void> =>
      timer.advanceTimeAsync(ms, () => drainMicrotasks(32));
    await advance(DAEMON_BOUND_SESSION_REPLAY_TTL_MS / 2);
    await proxy.callTool("homeScreen", {});
    await advance(DAEMON_BOUND_SESSION_REPLAY_TTL_MS / 2);

    const before = client.callDaemonMethodCalls.length;
    await advance(2_000);
    expect(
      client.callDaemonMethodCalls
        .slice(before)
        .filter((call) => call.method === "daemon/heartbeat")
        .map((call) => call.params.sessionId),
    ).toEqual([IOS.sessionUuid]);
    await proxy.callTool("homeScreen", { platform: "ios" });
    expect(lastParams()).toMatchObject({
      sessionUuid: IOS.sessionUuid,
      [DAEMON_BOUND_SESSION_PARAM]: IOS.sessionUuid,
      platform: "ios",
    });
    expect(lastParams()).not.toHaveProperty(DAEMON_OWNED_SESSIONS_PARAM);
  });

  test("C PIN: notified release then reacquisition injects the new android default", async () => {
    await acquire("getAndroid", ANDROID);
    client.emitNotification(SESSION_RELEASED_NOTIFICATION_METHOD, ANDROID.sessionUuid, "idle");
    const second = { ...ANDROID, sessionUuid: "second-android", deviceId: "emulator-5556" };
    await acquire("getAndroid", second);
    await expectDefaultRoute(second);
  });

  test("an expired ios default reports its release before a default-platform read beside an android sibling", async () => {
    await acquire("getAndroid", ANDROID);
    await acquire("getApple", IOS);
    timer.setCurrentTime(DAEMON_BOUND_SESSION_REPLAY_TTL_MS + 1);
    const before = forwarded.length;
    const refusal = await proxy.callTool("observe", { platform: "ios" }).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(refusal).toBeInstanceOf(DaemonConnectionSessionReleasedError);
    expect(refusal).toMatchObject({ reason: "replay-lease-expired" });
    expect(forwarded.length).toBe(before);
  });

  test("reacquisition after a released startup binding injects the new default for control and read", async () => {
    const daemonManager = new FakeDaemonManager();
    daemonManager.statusResult = { ...daemonManager.statusResult, version: DAEMON_VERSION };
    const startupProxy = new DaemonMcpProxy({
      initialSessionUuid: "startup-session",
      livenessOwnerToken: "stable-owner-token",
      clientFactory: () => client,
      daemonManager,
      autoStartDaemon: false,
      timer,
      idGenerator: new FakeIdGenerator(),
      heartbeatIntervalMs: 2_000,
      heartbeatTimeoutMs: 10_000,
    });
    try {
      await startupProxy.claimInitialSession();
      client.emitNotification(SESSION_RELEASED_NOTIFICATION_METHOD, "startup-session", "idle");
      acquisitions.push(ANDROID);
      await startupProxy.callTool("getAndroid", {});
      const before = forwarded.length;
      await startupProxy.callTool("homeScreen", { platform: "android" });
      await startupProxy.callTool("observe", { platform: "android" });
      expect(forwarded.slice(before)).toEqual([
        {
          name: "homeScreen",
          params: withProxyOwnerToken(
            {
              platform: "android",
              sessionUuid: ANDROID.sessionUuid,
              [DAEMON_BOUND_SESSION_PARAM]: ANDROID.sessionUuid,
            },
            "stable-owner-token",
          ),
        },
        {
          name: "observe",
          params: withProxyOwnerToken(
            {
              platform: "android",
              sessionUuid: ANDROID.sessionUuid,
              [DAEMON_BOUND_SESSION_PARAM]: ANDROID.sessionUuid,
            },
            "stable-owner-token",
          ),
        },
      ]);
    } finally {
      await startupProxy.close();
    }
  });

  test("PIN: an expired default leaves a sibling platform-only read sessionless", async () => {
    await acquire("getAndroid", ANDROID);
    await acquire("getApple", IOS);
    timer.setCurrentTime(DAEMON_BOUND_SESSION_REPLAY_TTL_MS + 1);
    const before = forwarded.length;
    await proxy.callTool("observe", { platform: "android" });
    expect(forwarded.length).toBe(before + 1);
    expect(lastParams()).toMatchObject({ platform: "android" });
    expect(lastParams()).not.toHaveProperty("sessionUuid");
    expect(lastParams()).not.toHaveProperty(DAEMON_BOUND_SESSION_PARAM);
  });

  test("PIN: a managed android binding keeps the ios selector on its default", async () => {
    daemonMethodResults.set(DAEMON_TOKEN_OWNED_SESSIONS_METHOD, {
      sessions: [
        {
          sessionId: ANDROID.sessionUuid,
          deviceId: ANDROID.deviceId,
          platform: "android",
          lastUsedAt: timer.now(),
        },
        {
          sessionId: IOS.sessionUuid,
          deviceId: IOS.deviceId,
          platform: "ios",
          lastUsedAt: timer.now(),
        },
      ],
    });
    await proxy.holdManagedExecutionSession(ANDROID.sessionUuid);
    for (const name of ["homeScreen", "observe"]) {
      await proxy.callTool(name, { platform: "ios" });
      expect(lastParams()).toEqual(
        withProxyOwnerToken(
          {
            platform: "ios",
            sessionUuid: ANDROID.sessionUuid,
            [DAEMON_BOUND_SESSION_PARAM]: ANDROID.sessionUuid,
          },
          "stable-owner-token",
        ),
      );
    }
    expect(forwarded).toHaveLength(2);
  });

  test("D PIN: an expired replay lease refuses a matching platform like untargeted control", async () => {
    await acquire("getAndroid", ANDROID);
    // The matching platform call must discover expiry, rather than bypass the replay fence.
    timer.setCurrentTime(DAEMON_BOUND_SESSION_REPLAY_TTL_MS + 1);
    const before = forwarded.length;
    const refusals: unknown[] = [];
    for (const args of [{ platform: "android" }, {}]) {
      let refusal: unknown;
      try {
        await proxy.callTool("homeScreen", args);
      } catch (error) {
        refusal = error;
      }
      expect(refusal).toBeInstanceOf(DaemonConnectionSessionReleasedError);
      expect(refusal).toMatchObject({ reason: "replay-lease-expired" });
      refusals.push(refusal);
    }
    expect(refusals[0]).toEqual(refusals[1]);
    expect(forwarded.length).toBe(before);
  });
});
