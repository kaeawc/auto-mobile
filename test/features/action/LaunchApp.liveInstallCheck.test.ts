import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { LaunchApp, amStartReportedFailure } from "../../../src/features/action/LaunchApp";
import { wrapCommandError } from "../../../src/utils/CommandError";
import {
  adbRejectionFromCapture,
  readAmStartCapture,
  type AmStartCaptureSection,
} from "../../helpers/androidAmStartCapture";
import type { BootedDevice, ObserveResult } from "../../../src/models";
import { getInstalledAppsCacheWriteCoordinator } from "../../../src/db/installedAppsCacheWriteCoordinator";
import { PortManager } from "../../../src/utils/PortManager";
import { FakeAdbExecutor } from "../../fakes/FakeAdbExecutor";
import { FakeAwaitIdle } from "../../fakes/FakeAwaitIdle";
import { FakeInstalledAppsProvider } from "../../fakes/FakeInstalledAppsProvider";
import { FakeInstalledAppsRepository } from "../../fakes/FakeInstalledAppsRepository";
import { FakeObserveScreen } from "../../fakes/FakeObserveScreen";
import { FakeTimer } from "../../fakes/FakeTimer";
import { FakeWindow } from "../../fakes/FakeWindow";

// #9976: a "not installed" verdict read from the installed-apps cache is confirmed
// with one live `pm list packages --user N` before launchApp fails.
describe("LaunchApp live install confirmation (#9976)", () => {
  const packageName = "com.example.fresh";
  const deviceId = "device-9976";
  const device: BootedDevice = { name: "test-device", platform: "android", deviceId };
  const listCommand = "shell pm list packages --user 0";
  let fakeAdb: FakeAdbExecutor;
  let fakeTimer: FakeTimer;
  let staleStore: FakeInstalledAppsRepository;
  let staled: string[];

  const observeResult = (appId: string): ObserveResult => ({
    updatedAt: 0,
    screenSize: { width: 1080, height: 1920 },
    systemInsets: { top: 0, bottom: 0, left: 0, right: 0 },
    viewHierarchy: { node: {} },
    activeWindow: { appId, activityName: "MainActivity", layoutSeqSum: 1 },
  });

  const createLaunchApp = (cachedApps: string[], appId: string = packageName): LaunchApp => {
    const action = new LaunchApp(device, fakeAdb, null, fakeTimer, {
      installedAppsProvider: new FakeInstalledAppsProvider(fakeTimer, {
        installedApps: cachedApps,
      }),
      installedAppsCacheStaleMarker: {
        markDeviceStale: async (id) => {
          staled.push(id);
          await staleStore.markDeviceStale(id);
        },
      },
    });
    const observeScreen = new FakeObserveScreen();
    observeScreen.setObserveResult(observeResult(appId));
    const window = new FakeWindow();
    window.configureCachedActiveWindow(null);
    window.configureActiveWindow({
      appId,
      activityName: "MainActivity",
      layoutSeqSum: 1,
    });
    action.awaitIdle = new FakeAwaitIdle();
    action.observeScreen = observeScreen;
    action.window = window;
    return action;
  };

  const listCommandCount = () =>
    fakeAdb.getExecutedCommands().filter((command) => command.includes("pm list packages")).length;
  const hasAmStart = () =>
    fakeAdb.getExecutedCommands().some((command) => command.includes("shell am start"));

  beforeEach(() => {
    PortManager.reset();
    PortManager.setPortAvailabilityCheckerForTesting({ isPortAvailable: () => true });
    fakeAdb = new FakeAdbExecutor();
    fakeTimer = new FakeTimer();
    fakeTimer.enableAutoAdvance();
    staleStore = new FakeInstalledAppsRepository();
    staled = [];
    fakeAdb.setForegroundApp({ packageName: "com.example.other", userId: 0 });
    fakeAdb.setCommandResponse("shell am start --user 0", {
      stdout: "Starting: Intent",
      stderr: "",
    });
  });

  afterEach(async () => {
    await getInstalledAppsCacheWriteCoordinator().releaseDevice(deviceId);
    PortManager.reset();
    PortManager.setPortAvailabilityCheckerForTesting(null);
  });

  test("launches an app the cache lacks but the device lists, and stales the cache", async () => {
    fakeAdb.setCommandResponse(listCommand, { stdout: `package:${packageName}\n`, stderr: "" });

    const result = await createLaunchApp(["com.example.cached"]).execute(packageName, false, false);

    expect(result.error).toBeUndefined();
    expect(result.success).toBe(true);
    expect(hasAmStart()).toBe(true);
    expect(staled).toEqual([deviceId]);
    expect(getInstalledAppsCacheWriteCoordinator().isDirty(deviceId)).toBe(true);
  });

  test("still reports App is not installed when the live read also lacks the package", async () => {
    fakeAdb.setCommandResponse(listCommand, {
      stdout: "package:com.example.cached\n",
      stderr: "",
    });

    const result = await createLaunchApp(["com.example.cached"]).execute(packageName, false, false);

    expect(result).toMatchObject({ success: false, error: "App is not installed" });
    expect(hasAmStart()).toBe(false);
    expect(listCommandCount()).toBe(1);
    expect(staled).toEqual([]);
  });

  test("a cache hit costs no live package listing", async () => {
    const result = await createLaunchApp([packageName]).execute(packageName, false, false);

    expect(result.success).toBe(true);
    expect(listCommandCount()).toBe(0);
    expect(getInstalledAppsCacheWriteCoordinator().isDirty(deviceId)).toBe(false);
  });

  test("a failed live read is reported as undetermined, not as absent", async () => {
    fakeAdb.setCommandError(listCommand, new Error("adb: device offline"));

    await expect(
      createLaunchApp(["com.example.cached"]).execute(packageName, false, false),
    ).rejects.toThrow(`Could not determine whether ${packageName} is installed`);
    expect(hasAmStart()).toBe(false);
  });

  // #10192: the mirror of the case above. The cache still lists an app that was removed
  // outside the tools, so the launcher intent is rejected and the fallbacks cannot help.
  //
  // The am/monkey output below is from real captures (test/fixtures/android-am-start, taken on
  // two emulators). They show `adb shell am start` and `monkey` EXIT NON-ZERO for a missing
  // package (1 and 252), and a non-zero `adb shell` exit rejects the AdbClient call, so the
  // failure arrives as a thrown error whose `stdout`/`stderr` carry the text, not as a
  // resolved result. The captures do not say which stream the text was on, so each case runs
  // against both.
  describe("an app removed outside the tools is still cached as installed (#10192)", () => {
    const missingPackage = "com.example.missing.pkg";
    // The capture's installed app: the playground, whose launcher activity is `.MainActivity`.
    const installedPackage = "dev.jasonpearson.automobile.playground";
    const launcherIntentCapture = readAmStartCapture(
      "am-start-missing-package-intent-emulator-5600.txt",
    );
    // `-W <pkg>` without `-p`: the bare-package argument shape LaunchApp sends.
    const launcherIntentFailure = launcherIntentCapture[1];
    const missingComponentFailure = readAmStartCapture(
      "am-start-missing-package-component-emulator-5600.txt",
    )[0];
    const wrongActivityFailure = readAmStartCapture(
      "am-start-installed-wrong-activity-emulator-5600.txt",
    )[0];
    const monkeyFailure = readAmStartCapture(
      "monkey-launcher-missing-package-emulator-5600.txt",
    )[0];

    const launcherIntentPattern = "shell am start --user 0 -a android.intent.action.MAIN";
    const componentPattern = "shell am start --user 0 -n";
    const adbCalls = (needle: string) =>
      fakeAdb.getExecutedCommands().filter((command) => command.includes(needle));

    /** Make the component guesses and monkey fail the way the captured device did. */
    const failFallbacks = (
      stream: "stdout" | "stderr",
      componentFailure: AmStartCaptureSection,
    ) => {
      fakeAdb.setCommandError(componentPattern, adbRejectionFromCapture(componentFailure, stream));
      fakeAdb.setCommandError("shell monkey", adbRejectionFromCapture(monkeyFailure, stream));
    };

    /** Make every launch command fail the way the captured device did. */
    const failLaunchCommands = (
      stream: "stdout" | "stderr",
      componentFailure: AmStartCaptureSection,
    ) => {
      fakeAdb.setCommandError(
        launcherIntentPattern,
        adbRejectionFromCapture(launcherIntentFailure, stream),
      );
      failFallbacks(stream, componentFailure);
    };

    test("the captures hold the failure facts the fix relies on", () => {
      expect(launcherIntentCapture.map((section) => section.exitCode)).toEqual([1, 1]);
      expect(launcherIntentFailure.output).toContain(
        "Error: Activity not started, unable to resolve",
      );
      expect(missingComponentFailure.exitCode).toBe(1);
      expect(missingComponentFailure.output).toContain("Error type 3");
      expect(wrongActivityFailure.exitCode).toBe(1);
      expect(wrongActivityFailure.output).toContain("Error type 3");
      expect(monkeyFailure.exitCode).toBe(252);
      expect(monkeyFailure.output).toContain("** No activities found to run, monkey aborted.");
    });

    test("the am-error classifier accepts every captured am failure form", () => {
      for (const section of [
        ...launcherIntentCapture,
        missingComponentFailure,
        wrongActivityFailure,
      ]) {
        expect(amStartReportedFailure(section.output, "")).toBe(true);
        expect(amStartReportedFailure("", section.output)).toBe(true);
      }
      // The echoed `Starting: Intent { ... pkg=... }` line alone is not a failure.
      const echoedIntent = launcherIntentFailure.output.split("\n")[0];
      expect(echoedIntent).toStartWith("Starting: Intent");
      expect(amStartReportedFailure(echoedIntent, "")).toBe(false);
    });

    // The two "Error type 3" captures are the same text apart from the class: a missing package
    // and an installed one with the wrong activity both say the class "does not exist". Only the
    // live package listing tells them apart, which is why the fail-fast check reads it.
    test("missing-package and wrong-activity component errors share one form", () => {
      const errorForm = (output: string) => output.replace(/\{[^}]*\}/g, "{...}");
      expect(errorForm(missingComponentFailure.output).split("\n").slice(1)).toEqual(
        errorForm(wrongActivityFailure.output).split("\n").slice(1),
      );
    });

    test.each(["stdout", "stderr"] as const)(
      "the first call fails fast with App is not installed when the launcher intent exits 1 (%s)",
      async (stream) => {
        failLaunchCommands(stream, missingComponentFailure);
        fakeAdb.setCommandResponse(listCommand, {
          stdout: "package:com.example.cached\n",
          stderr: "",
        });

        const result = await createLaunchApp([missingPackage], missingPackage).execute(
          missingPackage,
          false,
          false,
        );

        expect(result).toMatchObject({
          success: false,
          packageName: missingPackage,
          userId: 0,
          error: "App is not installed",
        });
        // One launcher intent, one live listing; no monkey, discovery, patterns or final intent.
        expect(adbCalls("shell am start")).toHaveLength(1);
        expect(listCommandCount()).toBe(1);
        expect(adbCalls("shell monkey")).toHaveLength(0);
        expect(adbCalls("query-activities")).toHaveLength(0);
        expect(adbCalls("pm dump")).toHaveLength(0);
        expect(staled).toEqual([deviceId]);
        expect(getInstalledAppsCacheWriteCoordinator().isDirty(deviceId)).toBe(true);
      },
    );

    test("an older adb that returns the am error with exit 0 fails fast the same way", async () => {
      // Same key as the suite default, so this replaces it for every `am start`.
      fakeAdb.setCommandResponse("shell am start --user 0", {
        stdout: launcherIntentFailure.output,
        stderr: "",
      });
      fakeAdb.setCommandResponse(listCommand, {
        stdout: "package:com.example.cached\n",
        stderr: "",
      });

      const result = await createLaunchApp([missingPackage], missingPackage).execute(
        missingPackage,
        false,
        false,
      );

      expect(result).toMatchObject({ success: false, error: "App is not installed" });
      expect(adbCalls("shell am start")).toHaveLength(1);
      expect(listCommandCount()).toBe(1);
    });

    test("an installed app without a launcher activity still runs every fallback", async () => {
      // The launcher-intent text for an installed app that has no launcher activity was not
      // captured; the missing-package capture is the same `unable to resolve Intent` form, and
      // the live listing is what tells the two apart. The component guesses fail with the
      // captured installed-app wrong-activity text.
      failLaunchCommands("stderr", wrongActivityFailure);
      fakeAdb.setCommandResponse(listCommand, {
        stdout: `package:${installedPackage}\n`,
        stderr: "",
      });

      await expect(
        createLaunchApp([installedPackage], installedPackage).execute(
          installedPackage,
          false,
          false,
        ),
      ).rejects.toThrow("No launcher activity found and launcher intent failed");

      expect(listCommandCount()).toBe(1);
      expect(adbCalls("shell monkey")).toHaveLength(1);
      // launcher intent, six common component guesses, final launcher intent
      expect(adbCalls("shell am start")).toHaveLength(8);
      expect(staled).toEqual([]);
    });

    test("an unreadable live listing neither fails the launch nor skips the fallbacks", async () => {
      failLaunchCommands("stderr", missingComponentFailure);
      fakeAdb.setCommandError(listCommand, new Error("adb: device offline"));

      await expect(
        createLaunchApp([missingPackage], missingPackage).execute(missingPackage, false, false),
      ).rejects.toThrow("No launcher activity found and launcher intent failed");

      expect(adbCalls("shell monkey")).toHaveLength(1);
      expect(staled).toEqual([]);
    });

    test("a launcher intent that fails without am output never reads the live listing", async () => {
      // A transport failure (no stdout/stderr of its own) says nothing about the package.
      fakeAdb.setCommandError(launcherIntentPattern, new Error("adb: device offline"));
      failFallbacks("stderr", wrongActivityFailure);

      await expect(
        createLaunchApp([installedPackage], installedPackage).execute(
          installedPackage,
          false,
          false,
        ),
      ).rejects.toThrow("No launcher activity found and launcher intent failed");

      expect(listCommandCount()).toBe(0);
    });

    test("the echoed command line of a failed launch is not treated as am output", async () => {
      // `Command failed: adb shell am start ... <pkg>` names the package; a package called
      // "Error.example" must not be read as an am error.
      const hostile = "Error.example";
      fakeAdb.setCommandError(
        launcherIntentPattern,
        wrapCommandError(
          Object.assign(new Error(`Command failed: adb shell am start ${hostile}`), {
            code: 255,
            stdout: "",
            stderr: "adb: device offline",
          }),
          { command: "adb", args: ["shell", "am", "start", hostile] },
        ),
      );
      failFallbacks("stderr", wrongActivityFailure);

      await expect(
        createLaunchApp([hostile], hostile).execute(hostile, false, false),
      ).rejects.toThrow("No launcher activity found and launcher intent failed");

      expect(listCommandCount()).toBe(0);
    });

    test("a launcher intent that succeeds never pays for a live listing", async () => {
      fakeAdb.setCommandResponse("shell am start --user 0", {
        stdout: "Starting: Intent",
        stderr: "",
      });

      const result = await createLaunchApp([packageName]).execute(packageName, false, false);

      expect(result.success).toBe(true);
      expect(listCommandCount()).toBe(0);
      expect(staled).toEqual([]);
    });
  });
});
