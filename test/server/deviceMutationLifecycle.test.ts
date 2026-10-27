import { describe, expect, test } from "bun:test";
import type { BootedDevice } from "../../src/models";
import { FamilyMutationPriorReader } from "../../src/server/deviceMutationFamilyPriorReader";
import { SessionDeviceMutationRecording } from "../../src/server/deviceMutationRecording";
import { SessionMutationRecorder } from "../../src/daemon/sessionBroker/mutations/recorder";
import { FakeDeviceMutationJournal } from "../fakes/FakeDeviceMutationJournal";
import { FakeTimer } from "../fakes/FakeTimer";
import { deviceToolMutations } from "../../src/server/deviceMutationAdapters";
import {
  withoutSessionCoveredFallbacks,
  type AppFallbackEvidence,
} from "../../src/server/deviceMutationAppFallback";
import {
  opaqueIntentKey,
  type DeviceBaseline,
} from "../../src/daemon/sessionBroker/mutations/types";

const fallback = (tool: string, appId: string | null) => ({
  kind: "opaque",
  key: opaqueIntentKey(tool, appId),
});

describe("Lifecycle journal intents (#14359)", () => {
  test.each(["terminateApp", "crashApp", "appLifecycle", "performanceTrace", "videoRecording"])(
    "%s acts on a process or a host artifact and records nothing",
    (tool) => {
      expect(deviceToolMutations(tool, { appId: "com.example" }, "android")).toEqual([]);
    },
  );

  test("launchApp only records when it clears app data", () => {
    expect(deviceToolMutations("launchApp", { appId: "com.example" }, "android")).toEqual([]);
    expect(
      deviceToolMutations("launchApp", { appId: "com.example", clearAppData: true }, "ios"),
    ).toEqual([fallback("clearAppData", "com.example")]);
  });

  test("measureStartup records only for a persistent compilation mode", () => {
    expect(
      deviceToolMutations("measureStartup", { appId: "a.b", dropCaches: true }, "android"),
    ).toEqual([]);
    expect(
      deviceToolMutations("measureStartup", { appId: "a.b", compilation: "asIs" }, "android"),
    ).toEqual([]);
    expect(
      deviceToolMutations("measureStartup", { appId: "a.b", compilation: "speed" }, "android"),
    ).toEqual([fallback("measureStartup", "a.b")]);
  });

  test("installApp keeps its installed-app row first and adds the fallback", () => {
    expect(deviceToolMutations("installApp", { appId: "a.b" }, "android")).toEqual([
      { kind: "installed-app", key: "a.b" },
      fallback("installApp", "a.b"),
    ]);
    expect(deviceToolMutations("installApp", { artifactPath: "/x.apk" }, "android")).toEqual([
      fallback("installApp", null),
    ]);
  });

  test("keepData uninstall retains its fallback even for a session-installed app", async () => {
    const rows = deviceToolMutations("uninstallApp", { appId: "a.b", keepData: true }, "android");
    expect(rows).toEqual([
      { kind: "installed-app", key: "a.b" },
      { kind: "opaque", key: opaqueIntentKey("uninstallApp", "a.b", true) },
    ]);
    expect(
      await withoutSessionCoveredFallbacks(
        rows,
        evidence({ installed: ["a.b"], baselineApps: [] }),
      ),
    ).toEqual(rows);
    expect(
      await withoutSessionCoveredFallbacks(
        deviceToolMutations("uninstallApp", { appId: "a.b", keepData: false }, "android"),
        evidence({ installed: ["a.b"], baselineApps: [] }),
      ),
    ).toEqual([{ kind: "installed-app", key: "a.b" }]);
  });

  test("uninstallApp records the installed-app row and the fallback", () => {
    expect(deviceToolMutations("uninstallApp", { appId: "a.b" }, "ios")).toEqual([
      { kind: "installed-app", key: "a.b" },
      fallback("uninstallApp", "a.b"),
    ]);
  });
});

