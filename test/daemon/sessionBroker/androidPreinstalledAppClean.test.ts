import { describe, expect, test } from "bun:test";
import {
  isAndroidUnclearablePackage,
  journaledAppLaunches,
  parseQueryActivitiesComponents,
} from "../../../src/daemon/sessionBroker/androidKeepBootedCleanup";
import { AndroidDeviceMutationResetPort } from "../../../src/daemon/sessionBroker/androidDeviceMutationResetPort";
import { AndroidKeepBootedReset } from "../../../src/daemon/sessionBroker/androidKeepBootedReset";
import { launchedAppIntentKey } from "../../../src/daemon/sessionBroker/mutations/launchedApp";
import { deviceToolMutations } from "../../../src/server/deviceMutationAdapters";
import { FakeTimer } from "../../fakes/FakeTimer";
import { FakeDeviceMutationJournal } from "../../fakes/FakeDeviceMutationJournal";
import { ANDROID_RESET_DEVICE } from "./fixtures/androidReset";
import { androidBaselineRig } from "./fixtures/androidMutationBaseline";

const SESSION = { resourceId: "resource-a", sessionId: "session-a" };
const SCOPE = {
  deviceId: ANDROID_RESET_DEVICE.deviceId,
  incarnation: SESSION.resourceId,
  sessionUuid: SESSION.sessionId,
};
const CHROME = "com.android.chrome";
const GMS = "com.google.android.gms";
const LAUNCHER = "com.google.android.apps.nexuslauncher";
const PROBE = "com.example.probe";
const HTTPS_QUERY =
  "shell cmd package query-activities --components --user 0 -a android.intent.action.VIEW -d 'https://example.com/login'";

/** A device whose baseline holds Chrome, GMS and a launcher preinstalled beside the probe app. */
async function rig() {
  const { adb, reply } = androidBaselineRig();
  reply("shell pm list packages -s -u", `package:android\npackage:${CHROME}\npackage:${GMS}`);
  reply(
    "shell pm list packages --user 0",
    ["android", CHROME, GMS, LAUNCHER, PROBE].map((name) => `package:${name}`).join("\n"),
  );
  reply("shell pm clear", "Success");
  const timer = new FakeTimer();
  const journal = new FakeDeviceMutationJournal(timer);
  const port = new AndroidDeviceMutationResetPort(adb, timer);
  let fallbacks = 0;
  const strategy = new AndroidKeepBootedReset({
    journal,
    port: () => port,
    timer,
    fallback: {
      reset: async () => {
        fallbacks++;
        return { outcome: "clean", mode: "snapshot", phases: {} };
      },
    },
  });
  const assertOwned = async () => {};
  await strategy.capture(ANDROID_RESET_DEVICE, {
    ...SESSION,
    timeoutMs: 50,
    signal: new AbortController().signal,
    assertOwned,
  });
  adb.clearHistory();
  const record = async (tool: string, args: Record<string, unknown>) => {
    for (const row of deviceToolMutations(tool, args, "android")) {
      await journal.record(SCOPE, {
        ...row,
        toolName: tool,
        priorValue: { state: "unobservable" },
      });
    }
  };
  const reset = () => strategy.reset(ANDROID_RESET_DEVICE, new Set([PROBE]), assertOwned, SESSION);
  const clears = () => adb.getExecutedCommands().filter((command) => command.includes("pm clear"));
  return { adb, reply, record, reset, clears, fallbacks: () => fallbacks };
}

