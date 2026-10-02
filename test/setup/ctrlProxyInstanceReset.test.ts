import { createMcpServer } from "../../src/server";
import { DAEMON_VERSION } from "../../src/daemon/constants";
import { getMcpServerVersion } from "../../src/utils/mcpVersion";
import { testOverrides } from "../../src/utils/testOverrides";
import { gitVersionPreloadSpawns } from "./testPreload";

import { describe, expect, test } from "bun:test";
import { AndroidCtrlProxyClient } from "../../src/features/observe/android/AndroidCtrlProxyClient";
import { IOSCtrlProxyClient } from "../../src/features/observe/ios/IOSCtrlProxyClient";
import type { BootedDevice } from "../../src/models";
import { FakeAdbExecutor } from "../fakes/FakeAdbExecutor";
import { FakeTimer } from "../fakes/FakeTimer";
import { clearCtrlProxyRegistries } from "./ctrlProxyRegistryCleanup";

const androidDevice: BootedDevice = {
  deviceId: "preload-reset-android",
  platform: "android",
  isEmulator: true,
  name: "Fake Android",
};

const iosDevice: BootedDevice = {
  deviceId: "PRELOAD-RESET-IOS",
  platform: "ios",
  name: "Fake iPhone",
};

describe("CtrlProxy unit-test preload registry cleanup", () => {
  // Exercise the exact hook function without relying on other files' order.
  test("Android cleanup clears a registered client", () => {
    const timer = new FakeTimer();
    const client = AndroidCtrlProxyClient.createForTesting(
      androidDevice,
      new FakeAdbExecutor(),
      () => {
        throw new Error("Registry test must not open a WebSocket");
      },
      timer,
    );

    AndroidCtrlProxyClient.registerForTesting(client, androidDevice.deviceId);
    expect(AndroidCtrlProxyClient.getExistingInstance(androidDevice.deviceId)).toBe(client);
    clearCtrlProxyRegistries();
    expect(AndroidCtrlProxyClient.getExistingInstance(androidDevice.deviceId)).toBeNull();
  });

  test("iOS cleanup clears a registered client", () => {
    const timer = new FakeTimer();
    const client = IOSCtrlProxyClient.createForTesting(
      iosDevice,
      8765,
      () => {
        throw new Error("Registry test must not open a WebSocket");
      },
      timer,
    );

    IOSCtrlProxyClient.registerForTesting(client, iosDevice.deviceId);
    expect(IOSCtrlProxyClient.getExistingInstance(iosDevice.deviceId)).toBe(client);
    clearCtrlProxyRegistries();
    expect(IOSCtrlProxyClient.getExistingInstance(iosDevice.deviceId)).toBeNull();
  });
});

test("the preload installs the git override before server and daemon imports without spawning git", async () => {
  // The recording hooks run before portAvailabilityPreload loads constants.
  // Checking the installed seam catches its removal even if another test warmed
  // the cache; the history catches an eager probe even if its error was swallowed.
  expect(testOverrides.gitMetadataClient).toBeDefined();
  expect(gitVersionPreloadSpawns).toEqual([]);
  expect(typeof createMcpServer).toBe("function");
  expect(DAEMON_VERSION).toBe(getMcpServerVersion());

  // A fresh version module defeats process-wide caching: the real spawn hooks
  // must also see no git on the first explicit version read.
  const modulePath = "../../src/utils/mcpVersion.ts?preload-guard";
  const fresh: typeof import("../../src/utils/mcpVersion") = await import(modulePath);
  expect(fresh.getMcpServerVersion()).toBe(DAEMON_VERSION);
  expect(gitVersionPreloadSpawns).toEqual([]);
});
