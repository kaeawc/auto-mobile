import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import {
  MAX_CTRL_PROXY_DOCTOR_DEVICES,
  checkWorkProfileAccessibility,
  checkImageBackend,
  checkCtrlProxy,
  checkCtrlProxyVersion,
  checkDaemonBuildIdentity,
  checkDaemonConnectivity,
  checkDaemonStatus,
  checkDaemonVersion,
  runAutoMobileChecks,
  runPostRepairAutoMobileChecks,
} from "../../src/doctor/checks/automobile";
import type { BuildIdentity } from "../../src/daemon/buildIdentity";
import {
  LATEST_RELEASE_VERSION,
  RELEASE_CHECKSUM_REGISTRY,
  RELEASE_VERSION,
  resolveAssetVersion,
} from "../../src/constants/release";
import { getMcpServerVersion } from "../../src/utils/mcpVersion";
import { FakeAdbExecutor } from "../fakes/FakeAdbExecutor";
import type { AdbClientFactory } from "../../src/utils/android-cmdline-tools/AdbClientFactory";
import { AndroidCtrlProxyManager } from "../../src/ctrlProxy/CtrlProxyManager";
import { FakeLogger } from "../fakes/FakeLogger";
import { createDoctorDeadline } from "../../src/doctor/deadline";
import { logger } from "../../src/utils/logger";
import { DoctorDeadlineError } from "../../src/doctor/deadline";
import { FakeTimer } from "../fakes/FakeTimer";
import { ActionableError } from "../../src/models/ActionableError";

describe("checkDaemonVersion", () => {
  test("returns pass status", () => {
    expect(checkDaemonVersion().status).toBe("pass");
  });

  test("reports the daemon JS package version, not the CtrlProxy version", () => {
    const result = checkDaemonVersion();

    expect(result.name).toBe("AutoMobile Daemon Version");
    expect(result.value).toBe(getMcpServerVersion());
    expect(result.message).toBe(`Version ${getMcpServerVersion()}`);
  });
});

describe("checkCtrlProxyVersion", () => {
  test("returns pass status", () => {
    expect(checkCtrlProxyVersion().status).toBe("pass");
  });

  test("reports the concrete on-device CtrlProxy version from the registry", () => {
    const result = checkCtrlProxyVersion();
    const expected = resolveAssetVersion(RELEASE_VERSION);

    expect(result.name).toBe("CtrlProxy Release Version");
    expect(result.value).toBe(expected);
    if (RELEASE_VERSION === LATEST_RELEASE_VERSION) {
      expect(result.message).toMatch(/\(latest\)$/);
    }
  });

  test("honors AUTOMOBILE_VERSION and drops the (latest) suffix when pinned (EC6)", () => {
    const prev = process.env.AUTOMOBILE_VERSION;
    process.env.AUTOMOBILE_VERSION = "0.0.18";
    try {
      const result = checkCtrlProxyVersion();
      expect(result.value).toBe("0.0.18");
      expect(result.message).toBe("Version 0.0.18");
    } finally {
      if (prev === undefined) {
        delete process.env.AUTOMOBILE_VERSION;
      } else {
        process.env.AUTOMOBILE_VERSION = prev;
      }
    }
  });
});

describe("checkImageBackend", () => {
  test("reports active sharp backend and load status on macOS and Linux", async () => {
    const result = await checkImageBackend({
      platform: "linux",
      sharpLoader: async () => ({}) as never,
    });

    expect(result).toEqual({
      name: "Image Backend",
      status: "pass",
      message: "active=sharp; sharp=loaded",
    });
  });

  test("logs and returns a typed failure when sharp cannot load", async () => {
    const warnings: string[] = [];

    const result = await checkImageBackend({
      platform: "darwin",
      sharpLoader: async () => {
        throw new Error("sharp import failed");
      },
      logger: {
        warn: (message) => warnings.push(message),
      },
    });

    expect(result.name).toBe("Image Backend");
    expect(result.status).toBe("fail");
    expect(result.message).toBe(
      "active=sharp; sharp=unavailable; webp=unavailable; error=sharp import failed",
    );
    expect(result.recommendation).toContain("Reinstall dependencies");
    expect(result.recommendation).toContain("WebP support");
    expect(warnings).toEqual(["Image backend doctor check failed: sharp import failed"]);
  });

  test("skips real sharp loading when tests spoof process.platform away from the host OS", async () => {
    const result = await checkImageBackend({
      platform: "linux",
      hostPlatform: "darwin",
    });

    expect(result).toEqual({
      name: "Image Backend",
      status: "skip",
      message: "active=sharp; sharp=not checked; platform=linux; host=darwin",
    });
  });

  test("reports active jimp-cli backend and cwebp/dwebp resolution on Windows", async () => {
    const result = await checkImageBackend({
      platform: "win32",
      webpBinaryResolver: {
        resolve: async () => ({
          cwebp: "C:\\auto-mobile\\vendor\\libwebp\\cwebp.exe",
          dwebp: "C:\\auto-mobile\\vendor\\libwebp\\dwebp.exe",
        }),
      },
    });

    expect(result).toEqual({
      name: "Image Backend",
      status: "pass",
      message:
        "active=jimp-cli; cwebp=C:\\auto-mobile\\vendor\\libwebp\\cwebp.exe; dwebp=C:\\auto-mobile\\vendor\\libwebp\\dwebp.exe",
    });
  });

  test("logs and returns a typed failure when Windows WebP binaries are unavailable", async () => {
    const warnings: string[] = [];

    const result = await checkImageBackend({
      platform: "win32",
      webpBinaryResolver: {
        resolve: async () => {
          throw new Error("Unable to resolve cwebp");
        },
      },
      logger: {
        warn: (message) => warnings.push(message),
      },
    });

    expect(result.name).toBe("Image Backend");
    expect(result.status).toBe("fail");
    expect(result.message).toBe(
      "active=jimp-cli; cwebp=unavailable; dwebp=unavailable; error=Unable to resolve cwebp",
    );
    expect(result.recommendation).toContain("AUTOMOBILE_CWEBP_PATH");
    expect(warnings).toEqual(["Image backend doctor check failed: Unable to resolve cwebp"]);
  });
});

