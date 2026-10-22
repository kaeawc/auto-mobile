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
    expect(client["ctrlProxyForwardLease"]).toBeInstanceOf(NoOpCtrlProxyForwardLease);
    expect(client["forwardClientProbe"]).toBeInstanceOf(NoForwardClientConnectionProbe);
    expect(client["loggerInstance"]).toBe(logger);
    expect(client["transientObserver"]).toBe(false);
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
    expect(client["timer"]).toBe(timer);
    expect(client["webSocketFactory"]).toBe(deps.webSocketFactory);
    expect(client["loggerInstance"]).toBe(deps.logger);
    expect(client["certificateFileSystem"]).toBe(deps.certificateFileSystem);
    expect(client["ctrlProxyForwardLease"]).toBe(deps.ctrlProxyForwardLease);
    expect(client["serviceManagerFactory"]).toBe(deps.serviceManagerFactory);
    expect(client["idGenerator"]).toBe(deps.idGenerator);
    expect(client["screenshotBackoffScheduler"]).toBe(screenshotBackoffScheduler);
    expect(client["forwardClientProbe"]).toBeInstanceOf(NoForwardClientConnectionProbe);
    expect(client["transientObserver"]).toBe(true);
    expect(client.connectionTestHooks.autoReconnectEnabled).toBe(false);
    expect(client["portAllocationId"]).toBe("client-deps:observer:observer-id");
  });

  test("options without a websocket factory retain the injected timer", () => {
    const timer = new FakeTimer();
    const client = AndroidCtrlProxyClient.createForTesting(device, new FakeAdbExecutor(), {
      timer,
    });
    clients.push(client);
    expect(client["timer"]).toBe(timer);
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
    expect(client["ctrlProxyForwardLease"]).toBeInstanceOf(FileCtrlProxyForwardLease);
  });
});
