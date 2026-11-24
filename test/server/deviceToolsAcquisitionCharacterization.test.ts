import { afterEach, beforeEach, expect, test } from "bun:test";
import { ActionableError, type DeviceInfo } from "../../src/models";
import { createAcquisitionHandlers } from "../../src/server/deviceToolsAcquisition";
import {
  getDeviceToolsDependencies,
  resetDeviceToolsDependencies,
  setDeviceToolsDependencies,
} from "../../src/server/deviceTools";
import { SessionManager } from "../../src/daemon/sessionManager";
import { FakeDeviceSessionPersistence } from "../fakes/FakeDeviceSessionPersistence";
import { FakeDeviceUtils } from "../fakes/FakeDeviceUtils";
import { FakeDeviceMatcher } from "../fakes/FakeDeviceMatcher";
import { FakeTimer } from "../fakes/FakeTimer";
import { FakeChildProcess } from "../fakes/FakeChildProcess";
import { DeviceTransportOfflineError } from "../../src/models/DeviceTransportOfflineError";
import { asMcpConnection } from "../helpers/mcpConnection";
import {
  currentAutolockMcpSessionId,
  runWithToolSelectionContext,
} from "../../src/features/toolSelection/toolSelectionContext";

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
      isReserved: () => false,
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
      bootAndPrepareDevice: async (args, budgets, _deps, { options: context }) => {
        events.push("prepare");
        expect(args).toMatchObject({
          platform,
          deviceId: platform === "android" ? "emulator-5554" : "UDID",
          preferRunning: true,
          createIfMissing: false,
        });
        // The internal session reaches preparation ambiently, not as a forwarded arg (#15663).
        expect(args).not.toHaveProperty("__mcpSessionId");
        expect(currentAutolockMcpSessionId()).toBe("session");
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
    // Ingress writes the key in-band and runs the call under that connection (#15663).
    await expect(
      asMcpConnection("session", () => handler(raw, undefined, controller.signal)),
    ).rejects.toBe(failure);
    expect(events).toEqual(["reserve:stable", "prepare", "release"]);
    expect(raw.__mcpSessionId).toBe("session");
    expect(handlers.stripInternalAcquisitionParams(raw)).not.toHaveProperty("__mcpSessionId");
  });
}

