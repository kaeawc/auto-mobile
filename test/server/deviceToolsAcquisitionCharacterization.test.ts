import { afterEach, beforeEach, expect, test } from "bun:test";
import { ActionableError } from "../../src/models";
import { createAcquisitionHandlers } from "../../src/server/deviceToolsAcquisition";
import {
  resetDeviceToolsDependencies,
  setDeviceToolsDependencies,
} from "../../src/server/deviceTools";
import { FakeDeviceUtils } from "../fakes/FakeDeviceUtils";
import { FakeDeviceMatcher } from "../fakes/FakeDeviceMatcher";
import { FakeTimer } from "../fakes/FakeTimer";

let deviceUtils: FakeDeviceUtils;
let matcher: FakeDeviceMatcher;
let events: string[];
beforeEach(() => {
  deviceUtils = new FakeDeviceUtils();
  matcher = new FakeDeviceMatcher();
  events = [];
  setDeviceToolsDependencies({
    timer: new FakeTimer(),
    deviceManagerFactory: () => deviceUtils,
    deviceMatcherFactory: () => matcher,
    lifecycleCoordinator: {
      reserve: async (identity) => {
        events.push(`reserve:${identity.kind}`);
        return {
          identity,
          signal: new AbortController().signal,
          bindCanonicalIdentity: async () => {},
          transitionToTeardown: () => {},
          release: () => {
            events.push("release");
          },
        };
      },
    },
  });
});
afterEach(() => {
  resetDeviceToolsDependencies();
});

for (const platform of ["android", "ios"] as const) {
  test(`${platform} handler preserves aliases, budgets, internal session, and release ordering`, async () => {
    const failure = new ActionableError("characterized preparation failure");
    const controller = new AbortController();
    const handlers = createAcquisitionHandlers({
      getBootAndPrepareDevice: () => async (args, budgets, _deps, _utils, context) => {
        events.push("prepare");
        expect(args).toMatchObject({
          platform,
          deviceId: platform === "android" ? "emulator-5554" : "UDID",
          preferRunning: true,
          createIfMissing: false,
          __mcpSessionId: "session",
        });
        expect(budgets).toMatchObject({
          bootTimeoutMs: 1234,
          automationReadyTimeoutMs: 5678,
          automationDeadlineMs: 6912,
          operationName: platform === "android" ? "getAndroid" : "getApple",
        });
        expect(context.bootDeadlineMs).toBe(1234);
        expect(context.signal).toBeDefined();
        throw failure;
      },
    });
    if (platform === "android") {
      deviceUtils.setBootedDevices("android", [
        { platform: "android", name: "Pixel", deviceId: "emulator-5554" },
      ]);
    }
    const raw = {
      deviceId: platform === "android" ? "emulator-5554" : "UDID",
      bootTimeoutMs: 1234,
      automationReadyTimeoutMs: 5678,
      __mcpSessionId: "session",
    };
    const handler = platform === "android" ? handlers.getAndroidHandler : handlers.getAppleHandler;
    await expect(handler(raw, undefined, controller.signal)).rejects.toBe(failure);
    expect(events).toEqual(["reserve:stable", "prepare", "release"]);
    expect(raw.__mcpSessionId).toBe("session");
    expect(handlers.stripInternalAcquisitionParams(raw)).not.toHaveProperty("__mcpSessionId");
  });
}

for (const changed of [false, true]) {
  test(`legacy iOS name discovery revalidates identity after reservation, changed=${changed}`, async () => {
    const image = { platform: "ios" as const, name: "iPhone", deviceId: "first", isVirtual: true };
    deviceUtils.setDeviceImages("ios", [image]);
    matcher.setImageResult(image);
    setDeviceToolsDependencies({
      lifecycleCoordinator: {
        reserve: async (identity) => {
          events.push("reserve");
          if (changed) {
            matcher.setImageResult({ ...image, deviceId: "second" });
          }
          return {
            identity,
            signal: new AbortController().signal,
            bindCanonicalIdentity: async () => {},
            transitionToTeardown: () => {},
            release: () => {
              events.push("release");
            },
          };
        },
      },
    });
    const handlers = createAcquisitionHandlers({
      getBootAndPrepareDevice: () => async () => {
        events.push("prepare");
        throw new ActionableError("reached preparation");
      },
    });
    await expect(
      handlers.prepareDevice(
        { platform: "ios", name: "iPhone" },
        {
          bootTimeoutMs: 1000,
          automationReadyTimeoutMs: 1000,
          automationDeadlineMs: 2000,
          operationName: "startDevice",
        },
      ),
    ).rejects.toThrow(changed ? "changed while waiting" : "reached preparation");
    expect(events).toEqual(changed ? ["reserve", "release"] : ["reserve", "prepare", "release"]);
    expect(deviceUtils.getGetDeviceImagesDetailedCalls()).toHaveLength(2);
  });
}
