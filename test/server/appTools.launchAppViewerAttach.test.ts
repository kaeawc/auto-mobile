import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import type { BootedDevice, LaunchAppResult } from "../../src/models";
import {
  resetInstalledAppResourceRefresh,
  setInstalledAppResourceRefresh,
} from "../../src/server/appTools";
import { ToolRegistry } from "../../src/server/toolRegistry";
import { SessionReleaseBroadcaster } from "../../src/daemon/sessionReleaseBroadcast";
import type { SessionReleaseSnapshot } from "../../src/daemon/sessionManager";
import { getDaemonStreamDeviceLifecycleEmitter } from "../../src/daemon/streamDeviceLifecycleEvents";
import { PrototypeViewerConnections } from "../../src/features/prototype/ios/prototypeViewerAttach";
import { FakePrototypeAgentClient } from "../fakes/FakePrototypeAgentInjection";
import { FakePrototypeViewerAttacher } from "../fakes/FakePrototypeViewerAttacher";
import { FakeTimer } from "../fakes/FakeTimer";
import { logger } from "../../src/utils/logger";
import { isolateToolRegistry } from "../helpers/withTemporaryTool";
import { createAppToolsHarness } from "../helpers/appToolsHarness";

const appTools = createAppToolsHarness();

isolateToolRegistry();

const SIMULATOR: BootedDevice = {
  deviceId: "11111111-2222-3333-4444-555555555555",
  name: "iPhone",
  platform: "ios",
};
const APP = "com.example.viewer";
const RESULT: LaunchAppResult = { success: true, packageName: APP, pid: 1234 };

let attacher: FakePrototypeViewerAttacher;
let connections: PrototypeViewerConnections;
let timer: FakeTimer;

beforeEach(() => {
  ToolRegistry.clearTools();
  SessionReleaseBroadcaster.clearForTesting();
  setInstalledAppResourceRefresh({ invalidate: () => {}, notify: async () => {} });
  attacher = new FakePrototypeViewerAttacher();
  connections = new PrototypeViewerConnections();
  timer = new FakeTimer();
  appTools.configure("launchApp", {
    createLaunchApp: () => ({ execute: async () => RESULT }),
    prototypeViewerAttacher: attacher,
    prototypeViewerConnections: connections,
    timer,
  });
  appTools.configure("terminateApp", {
    createTerminateApp: () => ({ execute: async () => ({ success: true, packageName: APP }) }),
  });
});

afterEach(() => {
  connections.releaseDevice(SIMULATOR.deviceId);
  appTools.clear();
  SessionReleaseBroadcaster.clearForTesting();
  resetInstalledAppResourceRefresh();
});

function launch(device = SIMULATOR) {
  return ToolRegistry.getTool("launchApp")!.deviceAwareHandler!(device, { appId: APP });
}

function recordViewer(bundleId = APP) {
  const client = new FakePrototypeAgentClient();
  connections.record(SIMULATOR.deviceId, { bundleId, client });
  return client;
}

test("successful simulator launch attempts exactly one attach without adding response fields", async () => {
  const expected = await launch({ ...SIMULATOR, deviceId: "00008110-001A2B3C4D5E6F70" });
  const response = await launch();
  expect(attacher.calls).toEqual([{ device: SIMULATOR, bundleId: APP }]);
  expect(response).toEqual(expected);
});

test("attach rejection is swallowed and logged without leaking the error or changing the response", async () => {
  const expected = await launch();
  attacher.calls.length = 0;
  attacher.error = new Error("no endpoint file: secret-token");
  const debug = spyOn(logger, "debug").mockImplementation(() => {});
  try {
    expect(await launch()).toEqual(expected);
    expect(attacher.calls).toEqual([{ device: SIMULATOR, bundleId: APP }]);
    expect(debug.mock.calls).toContainEqual([
      "[AppTools] Optional prototype viewer attach was unavailable.",
    ]);
    expect(JSON.stringify(debug.mock.calls)).not.toContain("secret-token");
  } finally {
    debug.mockRestore();
  }
});

test("launch response waits for attach to settle", async () => {
  const pending = Promise.withResolvers<unknown>();
  attacher.pending = pending.promise;
  let settled = false;
  const response = launch().then((value) => {
    settled = true;
    return value;
  });
  try {
    await Promise.resolve();
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(attacher.calls).toHaveLength(1);
    pending.resolve(undefined);
    expect(await response).toBeDefined();
    expect(settled).toBe(true);
  } finally {
    pending.resolve(undefined);
  }
});