test("daemon diagnostics disable identity recovery and metadata republishing", async () => {
  const argumentsReceived: Array<boolean | undefined> = [];
  const daemonManager = {
    status: async (recoverIdentity?: boolean) => {
      argumentsReceived.push(recoverIdentity);
      return { running: false };
    },
  };
  const getDaemonHealthReport = async () => ({
    timestamp: "",
    daemonRunning: false,
    socketExists: false,
    socketAccessible: false,
    pidFileExists: false,
    pidFileValid: false,
    socketConnectable: false,
    recommendations: [],
  });
  await checkDaemonStatus({ daemonManager, getDaemonHealthReport });
  await checkDaemonBuildIdentity({ daemonManager });
  expect(argumentsReceived).toEqual([false, false]);
});

describe("checkDaemonStatus", () => {
  test("probes daemon socket before invoking status cleanup", async () => {
    const result = await checkDaemonStatus({
      daemonManager: {
        status: async () => {
          throw new Error("status should not run before socket probe succeeds");
        },
      },
      getDaemonHealthReport: async () => ({
        timestamp: "2026-06-29T00:00:00.000Z",
        daemonRunning: true,
        socketExists: true,
        socketAccessible: true,
        pidFileExists: true,
        pidFileValid: true,
        daemonPid: 12345,
        socketConnectable: true,
        recommendations: [],
      }),
    });

    expect(result.name).toBe("Daemon Status");
    expect(result.status).toBe("pass");
    expect(result.message).toBe("Running (serving via socket)");
    expect(result.value).toBe(12345);
  });

  test("reports responsive serving daemon when pid status is stale", async () => {
    const result = await checkDaemonStatus({
      daemonManager: {
        status: async () => ({ running: false }),
      },
      getDaemonHealthReport: async () => ({
        timestamp: "2026-06-29T00:00:00.000Z",
        daemonRunning: false,
        socketExists: true,
        socketAccessible: true,
        pidFileExists: false,
        pidFileValid: false,
        socketConnectable: true,
        recommendations: [],
      }),
    });

    expect(result.name).toBe("Daemon Status");
    expect(result.status).toBe("pass");
    expect(result.message).toBe("Running (serving via socket)");
    expect(result.recommendation).toBeUndefined();
  });

  test("recommends a concrete pinned install command, never @latest (EC6)", async () => {
    const result = await checkDaemonStatus({
      daemonManager: {
        status: async () => ({ running: false }),
      },
      getDaemonHealthReport: async () => ({
        timestamp: "2026-06-29T00:00:00.000Z",
        daemonRunning: false,
        socketExists: false,
        socketAccessible: false,
        pidFileExists: false,
        pidFileValid: false,
        socketConnectable: false,
        recommendations: [],
      }),
    });

    expect(result.status).toBe("warn");
    expect(result.recommendation).toContain("@kaeawc/auto-mobile@");
    // Issue #2746: floating @latest advice causes silent version drift.
    expect(result.recommendation).not.toContain("@latest");
    expect(result.recommendation).toContain(RELEASE_CHECKSUM_REGISTRY[0].version);
  });
});

describe("AutoMobile doctor cancellation", () => {
  test("bounds a stalled image backend load with the shared doctor deadline", async () => {
    const timer = new FakeTimer();
    const deadline = createDoctorDeadline({ timeoutMs: 50, timer }, timer);
    const check = checkImageBackend(
      {
        platform: "darwin",
        sharpLoader: async () => await new Promise<never>(() => {}),
      },
      deadline.probe,
    );

    timer.advanceTime(50);

    await expect(check).resolves.toMatchObject({
      name: "Image Backend",
      status: "fail",
      message: expect.stringContaining("Doctor diagnostic deadline elapsed"),
    });
    deadline.dispose();
  });

  test("bounds the daemon status fallback when its PID-file read stalls", async () => {
    const timer = new FakeTimer();
    const deadline = createDoctorDeadline({ timeoutMs: 50, timer }, timer);
    const check = checkDaemonStatus(
      {
        daemonManager: {
          status: async () => await new Promise<never>(() => {}),
        },
        getDaemonHealthReport: async () => ({
          timestamp: "2026-09-16T00:00:00.000Z",
          daemonRunning: false,
          socketExists: true,
          socketAccessible: true,
          pidFileExists: true,
          pidFileValid: true,
          socketConnectable: false,
          recommendations: [],
        }),
      },
      deadline.probe,
    );

    timer.advanceTime(50);

    await expect(check).resolves.toMatchObject({
      name: "Daemon Status",
      status: "warn",
      message: "Could not check daemon: Doctor diagnostic deadline elapsed",
    });
    deadline.dispose();
  });

  test("aborts delayed daemon health I/O without publishing a late connectivity pass", async () => {
    const timer = new FakeTimer();
    const deadline = createDoctorDeadline({ timeoutMs: 50, timer }, timer);
    let observedSignal: AbortSignal | undefined;
    let observedTimeoutMs: number | undefined;
    let lateSuccess = false;
    let settled = false;
    const check = checkDaemonConnectivity(async (probe) => {
      observedSignal = probe?.signal;
      observedTimeoutMs = probe?.timeoutMs;
      await new Promise<void>((resolve) => {
        probe?.signal?.addEventListener("abort", resolve, { once: true });
      });
      try {
        probe?.signal?.throwIfAborted();
        lateSuccess = true;
        return {
          timestamp: "2026-09-14T00:00:00.000Z",
          daemonRunning: true,
          socketExists: true,
          socketAccessible: true,
          pidFileExists: true,
          pidFileValid: true,
          socketConnectable: true,
          recommendations: [],
        };
      } finally {
        settled = true;
      }
    }, deadline.probe);

    timer.advanceTime(50);
    const result = await check;
    deadline.dispose();

    expect(observedSignal?.aborted).toBe(true);
    expect(observedTimeoutMs).toBe(50);
    expect(settled).toBe(true);
    expect(lateSuccess).toBe(false);
    expect(result.status).toBe("warn");
  });
});

