import { describe, expect, test } from "bun:test";
import type WebSocket from "ws";
import {
  DeviceServiceClient,
  REAL_CTRL_PROXY_WEBSOCKET_OPT_IN_ENV,
  RealCtrlProxyWebSocketInTestError,
  assertUnitTestRealWebSocketAllowed,
  defaultWebSocketFactory,
  type WebSocketFactory,
} from "../../../src/features/observe/DeviceServiceClient";
import { daemonProcessEnvironment } from "../../../src/daemon/daemonOptionScopes";
import { ActionableError } from "../../../src/models/ActionableError";
import type { PerformanceTracker } from "../../../src/utils/PerformanceTracker";
import { FakeTimer } from "../../fakes/FakeTimer";
import { createInstantFailureWebSocketFactory } from "../../fakes/FakeWebSocket";
import { maskRealCtrlProxyWebSocketOptIn } from "../../helpers/maskRealCtrlProxyWebSocketOptIn";

const URL = "ws://127.0.0.1:8765/ws";

maskRealCtrlProxyWebSocketOptIn();

describe("real CtrlProxy WebSocket unit-test guard (#10470)", () => {
  test("the default factory refuses a real socket under bun test", () => {
    expect(process.env.NODE_ENV).toBe("test");
    expect(() => defaultWebSocketFactory(URL)).toThrow(RealCtrlProxyWebSocketInTestError);
    expect(() => defaultWebSocketFactory(URL)).toThrow(ActionableError);
    expect(() => defaultWebSocketFactory(URL)).toThrow(/requestTapCoordinates/);
  });

  test("the error names the URL and the opt-in", () => {
    expect(() => assertUnitTestRealWebSocketAllowed(URL, { NODE_ENV: "test" })).toThrow(
      new RegExp(`${URL}.*${REAL_CTRL_PROXY_WEBSOCKET_OPT_IN_ENV}=1`, "s"),
    );
  });

  test.each(["1", "true", " YES "])("an explicit opt-in (%p) allows the socket", (value) => {
    expect(() =>
      assertUnitTestRealWebSocketAllowed(URL, {
        NODE_ENV: "test",
        [REAL_CTRL_PROXY_WEBSOCKET_OPT_IN_ENV]: value,
      }),
    ).not.toThrow();
  });

  test.each(["", "0", "false"])("a falsy opt-in (%p) keeps the guard armed", (value) => {
    expect(() =>
      assertUnitTestRealWebSocketAllowed(URL, {
        NODE_ENV: "test",
        [REAL_CTRL_PROXY_WEBSOCKET_OPT_IN_ENV]: value,
      }),
    ).toThrow(ActionableError);
  });

  test.each([undefined, "production", "development"])(
    "outside a bun test context (NODE_ENV=%p) the guard is disarmed",
    (nodeEnv) => {
      expect(() => assertUnitTestRealWebSocketAllowed(URL, { NODE_ENV: nodeEnv })).not.toThrow();
    },
  );

  test.each(["/repo/src/foo.test.ts", "C:\\repo\\test\\bar.spec.tsx", "/repo/x.test.mjs"])(
    "the bun test runner process (entrypoint %p) is armed",
    (entrypoint) => {
      expect(() =>
        assertUnitTestRealWebSocketAllowed(URL, { NODE_ENV: "test" }, entrypoint),
      ).toThrow(RealCtrlProxyWebSocketInTestError);
    },
  );

  // An on-device integration test runs under bun test and spawns CLI/daemon
  // children that inherit NODE_ENV=test; those children must still dial the device.
  test.each(["/repo/dist/src/index.js", "/repo/src/index.ts", "/$bunfs/root/auto-mobile"])(
    "a spawned daemon/CLI child (entrypoint %p) with the inherited test env is not armed",
    (entrypoint) => {
      const daemonEnv = daemonProcessEnvironment({ NODE_ENV: "test" });
      expect(daemonEnv.NODE_ENV).toBe("test");
      expect(() => assertUnitTestRealWebSocketAllowed(URL, daemonEnv, entrypoint)).not.toThrow();
    },
  );
});

/** Minimal concrete client that counts the failed-connect funnel recovery hangs off. */
class GuardTestClient extends DeviceServiceClient {
  protected readonly logTag = "GuardTestClient";
  failedConnectCount = 0;

  constructor(timer: FakeTimer, factory: WebSocketFactory) {
    super(timer, factory, { maxConnectionAttempts: 3 });
  }

  protected onConnectAttemptFailed(): void {
    this.failedConnectCount++;
  }

  protected getWebSocketUrl(): string {
    return URL;
  }

  protected handleMessage(_data: WebSocket.Data): void {}

  protected onConnectionEstablished(): void {}

  protected onConnectionClosed(): void {}

  protected cancelScreenshotBackoff(): void {}

  protected async setupBeforeConnect(
    _perf: PerformanceTracker,
    _signal: AbortSignal,
  ): Promise<void> {}
}

describe("the guard is rethrown, never counted as a failed connect", () => {
  test("ensureConnected rejects with the guard error and never records a failure", async () => {
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const client = new GuardTestClient(timer, defaultWebSocketFactory);
    // Past maxConnectionAttempts: the guard must not slide into a silent cooldown.
    for (let i = 0; i < 5; i++) {
      await expect(client.ensureConnected()).rejects.toBeInstanceOf(
        RealCtrlProxyWebSocketInTestError,
      );
    }
    expect(client.failedConnectCount).toBe(0);
    expect(client.getLastConnectionFailureMessage()).toBeUndefined();
    expect(client.getReconnectStatus()).toBeNull();
    await client.close();
  });

  test("waitForConnection stops retrying and rethrows the guard error", async () => {
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    let dials = 0;
    const client = new GuardTestClient(timer, (url) => {
      dials++;
      return defaultWebSocketFactory(url);
    });
    await expect(client.waitForConnection(5, 10)).rejects.toBeInstanceOf(
      RealCtrlProxyWebSocketInTestError,
    );
    expect(dials).toBe(1);
    expect(client.failedConnectCount).toBe(0);
    await client.close();
  });

  test("an ordinary connect failure still counts toward recovery", async () => {
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const client = new GuardTestClient(timer, createInstantFailureWebSocketFactory(timer));
    for (let i = 0; i < 3; i++) {
      expect(await client.ensureConnected()).toBe(false);
    }
    expect(client.failedConnectCount).toBe(3);
    expect(client.getLastConnectionFailureMessage()).toBeDefined();
    await client.close();
  });
});
