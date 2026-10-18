import { describe, expect, test } from "bun:test";
import {
  captureScreen,
  describeAppBuild,
  describeDevice,
  bootedIosSimulators,
  parseOnlineSerials,
  resolveSerial,
  runPreflight,
  screenTextForApp,
  sharedPreferencesXml,
} from "../../../scripts/agent-benchmark/device";
import { FakeCommandRunner } from "./fakeCommandRunner";

const DEVICES = "List of devices attached\nemulator-5554\tdevice\nemulator-5556\toffline\n\n";
const PACKAGE = "dev.example.app";

function preflightSpec(overrides: Partial<Parameters<typeof runPreflight>[1]> = {}) {
  return {
    serial: "emulator-5554",
    packageName: PACKAGE,
    clearAppData: true,
    stageFile: (name: string) => `/run/preflight/${name}`,
    ...overrides,
  };
}

describe("agent benchmark device selection", () => {
  test("only fully online devices count", () => {
    expect(parseOnlineSerials(DEVICES)).toEqual(["emulator-5554"]);
    expect(parseOnlineSerials("List of devices attached\n")).toEqual([]);
  });

  test("exactly one online device is required; --device only asserts which", async () => {
    expect(await resolveSerial(new FakeCommandRunner().onAdb("devices", { stdout: DEVICES }))).toBe(
      "emulator-5554",
    );
    await expect(resolveSerial(new FakeCommandRunner())).rejects.toThrow(
      /No online Android device/,
    );
    const two = new FakeCommandRunner().onAdb("devices", {
      stdout: "List of devices attached\na\tdevice\nb\tdevice\n",
    });
    await expect(resolveSerial(two)).rejects.toThrow(/Multiple online devices \(a, b\)/);
    await expect(resolveSerial(two, "b")).rejects.toThrow(/needs exactly one/);
    const one = new FakeCommandRunner().onAdb("devices", {
      stdout: "List of devices attached\na\tdevice\n",
    });
    expect(await resolveSerial(one, "a")).toBe("a");
    await expect(resolveSerial(one, "c")).rejects.toThrow(
      /Device c is not the online device \(a\)/,
    );
  });

  test("booted iOS simulators are found on macOS; other hosts have none", async () => {
    const booted = new FakeCommandRunner().on("xcrun", () => ({
      stdout: JSON.stringify({
        devices: {
          "com.apple.CoreSimulator.SimRuntime.iOS-26-0": [
            { name: "iPhone 17", state: "Booted" },
            { name: "iPad", state: "Shutdown" },
          ],
        },
      }),
    }));
    expect(await bootedIosSimulators(booted, "darwin")).toEqual(["iPhone 17"]);
    expect(await bootedIosSimulators(booted, "linux")).toEqual([]);
    expect(booted.calls).toHaveLength(1);
  });

  test("a failed simulator scan on macOS throws instead of reading as none", async () => {
    const missing = new FakeCommandRunner().on("xcrun", () => {
      throw new Error("spawnSync xcrun ENOENT");
    });
    await expect(bootedIosSimulators(missing, "darwin")).rejects.toThrow(
      /Could not list iOS simulators \(spawnSync xcrun ENOENT\)/,
    );
    const failing = new FakeCommandRunner().on("xcrun", () => ({
      exitCode: 1,
      stderr: "CoreSimulator is out of date\n",
    }));
    await expect(bootedIosSimulators(failing, "darwin")).rejects.toThrow(
      /exit 1: CoreSimulator is out of date/,
    );
    const garbled = new FakeCommandRunner().on("xcrun", () => ({ stdout: "not json" }));
    await expect(bootedIosSimulators(garbled, "darwin")).rejects.toThrow(/unparseable output/);
    for (const stdout of ["{}", "null", '{"devices":[]}', '{"devices":{"ios":{}}}']) {
      const malformed = new FakeCommandRunner().on("xcrun", () => ({ stdout }));
      await expect(bootedIosSimulators(malformed, "darwin")).rejects.toThrow(/no devices map/);
    }
    for (const stdout of ['{"devices":{"iOS":[{"name":"Phone"}]}}', '{"devices":{"iOS":[null]}}']) {
      const partial = new FakeCommandRunner().on("xcrun", () => ({ stdout }));
      await expect(bootedIosSimulators(partial, "darwin")).rejects.toThrow(
        /a simulator record has no state/,
      );
    }
    const none = new FakeCommandRunner().on("xcrun", () => ({ stdout: '{"devices":{}}' }));
    expect(await bootedIosSimulators(none, "darwin")).toEqual([]);
  });

  test("adb failures surface the command and its output", async () => {
    const runner = new FakeCommandRunner().onAdb("devices", {
      exitCode: 1,
      stderr: "no adb server",
    });
    await expect(resolveSerial(runner)).rejects.toThrow(
      /adb devices failed \(exit 1\): no adb server/,
    );
  });
});