describe("checkDaemonBuildIdentity", () => {
  const client: BuildIdentity = {
    entryScript: "/wt/dist/src/index.js",
    buildId: "1111111111111111",
  };

  test("skips when the daemon is not running", async () => {
    const result = await checkDaemonBuildIdentity({
      daemonManager: { status: async () => ({ running: false }) },
      getClientBuildIdentity: () => client,
    });

    expect(result.name).toBe("Daemon Build Identity");
    expect(result.status).toBe("skip");
    expect(result.message).toBe("Daemon is not running");
  });

  test("passes and surfaces buildId + entryScript when client and daemon builds match", async () => {
    const result = await checkDaemonBuildIdentity({
      daemonManager: {
        status: async () => ({
          running: true,
          pid: 4242,
          entryScript: "/wt/dist/src/index.js",
          buildId: "1111111111111111",
        }),
      },
      getClientBuildIdentity: () => client,
    });

    expect(result.status).toBe("pass");
    // No `value`: the console formatter renders `value` instead of `message`, so
    // both buildId and entryScript are carried in the message to stay visible.
    expect(result.value).toBeUndefined();
    expect(result.message).toContain("1111111111111111");
    expect(result.message).toContain("/wt/dist/src/index.js");
    expect(result.recommendation).toBeUndefined();
  });

  test("warns and shows BOTH identities when the daemon is a different build", async () => {
    const result = await checkDaemonBuildIdentity({
      daemonManager: {
        status: async () => ({
          running: true,
          pid: 4242,
          entryScript: "/main/dist/src/index.js",
          buildId: "2222222222222222",
        }),
      },
      getClientBuildIdentity: () => client,
    });

    expect(result.status).toBe("warn");
    // daemon identity
    expect(result.message).toContain("2222222222222222");
    expect(result.message).toContain("/main/dist/src/index.js");
    // client identity
    expect(result.message).toContain("1111111111111111");
    expect(result.message).toContain("/wt/dist/src/index.js");
    expect(result.recommendation).toContain("restart");
  });

  test("warns (does not throw) when reading daemon status fails", async () => {
    const result = await checkDaemonBuildIdentity({
      daemonManager: {
        status: async () => {
          throw new Error("PID file unreadable");
        },
      },
      getClientBuildIdentity: () => client,
    });

    expect(result.status).toBe("warn");
    expect(result.message).toContain("PID file unreadable");
  });

  test("bounds a stalled daemon status read with the shared doctor deadline", async () => {
    const timer = new FakeTimer();
    const deadline = createDoctorDeadline({ timeoutMs: 50, timer }, timer);
    let settled = false;
    const check = checkDaemonBuildIdentity(
      {
        daemonManager: {
          status: () => new Promise(() => {}),
        },
        getClientBuildIdentity: () => client,
      },
      deadline.probe,
    ).then((result) => {
      settled = true;
      return result;
    });

    await Promise.resolve();
    expect(settled).toBe(false);
    timer.advanceTime(50);
    const result = await check;
    deadline.dispose();

    expect(settled).toBe(true);
    expect(result.status).toBe("warn");
    expect(result.message).toContain("Doctor diagnostic deadline elapsed");
  });

  test("does not report a false skew for a legacy daemon without build identity", async () => {
    const result = await checkDaemonBuildIdentity({
      daemonManager: {
        status: async () => ({
          running: true,
          pid: 4242,
          // legacy daemon predating build identity: no entryScript/buildId
        }),
      },
      getClientBuildIdentity: () => client,
    });

    expect(result.status).toBe("pass");
    expect(result.message).toContain("unknown");
  });
});