for (const changed of [false, true]) {
  test(`legacy iOS name discovery revalidates identity after reservation, changed=${changed}`, async () => {
    const image: DeviceInfo = {
      platform: "ios",
      name: "iPhone",
      deviceId: "first",
      isRunning: false,
    };
    deviceUtils.setDeviceImages("ios", [image]);
    matcher.setImageResult(image);
    setDeviceToolsDependencies({
      lifecycleCoordinator: {
        isReserved: () => false,
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
      bootAndPrepareDevice: async () => {
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

test("getAndroid refuses a missing CtrlProxy APK override before reserving or booting (#18823)", async () => {
  setDeviceToolsDependencies({
    env: { AUTOMOBILE_CTRL_PROXY_APK_PATH: "/deleted/lane/control-proxy-debug.apk" },
    ctrlProxyApkOverrideProbe: {
      stat: async (filePath) => {
        throw new Error(`ENOENT: no such file or directory, stat '${filePath}'`);
      },
    },
  });
  const handlers = createAcquisitionHandlers({
    bootAndPrepareDevice: async () => {
      events.push("prepare");
      throw new ActionableError("must not boot");
    },
  });
  deviceUtils.setBootedDevices("android", [
    { platform: "android", name: "Pixel", deviceId: "emulator-5554" },
  ]);
  await expect(handlers.getAndroidHandler({ deviceId: "emulator-5554" })).rejects.toThrow(
    /AUTOMOBILE_CTRL_PROXY_APK_PATH points to \/deleted\/lane\/control-proxy-debug\.apk/,
  );
  expect(events).toEqual([]);
});

test("getApple ignores the Android CtrlProxy APK override", async () => {
  setDeviceToolsDependencies({
    env: { AUTOMOBILE_CTRL_PROXY_APK_PATH: "/deleted/lane/control-proxy-debug.apk" },
    ctrlProxyApkOverrideProbe: {
      stat: async () => {
        throw new Error("probe must not run for iOS");
      },
    },
  });
  const handlers = createAcquisitionHandlers({
    bootAndPrepareDevice: async () => {
      events.push("prepare");
      throw new ActionableError("reached preparation");
    },
  });
  await expect(handlers.getAppleHandler({ deviceId: "UDID" })).rejects.toThrow(
    "reached preparation",
  );
  expect(events).toContain("prepare");
});

test("bare getAndroid selects a phone through the selector lease (#19124)", async () => {
  const handlers = createAcquisitionHandlers({
    bootAndPrepareDevice: async (args, budgets) => {
      events.push("prepare");
      expect(args).toMatchObject({
        platform: "android",
        formFactor: "phone",
        preferRunning: true,
        createIfMissing: false,
      });
      expect(args.name).toBeUndefined();
      expect(args.deviceId).toBeUndefined();
      expect(budgets.stableTarget).toBeUndefined();
      expect(budgets.androidAvdName).toBeUndefined();
      throw new ActionableError("reached preparation");
    },
  });
  await expect(handlers.getAndroidHandler({})).rejects.toThrow("reached preparation");
  expect(events).toEqual(["reserve:selector", "prepare", "release"]);
});

test("bare getAndroid keeps the phone default under requirements a phone meets (#19153)", async () => {
  const seen: unknown[] = [];
  const handlers = createAcquisitionHandlers({
    bootAndPrepareDevice: async (args) => {
      seen.push({ formFactor: args.formFactor, requires: args.requires });
      throw new ActionableError("reached preparation");
    },
  });
  for (const requires of [{ playStore: true }, { playStore: undefined }]) {
    await expect(handlers.getAndroidHandler({ requires })).rejects.toThrow("reached preparation");
  }
  expect(seen).toEqual([
    { formFactor: "phone", requires: { playStore: true } },
    { formFactor: "phone", requires: { playStore: undefined } },
  ]);
});

test("bare getAndroid with a requirement naming another form factor drops the phone default (#19153)", async () => {
  const handlers = createAcquisitionHandlers({
    bootAndPrepareDevice: async (args) => {
      expect(args.formFactor).toBeUndefined();
      expect(args.requires).toEqual({ screenRound: true });
      throw new ActionableError("reached preparation");
    },
  });
  await expect(handlers.getAndroidHandler({ requires: { screenRound: true } })).rejects.toThrow(
    "reached preparation",
  );
});

async function sessionHolding(timer: FakeTimer, deviceId: string): Promise<SessionManager> {
  const sessions = new SessionManager(timer, new FakeDeviceSessionPersistence());
  sessions.stopCleanupTimer();
  await sessions.createSession("session-a", deviceId, "android", { timeoutMs: 60_000 });
  const base = getDeviceToolsDependencies().daemonState;
  setDeviceToolsDependencies({
    timer,
    daemonState: {
      isInitialized: () => true,
      getSessionManager: () => sessions,
      getDevicePool: () => base.getDevicePool(),
      getDeviceSessionRegistry: () => base.getDeviceSessionRegistry(),
    },
  });
  return sessions;
}

for (const sessionDeviceBooted of [true, false]) {
  test(`bare getAndroid from a session holding a phone, booted=${sessionDeviceBooted} (#19153)`, async () => {
    const timer = new FakeTimer();
    const sessions = await sessionHolding(timer, "emulator-5556");
    deviceUtils.setBootedDevices("android", [
      { platform: "android", name: "Pixel_A", deviceId: "emulator-5554" },
      ...(sessionDeviceBooted
        ? [{ platform: "android" as const, name: "Pixel_B", deviceId: "emulator-5556" }]
        : []),
    ]);
    const seen: unknown[] = [];
    const handlers = createAcquisitionHandlers({
      bootAndPrepareDevice: async (args) => {
        seen.push({ deviceId: args.deviceId, formFactor: args.formFactor });
        throw new ActionableError("reached preparation");
      },
    });
    try {
      // Ingress routes the call to the connection's bound session ambiently.
      await expect(
        runWithToolSelectionContext({ routingSessionUuid: "session-a" }, () =>
          handlers.getAndroidHandler({}),
        ),
      ).rejects.toThrow("reached preparation");
    } finally {
      sessions.stopCleanupTimer();
    }
    expect(seen).toEqual([
      sessionDeviceBooted
        ? { deviceId: "emulator-5556", formFactor: undefined }
        : { deviceId: undefined, formFactor: "phone" },
    ]);
  });
}

const coldBootedPixel = {
  platform: "android" as const,
  name: "Pixel_A",
  deviceId: "emulator-5554",
};

test("a failed acquisition that shut down its cold boot says so and names the retry (#19124)", async () => {
  const timer = new FakeTimer();
  setDeviceToolsDependencies({ timer });
  const child = new FakeChildProcess(timer);
  const failure = new ActionableError(
    "CtrlProxy APK upgrade failed with an unrecognized adb failure; the installed CtrlProxy was left in place",
  );
  const handlers = createAcquisitionHandlers({
    bootAndPrepareDevice: async (_args, _budgets, _deps, { options: context }) => {
      context.state.boot = {
        device: coldBootedPixel,
        source: "cold-boot",
        provisioned: false,
        processHandle: child,
      };
      throw failure;
    },
  });
  const rejected = await handlers
    .getAndroidHandler({ avdName: "Pixel_A" })
    .catch((error: unknown) => error);
  if (!(rejected instanceof ActionableError)) {
    throw new Error("expected an ActionableError");
  }
  expect(rejected.cause).toBe(failure);
  expect(failure.message).not.toContain("deviceLeft");
  expect(rejected.message).toContain("left in place. deviceLeft: shutdown");
  expect(rejected.message).toContain(
    'Next step: retry getAndroid with the same avdName ("Pixel_A").',
  );
  expect(child.killed).toBe(true);
});

test("a retryable failure that keeps its cold boot running reports it still booted (#19124)", async () => {
  const timer = new FakeTimer();
  setDeviceToolsDependencies({ timer });
  const child = new FakeChildProcess(timer);
  const failure = new DeviceTransportOfflineError("emulator-5554", undefined);
  const original = failure.message;
  const handlers = createAcquisitionHandlers({
    bootAndPrepareDevice: async (_args, _budgets, _deps, { options: context }) => {
      context.state.boot = {
        device: coldBootedPixel,
        source: "cold-boot",
        provisioned: false,
        processHandle: child,
      };
      throw failure;
    },
  });
  const rejected = await handlers.getAndroidHandler({}).catch((error: unknown) => error);
  if (!(rejected instanceof DeviceTransportOfflineError)) {
    throw new Error("expected a DeviceTransportOfflineError");
  }
  expect(rejected.cause).toBe(failure);
  expect(failure.message).toBe(original);
  expect(rejected.message).toBe(
    `${original} deviceLeft: booted (the device is still running). ` +
      "Next step: retry getAndroid with the same arguments.",
  );
  expect(child.killed).toBe(false);
});

test("a failure on a device that was already running keeps its message (#19124)", async () => {
  const failure = new ActionableError("readiness failed.");
  const handlers = createAcquisitionHandlers({
    bootAndPrepareDevice: async (_args, _budgets, _deps, { options: context }) => {
      context.state.boot = { device: coldBootedPixel, source: "booted", provisioned: false };
      throw failure;
    },
  });
  deviceUtils.setBootedDevices("android", [coldBootedPixel]);
  await expect(handlers.getAndroidHandler({ deviceId: "emulator-5554" })).rejects.toBe(failure);
  expect(failure.message).toBe("readiness failed.");
});

test("a failure before any device was booted keeps its message (#19124)", async () => {
  const failure = new ActionableError("no boot yet");
  const handlers = createAcquisitionHandlers({
    bootAndPrepareDevice: async () => {
      throw failure;
    },
  });
  await expect(handlers.getAndroidHandler({ avdName: "Pixel_A" })).rejects.toBe(failure);
  expect(failure.message).toBe("no boot yet");
});