describe("agent benchmark preflight", () => {
  test("resets the app, seeds preferences, then deep-links to the start screen", async () => {
    const runner = new FakeCommandRunner()
      .onAdb("pm path", { stdout: `package:/data/app/${PACKAGE}/base.apk` })
      .onAdb("pm clear", { stdout: "Success\n" });
    const { log, appBuild } = await runPreflight(
      runner,
      preflightSpec({
        apkPath: "/repo/app.apk",
        sharedPreferences: { onboarding_prefs: { onboarding_completed: true } },
        launchUri: "example:app/screen",
      }),
    );
    const s = "-s emulator-5554";
    expect(runner.adbCalls()).toEqual([
      `${s} shell am get-current-user`,
      `${s} install -r -t /repo/app.apk`,
      `${s} shell pm path ${PACKAGE}`,
      `${s} shell dumpsys package ${PACKAGE}`,
      `${s} shell am force-stop ${PACKAGE}`,
      `${s} shell pm clear ${PACKAGE}`,
      `${s} shell run-as ${PACKAGE} mkdir -p shared_prefs`,
      `${s} push /run/preflight/onboarding_prefs.xml /data/local/tmp/agent-benchmark-onboarding_prefs.xml`,
      `${s} shell run-as ${PACKAGE} cp /data/local/tmp/agent-benchmark-onboarding_prefs.xml shared_prefs/onboarding_prefs.xml`,
      `${s} shell rm -f /data/local/tmp/agent-benchmark-onboarding_prefs.xml`,
      `${s} shell am start -W -a android.intent.action.VIEW -d 'example:app/screen' ${PACKAGE}`,
    ]);
    expect(appBuild).toBe("unknown");
    expect(log).toEqual([
      "installed /repo/app.apk",
      "app build: unknown",
      `force-stopped ${PACKAGE}`,
      `cleared app data for ${PACKAGE}`,
      "seeded shared_prefs/onboarding_prefs.xml (onboarding_completed)",
      "launched example:app/screen",
    ]);
  });

  test("keeps app data when asked and skips optional steps", async () => {
    const runner = new FakeCommandRunner().onAdb("pm path", { stdout: "package:/x.apk" });
    await runPreflight(runner, preflightSpec({ clearAppData: false }));
    expect(runner.adbCalls()).toEqual([
      "-s emulator-5554 shell am get-current-user",
      `-s emulator-5554 shell pm path ${PACKAGE}`,
      `-s emulator-5554 shell dumpsys package ${PACKAGE}`,
      `-s emulator-5554 shell am force-stop ${PACKAGE}`,
    ]);
  });

  test("the deep link reaches the device shell as one quoted argument", async () => {
    const runner = new FakeCommandRunner()
      .onAdb("pm path", { stdout: "package:/x.apk" })
      .onAdb("pm clear", { stdout: "Success\n" });
    await runPreflight(runner, preflightSpec({ launchUri: "example:app/search?q=a b&x=$HOME" }));
    expect(runner.adbCalls().at(-1)).toBe(
      `-s emulator-5554 shell am start -W -a android.intent.action.VIEW -d 'example:app/search?q=a b&x=$HOME' ${PACKAGE}`,
    );
  });

  test("the device fingerprint reads SDK, model, locale, and the effective size/density", async () => {
    const runner = new FakeCommandRunner()
      .onAdb("getprop", {
        stdout:
          "36\nsdk_gphone64_arm64\nen-US\nBP22.250221.010\ncom.google.android.marvin.talkback/com.google.android.marvin.talkback.TalkBackService\n2\ncom.example.ime/.Ime\nAmerica/New_York\n24\nPhysical size: 1080x2400\nOverride size: 720x1600\nPhysical density: 420\n1.15\n0.5\nnull\n0\nNight mode: yes\n",
      })
      .onAdb("dumpsys window displays", { stdout: "  mRotation=1\n" });
    expect(await describeDevice(runner, "emulator-5554")).toBe(
      "sdk=36 model=sdk_gphone64_arm64 locale=en-US build=BP22.250221.010 a11y=com.google.android.marvin.talkback/com.google.android.marvin.talkback.TalkBackService nav=gesture ime=com.example.ime/.Ime tz=America/New_York clock=24 size=720x1600 density=420 font=1.15 anim=0.5/1/0 theme=dark rotation=1",
    );
    // wm size reports the natural size in any orientation, so rotation tells the two apart.
    runner.onAdb("dumpsys window displays", { stdout: "  mRotation=0\n" });
    expect(await describeDevice(runner, "emulator-5554")).toContain("rotation=0");
    runner.onAdb("dumpsys window", { exitCode: 1, stderr: "dumpsys failed" });
    expect(await describeDevice(runner, "emulator-5554")).toBe("unknown");
    expect(await describeDevice(new FakeCommandRunner(), "emulator-5554")).toBe("unknown");
    // The locale falls back to ro.product.locale on the device, in one line.
    expect(
      runner
        .adbCalls()
        .some((call) =>
          call.includes(
            'l=$(getprop persist.sys.locale); echo "${l:-$(getprop ro.product.locale)}"',
          ),
        ),
    ).toBe(true);
  });

  test("the app build fingerprint comes from dumpsys package", () => {
    const dumpsys = [
      "Packages:",
      "  Package [dev.example.app] (abc):",
      "    versionCode=42 minSdk=26 targetSdk=36",
      "    versionName=1.2.3",
      "    lastUpdateTime=2026-10-16 10:00:00",
    ].join("\n");
    expect(describeAppBuild(dumpsys)).toBe(
      "versionName=1.2.3 versionCode=42 lastUpdateTime=2026-10-16 10:00:00",
    );
    expect(describeAppBuild("")).toBe("unknown");
    // Versions alone (no install time, no digest) cannot tell two local rebuilds apart.
    expect(describeAppBuild("versionCode=42\n    versionName=1.2.3\n")).toBe("unknown");
    expect(describeAppBuild(dumpsys, "0123456789abcdef")).toBe(
      "versionName=1.2.3 versionCode=42 sha256=0123456789abcdef",
    );
  });

  test("an apkPath install is checked against the installed base APK", async () => {
    const digest = "a".repeat(64);
    const pmPath = `package:/data/app/~~x/${PACKAGE}-1/base.apk\npackage:/data/app/~~x/${PACKAGE}-1/split_config.en.apk\n`;
    const matching = new FakeCommandRunner()
      .onAdb("pm path", { stdout: pmPath })
      .onAdb("pm clear", { stdout: "Success\n" })
      .onAdb("sha256sum", { stdout: `${digest}  /data/app/~~x/${PACKAGE}-1/base.apk\n` });
    const { log } = await runPreflight(
      matching,
      preflightSpec({ apkPath: "/repo/app.apk", apkDigest: digest }),
    );
    expect(matching.adbCalls()).toContain(
      `-s emulator-5554 shell sha256sum '/data/app/~~x/${PACKAGE}-1/base.apk'`,
    );
    expect(log).toContain(`verified ${PACKAGE} is /repo/app.apk`);

    const stale = new FakeCommandRunner()
      .onAdb("pm path", { stdout: pmPath })
      .onAdb("sha256sum", { stdout: `${"b".repeat(64)}  base.apk\n` });
    await expect(
      runPreflight(stale, preflightSpec({ apkPath: "/repo/other.apk", apkDigest: digest })),
    ).rejects.toThrow(/is not the APK at \/repo\/other.apk; check that app.apkPath builds/);
    expect(stale.adbCalls().some((call) => call.includes("pm clear"))).toBe(false);

    const noSha = new FakeCommandRunner()
      .onAdb("pm path", { stdout: pmPath })
      .onAdb("pm clear", { stdout: "Success\n" })
      .onAdb("sha256sum", { exitCode: 127, stderr: "sha256sum: not found" });
    // Fail closed: an unverified install could be a stale app under this APK's digest.
    await expect(
      runPreflight(noSha, preflightSpec({ apkPath: "/repo/app.apk", apkDigest: digest })),
    ).rejects.toThrow(/Cannot verify .* \(sha256sum exited 127: sha256sum: not found\)/);
    expect(noSha.adbCalls().some((call) => call.includes("pm clear"))).toBe(false);

    const noBase = new FakeCommandRunner().onAdb("pm path", { stdout: "package:/x/app.apk\n" });
    await expect(
      runPreflight(noBase, preflightSpec({ apkPath: "/repo/app.apk", apkDigest: digest })),
    ).rejects.toThrow(/pm path listed no base.apk/);
  });

  test("a pm clear that does not report Success stops the run before seeding", async () => {
    const runner = new FakeCommandRunner()
      .onAdb("pm path", { stdout: "package:/x.apk" })
      .onAdb("pm clear", { stdout: "Failed\n" });
    await expect(
      runPreflight(runner, preflightSpec({ sharedPreferences: { p: { a: true } } })),
    ).rejects.toThrow(/pm clear dev.example.app did not succeed: Failed/);
    expect(runner.adbCalls().some((call) => call.includes("run-as"))).toBe(false);
  });

  test("a deep link that prints an am start error fails even with exit 0", async () => {
    const runner = new FakeCommandRunner()
      .onAdb("pm path", { stdout: "package:/x.apk" })
      .onAdb("pm clear", { stdout: "Success\n" })
      .onAdb("am start", {
        stdout:
          "Starting: Intent { act=android.intent.action.VIEW }\nError: Activity not started, unable to resolve Intent\n",
      });
    await expect(
      runPreflight(runner, preflightSpec({ launchUri: "example:missing" })),
    ).rejects.toThrow(
      /Deep link example:missing did not start \(exit 0\): .*Activity not started/s,
    );
  });

  test("a missing app fails before touching app state", async () => {
    const runner = new FakeCommandRunner();
    await expect(runPreflight(runner, preflightSpec())).rejects.toThrow(
      /dev.example.app is not installed on emulator-5554; set app.apkPath/,
    );
    expect(runner.adbCalls()).toHaveLength(2);
  });

  test("a nonzero foreground user is refused before any app state changes", async () => {
    const runner = new FakeCommandRunner().onAdb("get-current-user", { stdout: "10\n" });
    await expect(runPreflight(runner, preflightSpec())).rejects.toThrow(
      /foreground Android user is 10; agent benchmarks run as user 0 only/,
    );
    expect(runner.adbCalls()).toEqual(["-s emulator-5554 shell am get-current-user"]);
    // User 0, or a device too old to answer, proceeds.
    for (const stdout of ["0\n", "Unknown command: get-current-user\n"]) {
      const ok = new FakeCommandRunner()
        .onAdb("get-current-user", { stdout })
        .onAdb("pm path", { stdout: "package:/x.apk" });
      await runPreflight(ok, preflightSpec({ clearAppData: false }));
    }
  });

  test("preference XML uses Android's typed tags and escapes values", () => {
    expect(sharedPreferencesXml({ done: true, count: 3, ratio: 0.5, name: 'A & "B" <c>' })).toBe(
      "<?xml version='1.0' encoding='utf-8' standalone='yes' ?>\n" +
        '<map><boolean name="done" value="true" /><int name="count" value="3" />' +
        '<float name="ratio" value="0.5" /><string name="name">A &amp; &quot;B&quot; &lt;c&gt;</string></map>\n',
    );
  });

  test("tab, newline, and CR survive XML parsing as character references", () => {
    expect(sharedPreferencesXml({ "a\tb": "line1\r\nline2" })).toContain(
      '<string name="a&#9;b">line1&#13;&#10;line2</string>',
    );
  });

  test("integers outside 32 bits use <long>, at both boundaries", () => {
    const xml = sharedPreferencesXml({
      max: 2147483647,
      over: 2147483648,
      min: -2147483648,
      under: -2147483649,
    });
    expect(xml).toContain('<int name="max" value="2147483647" />');
    expect(xml).toContain('<long name="over" value="2147483648" />');
    expect(xml).toContain('<int name="min" value="-2147483648" />');
    expect(xml).toContain('<long name="under" value="-2147483649" />');
  });
});