describe("checkCtrlProxy", () => {
  let fakeAdb: FakeAdbExecutor;
  let fakeFactory: AdbClientFactory;

  beforeEach(() => {
    AndroidCtrlProxyManager.resetInstances();
    AndroidCtrlProxyManager.setExpectedChecksumForTesting(null);
    fakeAdb = new FakeAdbExecutor();
    fakeFactory = {
      create: () => fakeAdb,
    };
  });

  afterEach(async () => {
    AndroidCtrlProxyManager.setExpectedChecksumForTesting(null);
    await AndroidCtrlProxyManager.cleanupPrefetchedApk();
  });

  test("returns skip when no devices connected", async () => {
    fakeAdb.setDevices([]);

    const result = await checkCtrlProxy(fakeFactory);

    expect(result.name).toBe("CtrlProxy");
    expect(result.status).toBe("skip");
    expect(result.message).toBe("No Android devices connected");
  });

  test("logs unexpected failures at warn before returning typed skip", async () => {
    const log = new FakeLogger();
    const result = await checkCtrlProxy(
      {
        create: () => {
          throw new Error("adb unavailable");
        },
      },
      { logger: log },
    );

    expect(result.name).toBe("CtrlProxy");
    expect(result.status).toBe("skip");
    expect(result.message).toBe("Could not check: adb unavailable");
    expect(log.at("warn")).toContainEqual(
      expect.objectContaining({
        message: "CtrlProxy check failed: adb unavailable",
      }),
    );
  });

  test("fails malformed mirror configuration even when no devices are connected (#2815)", async () => {
    const prevBaseUrl = process.env.AUTOMOBILE_ASSET_BASE_URL;
    process.env.AUTOMOBILE_ASSET_BASE_URL = "https://mirror.test/am?";
    try {
      fakeAdb.setDevices([]);

      const result = await checkCtrlProxy(fakeFactory);

      expect(result.name).toBe("CtrlProxy");
      expect(result.status).toBe("fail");
      expect(result.message).toContain(
        "AUTOMOBILE_ASSET_BASE_URL must not include a query string or fragment",
      );
    } finally {
      if (prevBaseUrl === undefined) {
        delete process.env.AUTOMOBILE_ASSET_BASE_URL;
      } else {
        process.env.AUTOMOBILE_ASSET_BASE_URL = prevBaseUrl;
      }
    }
  });

  test("fails (not skips) when AUTOMOBILE_VERSION pins an unverifiable version (#2746)", async () => {
    const prevVersion = process.env.AUTOMOBILE_VERSION;
    process.env.AUTOMOBILE_VERSION = "99.99.99";
    try {
      fakeAdb.setDevices([
        {
          deviceId: "emulator-5554",
          platform: "android",
          isEmulator: true,
          name: "Pixel",
        },
      ]);

      const result = await checkCtrlProxy(fakeFactory);

      // Must be `fail` so the `--cli doctor` CI gate blocks — a thrown guard would
      // otherwise be caught and downgraded to `skip`, which doesn't count as a failure.
      expect(result.status).toBe("fail");
      expect(result.message).toContain("99.99.99");
      expect(result.recommendation).toContain("AUTOMOBILE_SKIP_ACCESSIBILITY_CHECKSUM");
    } finally {
      if (prevVersion === undefined) {
        delete process.env.AUTOMOBILE_VERSION;
      } else {
        process.env.AUTOMOBILE_VERSION = prevVersion;
      }
    }
  });

  test("fails (not skips) when a known pinned CtrlProxy APK SHA mismatches (#2815)", async () => {
    const prevVersion = process.env.AUTOMOBILE_VERSION;
    process.env.AUTOMOBILE_VERSION = "0.0.18";
    try {
      fakeAdb.setDevices([
        {
          deviceId: "emulator-5554",
          platform: "android",
          isEmulator: true,
          name: "Pixel",
        },
      ]);
      fakeAdb.setCommandResponse(`shell pm list packages ${AndroidCtrlProxyManager.PACKAGE}`, {
        stdout: `package:${AndroidCtrlProxyManager.PACKAGE}\n`,
        stderr: "",
      });
      fakeAdb.setCommandResponse(`shell pm path ${AndroidCtrlProxyManager.PACKAGE}`, {
        stdout: "package:/data/app/dev.jasonpearson.automobile.ctrlproxy/base.apk\n",
        stderr: "",
      });
      fakeAdb.setCommandResponse("shell sha256sum", {
        stdout: "different-sha /data/app/dev.jasonpearson.automobile.ctrlproxy/base.apk\n",
        stderr: "",
      });

      const result = await checkCtrlProxy(fakeFactory);

      expect(result.status).toBe("fail");
      expect(result.message).toContain(
        "Installed CtrlProxy APK SHA differs from expected release checksum",
      );
      expect(result.message).toContain("AUTOMOBILE_VERSION=0.0.18");
    } finally {
      if (prevVersion === undefined) {
        delete process.env.AUTOMOBILE_VERSION;
      } else {
        process.env.AUTOMOBILE_VERSION = prevVersion;
      }
    }
  });

  function configureInstalled(adb: FakeAdbExecutor, sha = "different-sha", enabled = true) {
    adb.setCommandResponse(`shell pm list packages ${AndroidCtrlProxyManager.PACKAGE}`, {
      stdout: `package:${AndroidCtrlProxyManager.PACKAGE}\n`,
      stderr: "",
    });
    adb.setCommandResponse("shell pm path", { stdout: "package:/data/app/base.apk", stderr: "" });
    adb.setCommandResponse("shell sha256sum", { stdout: `${sha} /data/app/base.apk`, stderr: "" });
    adb.setCommandResponse("settings get secure", {
      stdout: enabled ? AndroidCtrlProxyManager.PACKAGE : "",
      stderr: "",
    });
  }

  const device = (deviceId: string) => ({
    deviceId,
    platform: "android" as const,
    isEmulator: true,
    name: "Pixel",
  });

  test("reports mismatch without provisioning or mutating adb commands", async () => {
    AndroidCtrlProxyManager.setExpectedChecksumForTesting("expected-sha");
    fakeAdb.setDevices([device("one")]);
    configureInstalled(fakeAdb);
    const spies = [
      spyOn(AndroidCtrlProxyManager.prototype, "downloadApk"),
      spyOn(AndroidCtrlProxyManager.prototype, "install"),
      spyOn(AndroidCtrlProxyManager.prototype, "enable"),
      spyOn(AndroidCtrlProxyManager.prototype, "ensureCompatibleVersion"),
    ];
    try {
      const result = await checkCtrlProxy(fakeFactory);
      expect(result.status).toBe("warn");
      expect(result.message).toContain("versionStatus=mismatch");
      expect(result.recommendation).toContain("doctor does not install");
      expect(result.recommendation).toContain("observe) against one");
      for (const spy of spies) {
        expect(spy).not.toHaveBeenCalled();
      }
      expect(
        fakeAdb
          .getExecutedCommands()
          .filter((cmd) => /(?:^|\s)install\b|settings.*put|pm uninstall/.test(cmd)),
      ).toEqual([]);
    } finally {
      for (const spy of spies) {
        spy.mockRestore();
      }
    }
  });

  test("warns for missing APK without installing, including a known pin", async () => {
    const previous = process.env.AUTOMOBILE_VERSION;
    process.env.AUTOMOBILE_VERSION = "0.0.18";
    fakeAdb.setDevices([device("one")]);
    try {
      const result = await checkCtrlProxy(fakeFactory);
      expect(result.status).toBe("warn");
      expect(result.message).toContain("versionStatus=not_installed");
      expect(result.recommendation).toContain("readiness installs/updates");
      expect(
        fakeAdb
          .getExecutedCommands()
          .every((cmd) => cmd.startsWith("shell pm list") || cmd.startsWith("shell settings get")),
      ).toBe(true);
    } finally {
      if (previous === undefined) {
        delete process.env.AUTOMOBILE_VERSION;
      } else {
        process.env.AUTOMOBILE_VERSION = previous;
      }
    }
  });

  test("preserves live manager registry and memoized reads", async () => {
    const liveAdb = new FakeAdbExecutor();
    configureInstalled(liveAdb, "expected-sha");
    const liveFactory = { create: () => liveAdb };
    const live = AndroidCtrlProxyManager.getInstance(device("one"), liveFactory);
    await live.isInstalled();
    await live.isEnabled();
    const commands = liveAdb.getExecutedCommands().length;
    fakeAdb.setDevices([device("one")]);
    configureInstalled(fakeAdb);
    await checkCtrlProxy(fakeFactory);
    expect(AndroidCtrlProxyManager.getExistingInstance("one")).toBe(live);
    expect(Reflect.get(AndroidCtrlProxyManager, "adbFactory")).toBe(liveFactory);
    expect(await live.isInstalled()).toBe(true);
    expect(await live.isEnabled()).toBe(true);
    expect(liveAdb.getExecutedCommands()).toHaveLength(commands);
    expect(fakeAdb.getExecutedCommands().length).toBeGreaterThan(0);
  });

  test("checks each device using its factory, aggregates worst status and targets", async () => {
    AndroidCtrlProxyManager.setExpectedChecksumForTesting("expected-sha");
    fakeAdb.setDevices([device("one"), device("two")]);
    const one = new FakeAdbExecutor();
    const two = new FakeAdbExecutor();
    configureInstalled(one, "expected-sha");
    configureInstalled(two);
    const factory: AdbClientFactory = {
      create: (target) => (target ? (target.deviceId === "one" ? one : two) : fakeAdb),
    };
    const result = await checkCtrlProxy(factory);
    expect(result.status).toBe("warn");
    expect(result.message).toContain("device=one");
    expect(result.message).toContain(" | platform=android; device=two");
    expect(one.getExecutedCommands().length).toBeGreaterThan(0);
    expect(two.getExecutedCommands().length).toBeGreaterThan(0);
    expect((await checkCtrlProxy(factory, {}, {}, "one")).status).toBe("pass");
    expect((await checkCtrlProxy(factory, {}, {}, "one")).message).not.toContain("device=two");
    expect((await checkCtrlProxy(factory, {}, {}, "missing")).message).toBe(
      "Requested device is not booted: missing",
    );
  });

  test("warns when installed SHA cannot be read or accessibility is disabled", async () => {
    AndroidCtrlProxyManager.setExpectedChecksumForTesting("expected-sha");
    fakeAdb.setDevices([device("one")]);
    configureInstalled(fakeAdb, "expected-sha", false);
    const disabled = await checkCtrlProxy(fakeFactory);
    expect(disabled.status).toBe("warn");
    expect(disabled.recommendation).toContain("Enable CtrlProxy in device settings");
    configureInstalled(fakeAdb);
    fakeAdb.setCommandResponse("shell pm path", { stdout: "", stderr: "" });
    const unknown = await checkCtrlProxy(fakeFactory);
    expect(unknown.status).toBe("warn");
    expect(unknown.message).toContain("versionStatus=unverifiable");
  });

  test("fails when a known pinned installed APK SHA cannot be read", async () => {
    const previousVersion = process.env.AUTOMOBILE_VERSION;
    const previousSkip = process.env.AUTOMOBILE_SKIP_ACCESSIBILITY_CHECKSUM;
    process.env.AUTOMOBILE_VERSION = "0.0.18";
    delete process.env.AUTOMOBILE_SKIP_ACCESSIBILITY_CHECKSUM;
    AndroidCtrlProxyManager.setExpectedChecksumForTesting("expected-sha");
    fakeAdb.setDevices([device("one")]);
    configureInstalled(fakeAdb);
    fakeAdb.setCommandResponse("shell pm path", { stdout: "", stderr: "" });
    try {
      const result = await checkCtrlProxy(fakeFactory);
      expect(result.status).toBe("fail");
      expect(result.message).toContain("versionStatus=unverifiable");
      expect(result.message).toContain("cannot verify the pinned release");
      expect(result.message).toContain("AUTOMOBILE_VERSION=0.0.18");
    } finally {
      if (previousVersion === undefined) {
        delete process.env.AUTOMOBILE_VERSION;
      } else {
        process.env.AUTOMOBILE_VERSION = previousVersion;
      }
      if (previousSkip === undefined) {
        delete process.env.AUTOMOBILE_SKIP_ACCESSIBILITY_CHECKSUM;
      } else {
        process.env.AUTOMOBILE_SKIP_ACCESSIBILITY_CHECKSUM = previousSkip;
      }
    }
  });

  test("checksum skip prevents fail-closed status for an unreadable installed APK SHA", async () => {
    const previousVersion = process.env.AUTOMOBILE_VERSION;
    const previousSkip = process.env.AUTOMOBILE_SKIP_ACCESSIBILITY_CHECKSUM;
    process.env.AUTOMOBILE_VERSION = "0.0.18";
    process.env.AUTOMOBILE_SKIP_ACCESSIBILITY_CHECKSUM = "1";
    AndroidCtrlProxyManager.setExpectedChecksumForTesting("expected-sha");
    fakeAdb.setDevices([device("one")]);
    configureInstalled(fakeAdb);
    fakeAdb.setCommandResponse("shell pm path", { stdout: "", stderr: "" });
    try {
      const result = await checkCtrlProxy(fakeFactory);
      expect(result.status).not.toBe("fail");
      expect(result.message).toContain("versionStatus=skipped");
    } finally {
      if (previousVersion === undefined) {
        delete process.env.AUTOMOBILE_VERSION;
      } else {
        process.env.AUTOMOBILE_VERSION = previousVersion;
      }
      if (previousSkip === undefined) {
        delete process.env.AUTOMOBILE_SKIP_ACCESSIBILITY_CHECKSUM;
      } else {
        process.env.AUTOMOBILE_SKIP_ACCESSIBILITY_CHECKSUM = previousSkip;
      }
    }
  });

  test("abort after the first status read stops before accessibility reads", async () => {
    fakeAdb.setDevices([device("one"), device("two")]);
    const controller = new AbortController();
    fakeAdb.abortAfterCommand("shell pm list packages", controller);
    await checkCtrlProxy(fakeFactory, {}, { signal: controller.signal });
    expect(fakeAdb.getExecutedCommands()).toHaveLength(1);
  });

  test("caps unselected devices and reports omitted count", async () => {
    fakeAdb.setDevices(
      Array.from({ length: MAX_CTRL_PROXY_DOCTOR_DEVICES + 2 }, (_, i) => device(String(i))),
    );
    const result = await checkCtrlProxy(fakeFactory);
    expect(result.message).toContain("2 Android devices not checked (limit=8)");
    expect(result.message).not.toContain("device=8;");
  });

  test("aborts before reads and between devices", async () => {
    const controller = new AbortController();
    controller.abort();
    fakeAdb.setDevices([device("one"), device("two")]);
    await checkCtrlProxy(fakeFactory, {}, { signal: controller.signal });
    expect(fakeAdb.getExecutedCommands()).toEqual([]);
    const midway = new AbortController();
    const inspect = spyOn(
      AndroidCtrlProxyManager.prototype,
      "inspectCompatibility",
    ).mockImplementation(async () => {
      midway.abort();
      return {
        status: "compatible",
        expectedSha256: "sha",
        installedSha256: "sha",
        installedShaSource: "device",
        knownPinMismatch: false,
      };
    });
    try {
      await checkCtrlProxy(fakeFactory, {}, { signal: midway.signal });
      expect(inspect).toHaveBeenCalledTimes(1);
      expect(fakeAdb.getExecutedCommands()).toHaveLength(2);
    } finally {
      inspect.mockRestore();
    }
  });

  test("isolates a CtrlProxy device query failure and continues", async () => {
    AndroidCtrlProxyManager.setExpectedChecksumForTesting("expected-sha");
    fakeAdb.setDevices([device("one"), device("two")]);
    configureInstalled(fakeAdb, "expected-sha");
    const error = new Error("device query timed out");
    const installed = spyOn(AndroidCtrlProxyManager.prototype, "isInstalled").mockRejectedValueOnce(
      error,
    );
    const log = new FakeLogger();
    try {
      const result = await checkCtrlProxy(fakeFactory, { logger: log });
      expect(result.status).toBe("warn");
      expect(result.message).toContain("Could not check device=one: device query timed out");
      expect(result.message).toContain("device=two; installed=true; enabled=true");
      expect(result.recommendation).toContain("Re-run doctor");
      expect(log.at("warn")).toContainEqual({
        level: "warn",
        message: "CtrlProxy check failed for one: device query timed out",
        args: [error],
      });
    } finally {
      installed.mockRestore();
    }
  });

  test("fails for an actionable CtrlProxy device failure and continues", async () => {
    AndroidCtrlProxyManager.setExpectedChecksumForTesting("expected-sha");
    fakeAdb.setDevices([device("one"), device("two")]);
    configureInstalled(fakeAdb, "expected-sha");
    const error = new ActionableError("known pin could not be verified");
    const installed = spyOn(AndroidCtrlProxyManager.prototype, "isInstalled").mockRejectedValueOnce(
      error,
    );
    try {
      const result = await checkCtrlProxy(fakeFactory);
      expect(result.status).toBe("fail");
      expect(result.message).toContain(
        "Could not check device=one: known pin could not be verified",
      );
      expect(result.message).toContain("device=two; installed=true; enabled=true");
    } finally {
      installed.mockRestore();
    }
  });

  test("work profile reports different results for every device", async () => {
    fakeAdb.setDevices([device("one"), device("two")]);
    const one = new FakeAdbExecutor();
    one.setUsers([{ userId: 10, name: "Work", flags: 0x20, running: true }]);
    const two = new FakeAdbExecutor();
    two.setUsers([{ userId: 0, name: "Owner", flags: 0x13, running: true }]);
    const factory: AdbClientFactory = {
      create: (target) => (target ? (target.deviceId === "one" ? one : two) : fakeAdb),
    };
    const result = await checkWorkProfileAccessibility(factory);
    expect(result.status).toBe("warn");
    expect(result.message).toBe(
      "device=one; Accessibility service not enabled for work profile(s): Work (user 10) | device=two; No work profiles detected",
    );
    expect(result.recommendation).toContain("doctor only reports status");
    expect(one.getExecutedCommands()).toEqual([
      "shell settings --user 10 get secure enabled_accessibility_services",
    ]);
    expect(two.getExecutedCommands()).toEqual([]);
  });

  test("work profile isolates failed user and settings queries with a trace", async () => {
    for (const method of ["listUsers", "executeCommand"] as const) {
      fakeAdb.setDevices([device("one"), device("two")]);
      const one = new FakeAdbExecutor();
      one.setUsers([{ userId: 10, name: "Work", flags: 0x20, running: true }]);
      const two = new FakeAdbExecutor();
      two.setUsers([{ userId: 0, name: "Owner", flags: 0x13, running: true }]);
      const factory: AdbClientFactory = {
        create: (target) => (target ? (target.deviceId === "one" ? one : two) : fakeAdb),
      };
      const error = new Error("adb access denied");
      const query = spyOn(one, method).mockRejectedValue(error);
      const warn = spyOn(logger, "warn").mockImplementation(() => {});
      try {
        const result = await checkWorkProfileAccessibility(factory);
        expect(result.status).toBe("warn");
        expect(result.message).toBe(
          "Could not check device=one: adb access denied | device=two; No work profiles detected",
        );
        expect(result.recommendation).toContain("Re-run doctor");
        expect(warn).toHaveBeenCalledWith(
          "Work profile accessibility check failed for one: adb access denied",
          error,
        );
      } finally {
        query.mockRestore();
        warn.mockRestore();
      }
    }
  });

  test("work profile preserves empty and single-device wording with device identity", async () => {
    expect(await checkWorkProfileAccessibility(fakeFactory)).toEqual({
      name: "Work Profile Accessibility",
      status: "skip",
      message: "No Android devices connected",
    });
    fakeAdb.setDevices([device("one")]);
    fakeAdb.setUsers([{ userId: 0, name: "Owner", flags: 0x13, running: true }]);
    expect((await checkWorkProfileAccessibility(fakeFactory)).message).toBe(
      "device=one; No work profiles detected",
    );
    fakeAdb.setUsers([{ userId: 10, name: "Work", flags: 0x20, running: true }]);
    fakeAdb.setCommandResponse("shell settings --user 10", {
      stdout: AndroidCtrlProxyManager.PACKAGE,
      stderr: "",
    });
    expect((await checkWorkProfileAccessibility(fakeFactory)).message).toBe(
      "device=one; Accessibility service enabled for 1 work profile(s)",
    );
  });

  test("fails for an actionable work profile device failure and continues", async () => {
    fakeAdb.setDevices([device("one"), device("two")]);
    const one = new FakeAdbExecutor();
    const two = new FakeAdbExecutor();
    two.setUsers([{ userId: 0, name: "Owner", flags: 0x13, running: true }]);
    const factory: AdbClientFactory = {
      create: (target) => (target ? (target.deviceId === "one" ? one : two) : fakeAdb),
    };
    const error = new ActionableError("user listing could not be verified");
    const query = spyOn(one, "listUsers").mockRejectedValue(error);
    try {
      const result = await checkWorkProfileAccessibility(factory);
      expect(result.status).toBe("fail");
      expect(result.message).toContain(
        "Could not check device=one: user listing could not be verified",
      );
      expect(result.message).toContain("device=two; No work profiles detected");
    } finally {
      query.mockRestore();
    }
  });

  test("work profile caps devices and deduplicates recommendations", async () => {
    fakeAdb.setDevices(
      Array.from({ length: MAX_CTRL_PROXY_DOCTOR_DEVICES + 2 }, (_, i) => device(String(i))),
    );
    fakeAdb.setUsers([{ userId: 10, name: "Work", flags: 0x20, running: true }]);
    const users = spyOn(fakeAdb, "listUsers");
    try {
      const result = await checkWorkProfileAccessibility(fakeFactory);
      expect(result.status).toBe("warn");
      expect(result.message).toContain("2 Android devices not checked (limit=8)");
      expect(result.message).not.toContain("device=8;");
      expect(users).toHaveBeenCalledTimes(MAX_CTRL_PROXY_DOCTOR_DEVICES);
      expect(result.recommendation?.split("doctor only reports status")).toHaveLength(2);
    } finally {
      users.mockRestore();
    }
  });

  test("work profile abort and deadline during a device preserve outer cancellation handling", async () => {
    for (const error of [new Error("cancelled"), new DoctorDeadlineError()]) {
      fakeAdb.setDevices([device("one"), device("two")]);
      const controller = new AbortController();
      const users = spyOn(fakeAdb, "listUsers").mockImplementation(async () => {
        if (!(error instanceof DoctorDeadlineError)) {
          controller.abort(error);
        }
        throw error;
      });
      const warn = spyOn(logger, "warn").mockImplementation(() => {});
      try {
        const result = await checkWorkProfileAccessibility(fakeFactory, {
          signal: controller.signal,
        });
        expect(result.status).toBe("skip");
        expect(result.message).toBe(`Could not check: ${error.message}`);
        expect(users).toHaveBeenCalledTimes(1);
        expect(warn).toHaveBeenCalledWith(
          `Work profile accessibility check failed: ${error.message}`,
          error,
        );
      } finally {
        users.mockRestore();
        warn.mockRestore();
      }
    }
  });

  test("work profile recommendation does not claim doctor enables services", async () => {
    fakeAdb.setDevices([device("one")]);
    fakeAdb.setUsers([{ userId: 10, name: "Work", flags: 0x20, running: true }]);
    const result = await checkWorkProfileAccessibility(fakeFactory);
    expect(result.recommendation).toContain("doctor only reports status");
  });

  test("passes skip-env checks without reporting a stale CtrlProxy warning", async () => {
    AndroidCtrlProxyManager.setExpectedChecksumForTesting("expected-sha");
    const originalSkipDownload = process.env.AUTOMOBILE_SKIP_ACCESSIBILITY_DOWNLOAD_IF_INSTALLED;
    process.env.AUTOMOBILE_SKIP_ACCESSIBILITY_DOWNLOAD_IF_INSTALLED = "true";

    try {
      fakeAdb.setDevices([
        {
          deviceId: "emulator-5554",
          platform: "android",
          isEmulator: true,
          name: "Pixel",
        },
      ]);
      fakeAdb.setCommandResponse(`shell pm list packages ${AndroidCtrlProxyManager.PACKAGE}`, {
        stdout: `package:${AndroidCtrlProxyManager.PACKAGE}\n`,
        stderr: "",
      });
      fakeAdb.setCommandResponse("settings get secure", {
        stdout: `${AndroidCtrlProxyManager.PACKAGE}/${AndroidCtrlProxyManager.PACKAGE}.CtrlProxy`,
        stderr: "",
      });

      const result = await checkCtrlProxy(fakeFactory);

      expect(result.status).toBe("pass");
      expect(result.message).toContain("platform=android");
      expect(result.message).toContain("device=emulator-5554");
      expect(result.message).toContain("versionStatus=skipped");
      expect(result.message).not.toContain("acceptedPreinstalled=true");
      expect(result.recommendation).toBeUndefined();
    } finally {
      if (originalSkipDownload === undefined) {
        delete process.env.AUTOMOBILE_SKIP_ACCESSIBILITY_DOWNLOAD_IF_INSTALLED;
      } else {
        process.env.AUTOMOBILE_SKIP_ACCESSIBILITY_DOWNLOAD_IF_INSTALLED = originalSkipDownload;
      }
    }
  });
});