describe("Android keep-booted clears preinstalled apps the session started (#14364)", () => {
  test("a launched preinstalled browser is force-stopped and cleared, staying keep-booted", async () => {
    const { adb, record, reset, clears, fallbacks } = await rig();
    await record("launchApp", { appId: CHROME });
    expect(await reset()).toMatchObject({ outcome: "clean", mode: "keep-booted" });
    expect(fallbacks()).toBe(0);
    const commands = adb.getExecutedCommands();
    expect(commands).toContain(`shell am force-stop --user 0 '${CHROME}'`);
    expect(clears()).toEqual([`shell pm clear --user 0 '${CHROME}'`]);
    expect(commands.indexOf(clears()[0]!)).toBeGreaterThan(
      commands.indexOf("shell pm list packages -3 --user 0"),
    );
  });

  test("every preinstalled handler of an opened URL is cleared", async () => {
    const { reply, record, reset, clears } = await rig();
    reply(HTTPS_QUERY, `${CHROME}/com.google.android.apps.chrome.IntentDispatcher\n`);
    await record("openLink", { url: "https://example.com/login" });
    expect(await reset()).toMatchObject({ outcome: "clean", mode: "keep-booted" });
    expect(clears()).toEqual([`shell pm clear --user 0 '${CHROME}'`]);
  });

  test("a package: URL clears the app it names", async () => {
    const { record, reset, clears } = await rig();
    await record("openLink", { url: ` package:${CHROME} ` });
    expect(await reset()).toMatchObject({ outcome: "clean", mode: "keep-booted" });
    expect(clears()).toEqual([`shell pm clear --user 0 '${CHROME}'`]);
  });

  test("third-party baseline apps, session-installed apps and unhandled URLs clear nothing", async () => {
    const { reply, record, reset, clears } = await rig();
    reply(HTTPS_QUERY, "No activities found");
    await record("launchApp", { appId: PROBE });
    await record("launchApp", { appId: "com.example.session" });
    await record("openLink", { url: "https://example.com/login" });
    expect(await reset()).toMatchObject({ outcome: "clean", mode: "keep-booted" });
    expect(clears()).toEqual([]);
  });

  test.each([
    { name: "a launched launcher", tool: "launchApp", args: { appId: LAUNCHER } },
    {
      name: "a URL Play services handles",
      tool: "openLink",
      args: { url: "https://example.com/login" },
    },
  ])("$name escalates before any pm clear", async ({ tool, args }) => {
    const { reply, record, reset, clears, fallbacks } = await rig();
    reply(HTTPS_QUERY, `${CHROME}/.Main\n${GMS}/.Links`);
    await record(tool, args);
    const result = await reset();
    expect(result.outcome).toBe("fallback:snapshot");
    expect(result.fallbackReason).toContain("cannot clear data of core package");
    expect(fallbacks()).toBe(1);
    expect(clears()).toEqual([]);
  });

  test("an unconfirmed pm clear escalates", async () => {
    const { reply, record, reset, fallbacks } = await rig();
    reply("shell pm clear", "Failed");
    await record("launchApp", { appId: CHROME });
    expect((await reset()).outcome).toBe("fallback:snapshot");
    expect(fallbacks()).toBe(1);
  });

  test("unreadable URL handler output escalates", async () => {
    const { reply, record, reset, clears } = await rig();
    reply(HTTPS_QUERY, "Error: Unknown option: --components");
    await record("openLink", { url: "https://example.com/login" });
    expect((await reset()).outcome).toBe("fallback:snapshot");
    expect(clears()).toEqual([]);
  });
});

describe("Android preinstalled-app cleaning helpers", () => {
  test("query-activities component output parses to packages", () => {
    expect(
      parseQueryActivitiesComponents(
        `${CHROME}/.Main\n  com.example.a_b/com.example.Outer$Inner\n`,
      ),
    ).toEqual([CHROME, "com.example.a_b"]);
    expect(parseQueryActivitiesComponents("No activities found\n")).toEqual([]);
    expect(() => parseQueryActivitiesComponents("2 activities found:")).toThrow(
      "URL handler inventory",
    );
    expect(() => parseQueryActivitiesComponents("\n")).toThrow("empty URL handler inventory");
  });

  test.each([
    ["android", true],
    ["com.android.systemui", true],
    ["com.android.providers.settings", true],
    ["com.google.android.gms.policy_sidecar_aps", true],
    ["dev.jasonpearson.automobile.ctrlproxy", true],
    ["com.android.chrome", false],
    ["com.android.settings", false],
    ["com.google.android.gmsx", false],
  ])("%s unclearable: %s", (name, unclearable) => {
    expect(isAndroidUnclearablePackage(name)).toBe(unclearable);
  });

  test("journal launches gather launch rows and opened URLs; a malformed launch row throws", () => {
    const launches = journaledAppLaunches([
      { kind: "opaque", key: launchedAppIntentKey("a.b") },
      { kind: "opaque", key: "network-mocks" },
      { kind: "opened-url", key: "package:c.d" },
      { kind: "opened-url", key: "geo:0,0" },
    ]);
    expect([...launches.packages]).toEqual(["a.b", "c.d"]);
    expect([...launches.urls]).toEqual(["geo:0,0"]);
    expect(() => journaledAppLaunches([{ kind: "opaque", key: '["launched-app",1]' }])).toThrow(
      "journaled app launch",
    );
  });
});