describe("agent benchmark screen capture", () => {
  test("clears a stale file, dumps to a device file, reads it back, and removes it", async () => {
    const xml =
      '<?xml version="1.0"?><hierarchy rotation="0"><node text="Hi &amp; bye"/></hierarchy>';
    const ok = new FakeCommandRunner()
      .onAdb("uiautomator dump", {
        stdout: "UI hierarchy dumped to: /sdcard/agent-benchmark-ui.xml",
      })
      .onAdb("exec-out cat", { stdout: xml });
    expect(await captureScreen(ok, "emulator-5554")).toBe(xml);
    expect(ok.adbCalls()).toEqual([
      "-s emulator-5554 shell rm -f /sdcard/agent-benchmark-ui.xml",
      "-s emulator-5554 shell uiautomator dump /sdcard/agent-benchmark-ui.xml",
      "-s emulator-5554 exec-out cat /sdcard/agent-benchmark-ui.xml",
      "-s emulator-5554 shell rm -f /sdcard/agent-benchmark-ui.xml",
    ]);
  });

  test("a read-back without a hierarchy fails and still removes the file", async () => {
    const bad = new FakeCommandRunner().onAdb("exec-out cat", { stdout: "ERROR: null root node" });
    await expect(captureScreen(bad, "emulator-5554")).rejects.toThrow(/no hierarchy: ERROR/);
    expect(bad.adbCalls().at(-1)).toBe(
      "-s emulator-5554 shell rm -f /sdcard/agent-benchmark-ui.xml",
    );
  });

  test("a failed stale-file removal aborts before dumping", async () => {
    const stuck = new FakeCommandRunner().onAdb("shell rm -f", { exitCode: 1, stderr: "denied" });
    await expect(captureScreen(stuck, "emulator-5554")).rejects.toThrow(/rm -f/);
    expect(stuck.adbCalls()).toEqual([
      "-s emulator-5554 shell rm -f /sdcard/agent-benchmark-ui.xml",
    ]);
  });

  test("screen text is the target app's text and content descriptions, entities decoded", async () => {
    const xml =
      '<?xml version="1.0"?><hierarchy rotation="0">' +
      '<node package="com.android.systemui" text="12:00"/>' +
      '<node package="dev.example.app" text="" resource-id="dev.example.app:id/summary">' +
      '<node package="dev.example.app" text="A &amp; &lt;b&gt;" class="android.widget.TextView"/>' +
      '<node package="dev.example.app" content-desc="Close &quot;x&quot;"/>' +
      "</node></hierarchy>";
    expect(await screenTextForApp(xml, PACKAGE)).toBe('A & <b>\nClose "x"');
  });

  test("nodes marked invisible, and their subtrees, do not count as screen text", async () => {
    const xml =
      '<?xml version="1.0"?><hierarchy rotation="0">' +
      '<node package="dev.example.app" text="Shown" visible-to-user="true"/>' +
      '<node package="dev.example.app" text="Behind" visible-to-user="false">' +
      '<node package="dev.example.app" text="Hidden child"/>' +
      "</node></hierarchy>";
    expect(await screenTextForApp(xml, PACKAGE)).toBe("Shown");
  });

  test("malformed hierarchy XML rejects rather than matching raw text", async () => {
    await expect(screenTextForApp("<hierarchy><node", PACKAGE)).rejects.toThrow();
  });
});
