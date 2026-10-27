import { afterEach, describe, expect, test } from "bun:test";
import {
  AndroidCtrlProxyClient,
  type AndroidCtrlProxyClientDeps,
} from "../../../../src/features/observe/android/AndroidCtrlProxyClient";
import { FileCtrlProxyForwardLease } from "../../../../src/features/observe/android/CtrlProxyForwardLease";
import { NoOpCtrlProxyForwardLease } from "../../../../src/features/observe/android/NoOpCtrlProxyForwardLease";
import { NoForwardClientConnectionProbe } from "../../../../src/features/observe/android/NoForwardClientConnectionProbe";
import { AndroidCtrlProxyManager } from "../../../../src/ctrlProxy/CtrlProxyManager";
import { PortManager } from "../../../../src/utils/PortManager";
import { logger } from "../../../../src/utils/logger";
import { FakeAdbExecutor } from "../../../fakes/FakeAdbExecutor";
import { FakeIdGenerator } from "../../../fakes/FakeIdGenerator";
import { FakeLogger } from "../../../fakes/FakeLogger";
import { FakeScreenshotBackoffScheduler } from "../../../fakes/FakeScreenshotBackoffScheduler";
import { FakeTimer } from "../../../fakes/FakeTimer";
import { FakeWebSocket } from "../../../fakes/FakeWebSocket";

describe("AndroidCtrlProxyClient dependency options", () => {
  const device = { deviceId: "client-deps", platform: "android" as const, name: "Android" };
  const clients: AndroidCtrlProxyClient[] = [];

  afterEach(async () => {
    for (const client of clients.splice(0)) {
      await client.close();
    }
    AndroidCtrlProxyManager.resetInstances();
    PortManager.reset();
  });

  test.each([undefined, {}])("omitted options preserve test-only defaults (%j)", (deps) => {
    const client = AndroidCtrlProxyClient.createForTesting(device, new FakeAdbExecutor(), deps);
    clients.push(client);
    expect(client.testHooks.injected().ctrlProxyForwardLease).toBeInstanceOf(
      NoOpCtrlProxyForwardLease,
    );
    expect(client.testHooks.injected().forwardClientProbe).toBeInstanceOf(
      NoForwardClientConnectionProbe,
    );
    expect(client.testHooks.injected().loggerInstance).toBe(logger);
    expect(client.testHooks.injected().transientObserver).toBe(false);
    expect(client.connectionTestHooks.autoReconnectEnabled).toBe(true);
  });

  test("options preserve late dependency slots and injected seams", () => {
    const timer = new FakeTimer();
    const deps = {
      webSocketFactory: (url) => new FakeWebSocket(url, "none", 0, timer),
      timer,
      logger: new FakeLogger(),
      certificateFileSystem: { stat: async () => ({ size: 1, isFile: () => true }) },
      ctrlProxyForwardLease: new NoOpCtrlProxyForwardLease(),
      serviceManagerFactory: () => ({
        isAccessibilityServiceHealthy: async () => true,
        setup: async () => ({ success: true, message: "ready" }),
      }),
      idGenerator: new FakeIdGenerator(["observer-id"]),
      transientObserver: true,
    } satisfies AndroidCtrlProxyClientDeps;
    const screenshotBackoffScheduler = new FakeScreenshotBackoffScheduler();
    const adb = new FakeAdbExecutor();
    const client = AndroidCtrlProxyClient.createForTesting(device, adb, {
      ...deps,
      screenshotBackoffScheduler,
    });
    clients.push(client);
    expect(client.testHooks.injected().timer).toBe(timer);
    expect(client.testHooks.injected().webSocketFactory).toBe(deps.webSocketFactory);
    expect(client.testHooks.injected().loggerInstance).toBe(deps.logger);
    expect(client.testHooks.injected().certificateFileSystem).toBe(deps.certificateFileSystem);
    expect(client.testHooks.injected().ctrlProxyForwardLease).toBe(deps.ctrlProxyForwardLease);
    expect(client.testHooks.injected().serviceManagerFactory).toBe(deps.serviceManagerFactory);
    expect(client.testHooks.injected().idGenerator).toBe(deps.idGenerator);
    expect(client.testHooks.injected().screenshotBackoffScheduler).toBe(screenshotBackoffScheduler);
    expect(client.testHooks.injected().forwardClientProbe).toBeInstanceOf(
      NoForwardClientConnectionProbe,
    );
    expect(client.testHooks.injected().transientObserver).toBe(true);
    expect(client.connectionTestHooks.autoReconnectEnabled).toBe(false);
    expect(client.testHooks.injected().portAllocationId).toBe("client-deps:observer:observer-id");
  });

  test("options without a websocket factory retain the injected timer", () => {
    const timer = new FakeTimer();
    const client = AndroidCtrlProxyClient.createForTesting(device, new FakeAdbExecutor(), {
      timer,
    });
    clients.push(client);
    expect(client.testHooks.injected().timer).toBe(timer);
  });

  test("the file-lease factory retains the production lease default", () => {
    const timer = new FakeTimer();
    const client = AndroidCtrlProxyClient.createWithFileForwardLeaseForTesting(
      device,
      new FakeAdbExecutor(),
      (url) => new FakeWebSocket(url, "none", 0, timer),
      timer,
    );
    clients.push(client);
    expect(client.testHooks.injected().ctrlProxyForwardLease).toBeInstanceOf(
      FileCtrlProxyForwardLease,
    );
  });
});