function evidence(options: {
  installed?: readonly string[];
  baselineApps?: readonly string[] | null;
}): AppFallbackEvidence {
  const baseline: DeviceBaseline | null =
    options.baselineApps === null || options.baselineApps === undefined
      ? null
      : {
          completeKinds: [],
          unobservable: [],
          observations: options.baselineApps.map((key) => ({
            kind: "installed-app",
            key,
            value: { state: "present", value: true },
          })),
        };
  return {
    sessionInstalled: async (appId) => options.installed?.includes(appId) ?? false,
    baseline: async () => baseline,
  };
}

describe("withoutSessionCoveredFallbacks", () => {
  const clear = fallback("clearAppData", "a.b");

  test("clearing data of an app the session installed and the baseline lacked is covered by the clean", async () => {
    expect(
      await withoutSessionCoveredFallbacks(
        [clear],
        evidence({ installed: ["a.b"], baselineApps: [] }),
      ),
    ).toEqual([]);
  });

  test("an app the baseline held keeps the fallback even when the session reinstalled it (Android and iOS keys)", async () => {
    for (const baselineApps of [["user:0:a.b"], ["a.b"]]) {
      expect(
        await withoutSessionCoveredFallbacks(
          [clear],
          evidence({ installed: ["a.b"], baselineApps }),
        ),
      ).toEqual([clear]);
    }
  });

  test("an app the session did not install keeps the fallback", async () => {
    expect(await withoutSessionCoveredFallbacks([clear], evidence({ baselineApps: [] }))).toEqual([
      clear,
    ]);
  });

  test("an unreadable baseline keeps the fallback", async () => {
    expect(
      await withoutSessionCoveredFallbacks(
        [clear],
        evidence({ installed: ["a.b"], baselineApps: null }),
      ),
    ).toEqual([clear]);
  });

  test("installApp over an app the baseline lacked is covered; over a held app it is not", async () => {
    const install = fallback("installApp", "a.b");
    expect(await withoutSessionCoveredFallbacks([install], evidence({ baselineApps: [] }))).toEqual(
      [],
    );
    expect(
      await withoutSessionCoveredFallbacks([install], evidence({ baselineApps: ["user:0:a.b"] })),
    ).toEqual([install]);
  });

  test("an install of an unidentified artifact keeps the fallback", async () => {
    const install = fallback("installApp", null);
    expect(await withoutSessionCoveredFallbacks([install], evidence({ baselineApps: [] }))).toEqual(
      [install],
    );
  });

  test("other mutations and other families' opaque intents pass through", async () => {
    const others = [
      { kind: "installed-app", key: "a.b" },
      { kind: "opaque", key: "tool:sendSms" },
      { kind: "opaque", key: opaqueIntentKey("sendBroadcast", "a.b") },
    ];
    expect(await withoutSessionCoveredFallbacks(others, evidence({ baselineApps: [] }))).toEqual(
      others,
    );
  });
});

describe("recording an app lifecycle sequence", () => {
  const device: BootedDevice = { deviceId: "emulator-5554", platform: "android", name: "Phone" };
  const scope = { deviceId: device.deviceId, incarnation: "resource", sessionUuid: "session" };

  async function run(baselineApps: readonly string[]) {
    const journal = new FakeDeviceMutationJournal(new FakeTimer());
    await journal.captureBaseline(scope, {
      completeKinds: [],
      unobservable: [],
      observations: baselineApps.map((key) => ({
        kind: "installed-app",
        key,
        value: { state: "present" as const, value: true },
      })),
    });
    const recording = new SessionDeviceMutationRecording(
      () => new SessionMutationRecorder(journal, scope),
      new FamilyMutationPriorReader([]),
      { appId: async () => "a.b" },
    );
    await recording.beforeToolCall("installApp", { appId: "a.b" }, device, "session");
    await recording.beforeToolCall(
      "launchApp",
      { appId: "a.b", clearAppData: true },
      device,
      "session",
    );
    return (await journal.list(scope)).map((entry) => [entry.kind, entry.toolName]);
  }

  test("installing, then clearing a session-installed app leaves only the install row", async () => {
    expect(await run([])).toEqual([["installed-app", "installApp"]]);
  });

  test("clearing data of an app the baseline held records the escalating intent", async () => {
    expect(await run(["user:0:a.b"])).toEqual([
      ["installed-app", "installApp"],
      ["opaque", "installApp"],
      ["opaque", "launchApp"],
    ]);
  });
});
