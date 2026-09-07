import { describe, test, expect, beforeEach } from "bun:test";
import {
  resolveConfiguredHomePackage,
  clearResolvedHomePackageCache,
  isFallbackLauncherPackage,
  isForegroundLauncher,
} from "../../../src/features/observe/androidLauncherPackages";
import { FakeAdbExecutor } from "../../fakes/FakeAdbExecutor";
import { FakeTimer } from "../../fakes/FakeTimer";

const RESOLVE_HOME_PATTERN = "resolve-activity";

describe("androidLauncherPackages", () => {
  let fakeAdb: FakeAdbExecutor;

  beforeEach(() => {
    fakeAdb = new FakeAdbExecutor();
    clearResolvedHomePackageCache();
  });

  describe("resolveConfiguredHomePackage", () => {
    test("parses the package name out of resolve-activity --brief output", async () => {
      fakeAdb.setCommandResponse(RESOLVE_HOME_PATTERN, {
        stdout:
          "priority=0 preferredOrder=0 match=0x108000 specificIndex=-1 isDefault=true\ncom.example.launcher/.LauncherActivity",
        stderr: "",
      });

      const result = await resolveConfiguredHomePackage(fakeAdb, "device-1");

      expect(result).toBe("com.example.launcher");
    });

    test("returns null when the device cannot resolve a HOME launcher", async () => {
      fakeAdb.setCommandResponse(RESOLVE_HOME_PATTERN, { stdout: "", stderr: "" });

      const result = await resolveConfiguredHomePackage(fakeAdb, "device-1");

      expect(result).toBeNull();
    });

    test("returns null (not throw) when the resolve command errors", async () => {
      fakeAdb.setCommandError(RESOLVE_HOME_PATTERN, new Error("adb unavailable"));

      const result = await resolveConfiguredHomePackage(fakeAdb, "device-1");

      expect(result).toBeNull();
    });

    test("caches a successful resolution per device, without re-querying", async () => {
      fakeAdb.setCommandResponse(RESOLVE_HOME_PATTERN, {
        stdout: "com.example.launcher/.LauncherActivity",
        stderr: "",
      });

      const first = await resolveConfiguredHomePackage(fakeAdb, "device-1");
      const queriesAfterFirst = fakeAdb
        .getExecutedCommands()
        .filter((cmd) => cmd.includes(RESOLVE_HOME_PATTERN)).length;
      const second = await resolveConfiguredHomePackage(fakeAdb, "device-1");
      const queriesAfterSecond = fakeAdb
        .getExecutedCommands()
        .filter((cmd) => cmd.includes(RESOLVE_HOME_PATTERN)).length;

      expect(first).toBe("com.example.launcher");
      expect(second).toBe("com.example.launcher");
      expect(queriesAfterFirst).toBe(1);
      expect(queriesAfterSecond).toBe(1);
    });

    test("does not cache a failed resolution -- a later call retries", async () => {
      fakeAdb.setCommandError(RESOLVE_HOME_PATTERN, new Error("transient failure"));
      const first = await resolveConfiguredHomePackage(fakeAdb, "device-1");
      expect(first).toBeNull();

      // A fresh executor stands in for "the device's resolve call now
      // succeeds" -- the cache is only keyed by deviceId, so if the earlier
      // failure had been (incorrectly) cached, this call would return null
      // without ever reaching the new executor.
      const recoveredAdb = new FakeAdbExecutor();
      recoveredAdb.setCommandResponse(RESOLVE_HOME_PATTERN, {
        stdout: "com.example.launcher/.LauncherActivity",
        stderr: "",
      });
      const second = await resolveConfiguredHomePackage(recoveredAdb, "device-1");
      expect(second).toBe("com.example.launcher");
    });

    test("caches per-device independently", async () => {
      fakeAdb.setCommandResponse(RESOLVE_HOME_PATTERN, {
        stdout: "com.example.launcher/.LauncherActivity",
        stderr: "",
      });
      const deviceOne = await resolveConfiguredHomePackage(fakeAdb, "device-1");

      const otherAdb = new FakeAdbExecutor();
      otherAdb.setCommandResponse(RESOLVE_HOME_PATTERN, {
        stdout: "com.miui.home/.Launcher",
        stderr: "",
      });
      const deviceTwo = await resolveConfiguredHomePackage(otherAdb, "device-2");

      expect(deviceOne).toBe("com.example.launcher");
      expect(deviceTwo).toBe("com.miui.home");
    });
  });

  // A process-lifetime cache means a user who changes their default HOME app
  // never sees it reflected until the daemon restarts. A bounded TTL fixes
  // that.
  describe("resolveConfiguredHomePackage cache TTL", () => {
    test("serves the cached package within the TTL window", async () => {
      const fakeTimer = new FakeTimer();
      fakeTimer.setCurrentTime(0);
      fakeAdb.setCommandResponse(RESOLVE_HOME_PATTERN, {
        stdout: "com.launcher.a/.Main",
        stderr: "",
      });

      const first = await resolveConfiguredHomePackage(fakeAdb, "device-1", fakeTimer);
      fakeTimer.setCurrentTime(29_000);
      const second = await resolveConfiguredHomePackage(fakeAdb, "device-1", fakeTimer);

      expect(first).toBe("com.launcher.a");
      expect(second).toBe("com.launcher.a");
      expect(
        fakeAdb.getExecutedCommands().filter((cmd) => cmd.includes(RESOLVE_HOME_PATTERN)).length,
      ).toBe(1);
    });

    test("re-resolves a changed default HOME launcher once the TTL expires", async () => {
      const fakeTimer = new FakeTimer();
      fakeTimer.setCurrentTime(0);
      fakeAdb.setCommandResponse(RESOLVE_HOME_PATTERN, {
        stdout: "com.launcher.a/.Main",
        stderr: "",
      });
      const first = await resolveConfiguredHomePackage(fakeAdb, "device-1", fakeTimer);

      // The user changes their default HOME app while the daemon keeps
      // running.
      fakeAdb.setCommandResponse(RESOLVE_HOME_PATTERN, {
        stdout: "com.launcher.b/.Main",
        stderr: "",
      });
      fakeTimer.setCurrentTime(30_001);
      const second = await resolveConfiguredHomePackage(fakeAdb, "device-1", fakeTimer);

      expect(first).toBe("com.launcher.a");
      expect(second).toBe("com.launcher.b");
      expect(
        fakeAdb.getExecutedCommands().filter((cmd) => cmd.includes(RESOLVE_HOME_PATTERN)).length,
      ).toBe(2);
    });

    test("isForegroundLauncher accepts the new launcher once the TTL expires", async () => {
      const fakeTimer = new FakeTimer();
      fakeTimer.setCurrentTime(0);
      fakeAdb.setCommandResponse(RESOLVE_HOME_PATTERN, {
        stdout: "com.launcher.a/.Main",
        stderr: "",
      });
      expect(await isForegroundLauncher("com.launcher.a", fakeAdb, "device-1", fakeTimer)).toBe(
        true,
      );
      expect(await isForegroundLauncher("com.launcher.b", fakeAdb, "device-1", fakeTimer)).toBe(
        false,
      );

      fakeAdb.setCommandResponse(RESOLVE_HOME_PATTERN, {
        stdout: "com.launcher.b/.Main",
        stderr: "",
      });
      // Still within the TTL -- the stale cached value ("a") is still served.
      fakeTimer.setCurrentTime(10_000);
      expect(await isForegroundLauncher("com.launcher.b", fakeAdb, "device-1", fakeTimer)).toBe(
        false,
      );

      // Past the TTL -- the new default HOME launcher ("b") is now accepted.
      fakeTimer.setCurrentTime(30_001);
      expect(await isForegroundLauncher("com.launcher.b", fakeAdb, "device-1", fakeTimer)).toBe(
        true,
      );
      expect(await isForegroundLauncher("com.launcher.a", fakeAdb, "device-1", fakeTimer)).toBe(
        false,
      );
    });
  });

  // Android serials are reused across connection epochs (see
  // `daemon/deviceSessionRegistry.ts`), so a cache keyed by `deviceId` alone
  // serves a reincarnated device's launcher from the PREVIOUS incarnation on
  // the same serial (e.g. a new AVD taking over `emulator-5554` within the
  // TTL). Including an incarnation token in the key makes a reincarnation a
  // cache miss instead.
  describe("incarnation-aware cache key", () => {
    test("re-resolves instead of serving the stale entry when the incarnation token changes on the same deviceId", async () => {
      fakeAdb.setCommandResponse(RESOLVE_HOME_PATTERN, {
        stdout: "com.example.launcher/.LauncherActivity",
        stderr: "",
      });
      const first = await resolveConfiguredHomePackage(
        fakeAdb,
        "emulator-5554",
        undefined,
        "epoch-1",
      );
      expect(first).toBe("com.example.launcher");

      // A fresh AVD reincarnates the same serial within the TTL, with a
      // different configured HOME launcher.
      const reincarnatedAdb = new FakeAdbExecutor();
      reincarnatedAdb.setCommandResponse(RESOLVE_HOME_PATTERN, {
        stdout: "com.other.launcher/.Main",
        stderr: "",
      });
      const second = await resolveConfiguredHomePackage(
        reincarnatedAdb,
        "emulator-5554",
        undefined,
        "epoch-2",
      );

      expect(second).toBe("com.other.launcher");
      // The re-resolution must actually have queried the new incarnation's
      // executor rather than serving the cached "epoch-1" package.
      expect(
        reincarnatedAdb.getExecutedCommands().filter((cmd) => cmd.includes(RESOLVE_HOME_PATTERN))
          .length,
      ).toBe(1);
    });

    test("still serves the cache within the TTL when the incarnation token is unchanged", async () => {
      fakeAdb.setCommandResponse(RESOLVE_HOME_PATTERN, {
        stdout: "com.example.launcher/.LauncherActivity",
        stderr: "",
      });
      await resolveConfiguredHomePackage(fakeAdb, "emulator-5554", undefined, "epoch-1");
      const second = await resolveConfiguredHomePackage(
        fakeAdb,
        "emulator-5554",
        undefined,
        "epoch-1",
      );

      expect(second).toBe("com.example.launcher");
      expect(
        fakeAdb.getExecutedCommands().filter((cmd) => cmd.includes(RESOLVE_HOME_PATTERN)).length,
      ).toBe(1);
    });

    test("isForegroundLauncher rejects the previous incarnation's launcher after a reincarnation", async () => {
      fakeAdb.setCommandResponse(RESOLVE_HOME_PATTERN, {
        stdout: "com.example.launcher/.LauncherActivity",
        stderr: "",
      });
      expect(
        await isForegroundLauncher(
          "com.example.launcher",
          fakeAdb,
          "emulator-5554",
          undefined,
          "epoch-1",
        ),
      ).toBe(true);

      const reincarnatedAdb = new FakeAdbExecutor();
      reincarnatedAdb.setCommandResponse(RESOLVE_HOME_PATTERN, {
        stdout: "com.other.launcher/.Main",
        stderr: "",
      });
      // Same appId as before, but the new incarnation's configured launcher
      // is different -- must not still match on the stale "epoch-1" entry.
      expect(
        await isForegroundLauncher(
          "com.example.launcher",
          reincarnatedAdb,
          "emulator-5554",
          undefined,
          "epoch-2",
        ),
      ).toBe(false);
      expect(
        await isForegroundLauncher(
          "com.other.launcher",
          reincarnatedAdb,
          "emulator-5554",
          undefined,
          "epoch-2",
        ),
      ).toBe(true);
    });
  });

  describe("isFallbackLauncherPackage", () => {
    test("matches a known launcher package exactly", () => {
      expect(isFallbackLauncherPackage("com.android.launcher3")).toBe(true);
      expect(isFallbackLauncherPackage("com.android.launcher")).toBe(true);
    });

    test("rejects an unrelated package that merely shares a prefix", () => {
      // Regression: the prior implementation matched by prefix, so
      // "com.android.launcher3.example" was misclassified as a launcher.
      expect(isFallbackLauncherPackage("com.android.launcher3.example")).toBe(false);
    });

    test("rejects null/undefined/empty", () => {
      expect(isFallbackLauncherPackage(null)).toBe(false);
      expect(isFallbackLauncherPackage(undefined)).toBe(false);
      expect(isFallbackLauncherPackage("")).toBe(false);
    });
  });

  describe("isForegroundLauncher", () => {
    test("matches the resolved configured HOME package exactly", async () => {
      fakeAdb.setCommandResponse(RESOLVE_HOME_PATTERN, {
        stdout: "com.oem.customlauncher/.Main",
        stderr: "",
      });

      // A device whose selected HOME app is outside the old hardcoded list
      // (issue #6147 review, P1) must still verify successfully.
      expect(await isForegroundLauncher("com.oem.customlauncher", fakeAdb, "device-1")).toBe(true);
      expect(await isForegroundLauncher("com.oem.customlauncher.decoy", fakeAdb, "device-1")).toBe(
        false,
      );
      expect(await isForegroundLauncher("com.android.launcher3", fakeAdb, "device-1")).toBe(false);
    });

    test("falls back to the known-launcher list when resolution fails", async () => {
      fakeAdb.setCommandError(RESOLVE_HOME_PATTERN, new Error("cmd package unavailable"));

      expect(await isForegroundLauncher("com.android.launcher3", fakeAdb, "device-1")).toBe(true);
      expect(await isForegroundLauncher("com.some.other.app", fakeAdb, "device-1")).toBe(false);
    });

    test("returns false for a falsy appId without resolving", async () => {
      expect(await isForegroundLauncher(null, fakeAdb, "device-1")).toBe(false);
      expect(fakeAdb.getExecutedCommands()).toEqual([]);
    });
  });
});