describe("post-repair read-only Android verification", () => {
  beforeEach(() => {
    AndroidCtrlProxyManager.resetInstances();
  });

  afterEach(() => {
    AndroidCtrlProxyManager.resetInstances();
  });

  test("keeps post-repair verification device-neutral", async () => {
    const commonDependencies = {
      checkDaemonStatus: async () => ({
        name: "Daemon Status",
        status: "pass" as const,
        message: "",
      }),
      checkDaemonConnectivity: async () => ({
        name: "Daemon Connectivity",
        status: "pass" as const,
        message: "",
      }),
      checkDaemonBuildIdentity: async () => ({
        name: "Daemon Build Identity",
        status: "pass" as const,
        message: "",
      }),
      checkCtrlProxy: async () => {
        throw new Error("post-repair verification must not inspect Android devices");
      },
      checkWorkProfileAccessibility: async () => {
        throw new Error("post-repair verification must not inspect Android profiles");
      },
    };

    await runPostRepairAutoMobileChecks({}, commonDependencies);
  });

  test("forwards the shared probe to post-repair build identity verification", async () => {
    const timer = new FakeTimer();
    const deadline = createDoctorDeadline({ timeoutMs: 50, timer }, timer);
    let receivedProbe: unknown;

    await runPostRepairAutoMobileChecks(deadline.probe, {
      checkDaemonStatus: async () => ({
        name: "Daemon Status",
        status: "pass",
        message: "",
      }),
      checkDaemonConnectivity: async () => ({
        name: "Daemon Connectivity",
        status: "pass",
        message: "",
      }),
      checkDaemonBuildIdentity: async (probe) => {
        receivedProbe = probe;
        return {
          name: "Daemon Build Identity",
          status: "pass",
          message: "",
        };
      },
    });
    deadline.dispose();

    expect(receivedProbe).toMatchObject({
      signal: deadline.probe.signal,
      deadlineMs: 50,
      timeoutMs: 50,
      timer,
    });
  });
});

