import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { DevicePool } from "../../src/daemon/devicePool";
import { SessionManager } from "../../src/daemon/sessionManager";
import { runWithAbortSignal } from "../../src/utils/AbortContext";
import { FakeDeviceManager } from "../fakes/FakeDeviceManager";
import { useSessionIdleWindowForSuite } from "../helpers/sessionIdleWindowEnv";
import { createBootedDevice, createDevicePoolSuite } from "../helpers/devicePoolSuite";

useSessionIdleWindowForSuite();

// #11817: DevicePool.bindOrReuseDeviceSession reads the ambient signal once; ExplicitDeviceBind
// hands it to SessionManager explicitly instead of reading getAbortSignal() itself.
describe("bindOrReuseDeviceSession caller signal (#11817)", () => {
  let devicePool: DevicePool;
  let sessionManager: SessionManager;
  let fakeDeviceManager: FakeDeviceManager;

  beforeEach(() => {
    ({ devicePool, sessionManager, fakeDeviceManager } = createDevicePoolSuite());
  });

  afterEach(() => {
    sessionManager.stopCleanupTimer();
  });

  test("passes the caller's signal to session creation", async () => {
    const device = createBootedDevice("sim-1", "ios", "iPhone 15");
    await devicePool.initializeWithDevices([device]);
    fakeDeviceManager.bootedDevices = [device];
    const seen: Array<AbortSignal | undefined> = [];
    const createSession = sessionManager.createSession.bind(sessionManager);
    sessionManager.createSession = ((...args: Parameters<SessionManager["createSession"]>) => {
      seen.push(args[3]?.signal);
      return createSession(...args);
    }) as SessionManager["createSession"];
    const controller = new AbortController();

    await runWithAbortSignal(controller.signal, () =>
      devicePool.bindOrReuseDeviceSession({
        sessionId: "session-1",
        deviceId: "sim-1",
        platform: "ios",
      }),
    );

    expect(seen).toEqual([controller.signal]);
  });
});
