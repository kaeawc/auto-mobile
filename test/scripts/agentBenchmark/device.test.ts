import { describe, expect, test } from "bun:test";
import {
  captureScreen,
  decodeXmlEntities,
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

  test("a single online device is chosen; zero or several need a serial", async () => {
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
    expect(await resolveSerial(two, "b")).toBe("b");
    await expect(resolveSerial(two, "c")).rejects.toThrow(
      /Device c is not online \(online: a, b\)/,
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
    const runner = new FakeCommandRunner().onAdb("pm path", {
      stdout: `package:/data/app/${PACKAGE}/base.apk`,
    });
    const log = await runPreflight(
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
      `${s} shell am force-stop ${PACKAGE}`,
      `${s} shell pm clear ${PACKAGE}`,
      `${s} shell run-as ${PACKAGE} mkdir -p shared_prefs`,
      `${s} push /run/preflight/onboarding_prefs.xml /data/local/tmp/agent-benchmark-onboarding_prefs.xml`,
      `${s} shell run-as ${PACKAGE} cp /data/local/tmp/agent-benchmark-onboarding_prefs.xml shared_prefs/onboarding_prefs.xml`,
      `${s} shell rm -f /data/local/tmp/agent-benchmark-onboarding_prefs.xml`,
      `${s} shell am start -W -a android.intent.action.VIEW -d example:app/screen ${PACKAGE}`,
    ]);
    expect(log).toEqual([
      "installed /repo/app.apk",
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
      `-s emulator-5554 shell am force-stop ${PACKAGE}`,
    ]);
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
});

describe("agent benchmark screen capture", () => {
  test("returns the hierarchy and rejects anything else", async () => {
    const xml =
      '<?xml version="1.0"?><hierarchy rotation="0"><node text="Hi &amp; bye"/></hierarchy>';
    const ok = new FakeCommandRunner().onAdb("uiautomator", { stdout: xml });
    expect(await captureScreen(ok, "emulator-5554")).toBe(xml);
    const bad = new FakeCommandRunner().onAdb("uiautomator", { stdout: "ERROR: null root node" });
    await expect(captureScreen(bad, "emulator-5554")).rejects.toThrow(/no hierarchy: ERROR/);
  });

  test("entity decoding restores visible text, decoding &amp; last", () => {
    expect(decodeXmlEntities("&lt;a&gt; &quot;b&quot; &apos;c&#39; &amp;lt;")).toBe(
      "<a> \"b\" 'c' &lt;",
    );
  });
});