describe("runAutoMobileChecks", () => {
  const stubChecks = {
    checkImageBackend: async () => ({
      name: "Image Backend",
      status: "pass" as const,
      message: "active=sharp; sharp=loaded",
    }),
    checkDaemonStatus: async () => ({
      name: "Daemon Status",
      status: "pass" as const,
      message: "Running (serving via socket)",
    }),
    checkDaemonConnectivity: async () => ({
      name: "Daemon Connectivity",
      status: "pass" as const,
      message: "Daemon is responsive",
    }),
    checkDaemonBuildIdentity: async () => ({
      name: "Daemon Build Identity",
      status: "pass" as const,
      message: "Build 1111111111111111 (/wt/dist/src/index.js)",
    }),
    checkOrphanedDaemons: async () => ({
      name: "Orphaned Daemons",
      status: "pass" as const,
      message: "No orphaned AutoMobile daemons found",
    }),
  };

  test("skips Android CtrlProxy diagnostics during iOS-only doctor runs", async () => {
    const results = await runAutoMobileChecks({ ios: true }, stubChecks);

    const ctrlProxy = results.find((result) => result.name === "CtrlProxy");

    expect(ctrlProxy?.status).toBe("skip");
    expect(ctrlProxy?.message).toBe("Skipped for iOS-only doctor run");
    expect(ctrlProxy?.message).not.toContain("emulator-5554");
  });

  test("includes the daemon build identity check", async () => {
    const results = await runAutoMobileChecks({ ios: true }, stubChecks);

    const buildIdentity = results.find((result) => result.name === "Daemon Build Identity");

    expect(buildIdentity).toBeDefined();
    expect(buildIdentity?.status).toBe("pass");
  });

  test("includes the image backend provisioning check", async () => {
    const results = await runAutoMobileChecks({ ios: true }, stubChecks);

    const imageBackend = results.find((result) => result.name === "Image Backend");

    expect(imageBackend).toBeDefined();
    expect(imageBackend?.status).toBe("pass");
    expect(imageBackend?.message).toBe("active=sharp; sharp=loaded");
  });

  const androidStubChecks = {
    ...stubChecks,
    checkCtrlProxy: async () => ({
      name: "CtrlProxy",
      status: "pass" as const,
      message: "platform=android; device=emulator-5554",
    }),
    checkWorkProfileAccessibility: async () => ({
      name: "Work Profile Accessibility",
      status: "warn" as const,
      message: "Work profile detected",
    }),
  };

  test("runs the Android CtrlProxy and work-profile checks for an Android run", async () => {
    const results = await runAutoMobileChecks({ android: true }, androidStubChecks);

    const ctrlProxy = results.find((result) => result.name === "CtrlProxy");
    const workProfile = results.find((result) => result.name === "Work Profile Accessibility");

    expect(ctrlProxy?.status).toBe("pass");
    expect(ctrlProxy?.message).toBe("platform=android; device=emulator-5554");
    expect(workProfile?.status).toBe("warn");
    expect(workProfile?.message).toBe("Work profile detected");
  });

  test("does not run the Android checks during an iOS-only run", async () => {
    let androidRan = false;
    const results = await runAutoMobileChecks(
      { ios: true },
      {
        ...androidStubChecks,
        checkCtrlProxy: async () => {
          androidRan = true;
          return { name: "CtrlProxy", status: "pass" as const, message: "should not run" };
        },
      },
    );

    expect(androidRan).toBe(false);
    expect(results.find((result) => result.name === "CtrlProxy")?.status).toBe("skip");
  });
});