test("a hanging attach times out after three seconds and launch succeeds", async () => {
  const pending = Promise.withResolvers<unknown>();
  attacher.pending = pending.promise;
  const debug = spyOn(logger, "debug").mockImplementation(() => {});
  try {
    const response = launch();
    await Promise.resolve();
    await Promise.resolve();
    timer.advanceTime(3000);
    expect(await response).toBeDefined();
    expect(debug.mock.calls).toContainEqual([
      "[AppTools] Optional prototype viewer attach timed out.",
    ]);
  } finally {
    pending.resolve(undefined);
    debug.mockRestore();
  }
});

test("a synchronous attach throw cannot fail the successful launch", async () => {
  const expected = await launch();
  const attach = spyOn(attacher, "attach").mockImplementation(() => {
    throw new Error("attach failed");
  });
  try {
    expect(await launch()).toEqual(expected);
    expect(attach).toHaveBeenCalledTimes(1);
  } finally {
    attach.mockRestore();
  }
});

test.each([
  { ...SIMULATOR, platform: "android" },
  { ...SIMULATOR, deviceId: "00008110-001A2B3C4D5E6F70" },
])("$platform $deviceId launch skips viewer attach", async (device) => {
  await launch(device);
  expect(attacher.calls).toHaveLength(0);
});

test.each(["typed", "thrown"])("%s launch failure skips viewer attach", async (failure) => {
  appTools.configure("launchApp", {
    createLaunchApp: () => ({
      execute: async () => {
        if (failure === "thrown") {
          throw new Error("launch failed");
        }
        return { success: false, error: "launch failed", packageName: APP };
      },
    }),
  });
  await expect(launch()).rejects.toThrow("launch failed");
  expect(attacher.calls).toHaveLength(0);
});

test("successful termination releases and closes the matching viewer", async () => {
  const client = recordViewer();
  await ToolRegistry.getTool("terminateApp")!.deviceAwareHandler!(SIMULATOR, { appId: APP });
  expect(client.closeCount).toBe(1);
  expect(connections.get(SIMULATOR.deviceId)).toBeUndefined();
});

test("successful termination of another bundle leaves the viewer connected", async () => {
  const client = recordViewer("other");
  await ToolRegistry.getTool("terminateApp")!.deviceAwareHandler!(SIMULATOR, { appId: APP });
  expect(client.closeCount).toBe(0);
  expect(connections.get(SIMULATOR.deviceId)).toBe(client);
});

test("failed termination keeps the viewer connected", async () => {
  const client = recordViewer();
  appTools.configure("terminateApp", {
    createTerminateApp: () => ({
      execute: async () => ({ success: false, error: "failed", packageName: APP }),
    }),
  });
  await expect(
    ToolRegistry.getTool("terminateApp")!.deviceAwareHandler!(SIMULATOR, { appId: APP }),
  ).rejects.toThrow("failed");
  expect(client.closeCount).toBe(0);
  expect(connections.get(SIMULATOR.deviceId)).toBe(client);
});

test("session release closes the viewer", () => {
  const client = recordViewer();
  SessionReleaseBroadcaster.emit("session", "explicit-release", {
    deviceId: SIMULATOR.deviceId,
  } as SessionReleaseSnapshot);
  expect(client.closeCount).toBe(1);
  expect(connections.get(SIMULATOR.deviceId)).toBeUndefined();
});

test("device removal closes the viewer", () => {
  const client = recordViewer();
  getDaemonStreamDeviceLifecycleEmitter().deviceRemoved(SIMULATOR.deviceId);
  expect(client.closeCount).toBe(1);
  expect(connections.get(SIMULATOR.deviceId)).toBeUndefined();
});

test("upgrade-only session release leaves the next owner's viewer connected", () => {
  const client = recordViewer();
  SessionReleaseBroadcaster.emit(
    "earlier-session",
    "explicit-release",
    { deviceId: SIMULATOR.deviceId } as SessionReleaseSnapshot,
    { upgradeOnly: true },
  );
  expect(client.closeCount).toBe(0);
  expect(connections.get(SIMULATOR.deviceId)).toBe(client);
});
