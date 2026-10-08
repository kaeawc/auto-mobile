import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { DaemonMcpProxy } from "../../src/daemon/daemonMcpProxy";
import { DaemonClient } from "../../src/daemon/client";
import {
  DAEMON_BOUND_SESSION_REPLAY_TTL_MS,
  DAEMON_OWNED_SESSIONS_PARAM,
  DAEMON_VERSION,
} from "../../src/daemon/constants";
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

const INTERVAL_MS = 2_000;
const IDLE_WINDOW_MS = DAEMON_BOUND_SESSION_REPLAY_TTL_MS;
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

describe("#10692: a selector-routed call keeps the session it reached in use", () => {
  let timer: FakeTimer;
  let client: FakeDaemonClient;
  let proxy: DaemonMcpProxy;
  let isAvailableSpy: ReturnType<typeof spyOn>;
  let warnSpy: ReturnType<typeof spyOn>;
  let infoSpy: ReturnType<typeof spyOn>;

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
    client = new FakeDaemonClient({
      toolResultFor: (name) =>
        name === "getAndroid"
          ? deviceStartResult(ANDROID)
          : name === "getApple"
            ? deviceStartResult(IOS)
            : undefined,
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
      await callEvery("observe", args, IDLE_WINDOW_MS / 2, IDLE_WINDOW_MS * 4);
      const lastCallAt = timer.now();
      expect(await nextTicksHeartbeat()).toEqual([ANDROID.sessionUuid]);

      // Kept while in use: one tick short of a window after the last call, still heartbeating.
      await timer.advanceTimeAsync(lastCallAt + IDLE_WINDOW_MS - INTERVAL_MS * 4 - timer.now());
      expect(await nextTicksHeartbeat()).toEqual([ANDROID.sessionUuid]);

      // Released when idle: past the window, the next call is told to acquire a new device.
      await timer.advanceTimeAsync(INTERVAL_MS * 2);
      await expect(proxy.callTool("observe", args)).rejects.toThrow(/released/);
      expect(await nextTicksHeartbeat()).toEqual([]);
    });
  }

  test("a held device used through deviceId keeps heartbeating while the other device idles out", async () => {
    await proxy.callTool("getAndroid", {});
    await proxy.callTool("getApple", {});
    // Android is now held behind the iOS binding; only it is used, through its device id.
    await callEvery(
      "observe",
      { deviceId: ANDROID.deviceId },
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
    await callEvery("observe", { platform: "ios" }, IDLE_WINDOW_MS / 3, IDLE_WINDOW_MS * 2);
    expect(await nextTicksHeartbeat()).toEqual([IOS.sessionUuid]);
  });
});
