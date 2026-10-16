import { describe, expect, test } from "bun:test";
import {
  captureScreen,
  decodeXmlEntities,
  describeAppBuild,
  parseOnlineSerials,
  resolveSerial,
  runPreflight,
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
    expect(runner.adbCalls()).toHaveLength(1);
  });

  test("preference XML uses Android's typed tags and escapes values", () => {
    expect(sharedPreferencesXml({ done: true, count: 3, ratio: 0.5, name: 'A & "B" <c>' })).toBe(
      "<?xml version='1.0' encoding='utf-8' standalone='yes' ?>\n" +
        '<map><boolean name="done" value="true" /><int name="count" value="3" />' +
        '<float name="ratio" value="0.5" /><string name="name">A &amp; &quot;B&quot; &lt;c&gt;</string></map>\n',
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
  test("dumps to a device file, reads it back, and removes it", async () => {
    const xml =
      '<?xml version="1.0"?><hierarchy rotation="0"><node text="Hi &amp; bye"/></hierarchy>';
    const ok = new FakeCommandRunner()
      .onAdb("uiautomator dump", {
        stdout: "UI hierarchy dumped to: /sdcard/agent-benchmark-ui.xml",
      })
      .onAdb("exec-out cat", { stdout: xml });
    expect(await captureScreen(ok, "emulator-5554")).toBe(xml);
    expect(ok.adbCalls()).toEqual([
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

  test("entity decoding restores visible text, decoding &amp; last", () => {
    expect(decodeXmlEntities("&lt;a&gt; &quot;b&quot; &apos;c&#39; &amp;lt;")).toBe(
      "<a> \"b\" 'c' &lt;",
    );
  });
});
