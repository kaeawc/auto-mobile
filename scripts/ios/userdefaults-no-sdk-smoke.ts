import assert from "node:assert/strict";
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import {
  AppPreferences,
  type IosPreferenceKeyValueClient,
} from "../../src/features/preferences/AppPreferences";
import { SimCtlClient } from "../../src/utils/ios-cmdline-tools/SimCtlClient";
import { defaultTimer } from "../../src/utils/SystemTimer";

// The transport seam supplies the real old/new runner refusal messages. All
// container discovery, writes, plist verification, and app reads use the simulator.
// This is not a runner/MCP integration test; those wire guards have separate tests.
const [deviceId, appPath] = process.argv.slice(2);
assert(deviceId && appPath, "Pass a booted simulator UDID and the compiled probe app.");
const appId = "com.automobile.userdefaults.probe";
const customSuite = "automobile.probe.custom";
const simctl = new SimCtlClient();
const device = { platform: "ios" as const, deviceId, name: "UserDefaults smoke" };
const legacyRefusal =
  `Command execution failed: iOS key-value storage requires ${appId} to embed and initialize ` +
  "the AutoMobile SDK and call UserDefaultsInspector.shared.setEnabled(true)";
const sentinel = "preserve this unrelated value";
const scenarios = [
  { name: "no runner", refusal: undefined },
  { name: "legacy runner", refusal: legacyRefusal },
  { name: "current runner", refusal: `${legacyRefusal}: sdk_unavailable_not_dispatched` },
];

function refusingClient(message: string): IosPreferenceKeyValueClient {
  return {
    isConnected: () => true,
    getPreference: async () => {
      throw new Error(message);
    },
    setPreference: async () => {
      throw new Error(message);
    },
  };
}

async function readSnapshot(path: string): Promise<Record<string, Record<string, unknown>>> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    try {
      return JSON.parse(await readFile(path, "utf8"));
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
        throw error;
      }
    }
    await defaultTimer.sleep(100);
  }
  throw new Error("Probe did not report application-visible UserDefaults within 20 seconds.");
}

// Do not overwrite a fixture already owned by another smoke run.
const existing = await simctl.listAppsOrThrow(deviceId);
assert(
  !existing.some((app) => app.bundleId === appId || app.CFBundleIdentifier === appId),
  `Uninstall ${appId} before running this disposable probe.`,
);
let installed = false;
try {
  await simctl.installApp(appPath, deviceId, { timeoutMs: 60_000 });
  installed = true;
  const container = (
    await simctl.executeCommandArgs(["get_app_container", deviceId, appId, "data"], 10_000)
  ).stdout.trim();
  const snapshotPath = join(container, "Documents", "observed.json");
  await simctl.executeCommandArgs(["launch", deviceId, appId], 30_000);
  const baseline = await readSnapshot(snapshotPath);
  assert.deepEqual(baseline, {
    standard: { sentinel },
    custom: { sentinel },
  });
  let expected = baseline;
  for (const [index, scenario] of scenarios.entries()) {
    const preferences = new AppPreferences(device, {
      iosKeyValueClientProvider: () => (scenario.refusal ? refusingClient(scenario.refusal) : null),
    });
    const values = {
      host: `${scenario.name}: dev.slack.com / 'quoted' $literal`,
      flag: index % 2 === 0,
      count: 42 + index,
      ratio: 2.5 + index,
      sentinel,
    };
    // Write while the app has warm preferences, as login setup does.
    for (const suite of [undefined, customSuite]) {
      for (const [key, type] of [
        ["host", "string"],
        ["flag", "bool"],
        ["count", "int"],
        ["ratio", "float"],
      ] as const) {
        const input = { scope: "userDefaults" as const, appId, suite, key };
        const result = await preferences.setPreference({ ...input, value: values[key], type });
        assert.equal(result.storeRoute, "container-plist");
        assert.equal(result.verified, true);
        assert.equal(result.value, values[key]);
        assert.match(result.warning ?? "", /only file content/);
        assert.equal((await preferences.getPreference(input)).value, values[key]);
      }
    }
    await simctl.executeCommandArgs(["terminate", deviceId, appId], 10_000);
    await rm(snapshotPath);
    await simctl.executeCommandArgs(["launch", deviceId, appId], 30_000);
    expected = { standard: values, custom: values };
    assert.deepEqual(await readSnapshot(snapshotPath), expected);
    console.log(
      `PASS ${scenario.name}: both stores, four scalar types, cold-launch app reads, sentinel preserved`,
    );
  }

  await simctl.executeCommandArgs(["terminate", deviceId, appId], 10_000);
  await rm(snapshotPath);
  await simctl.executeCommandArgs(["launch", deviceId, appId, "--remove-sentinel"], 30_000);
  const expectedWithoutSentinel = {
    standard: Object.fromEntries(
      Object.entries(expected.standard).filter(([key]) => key !== "sentinel"),
    ),
    custom: Object.fromEntries(
      Object.entries(expected.custom).filter(([key]) => key !== "sentinel"),
    ),
  };
  // Confirm the probe-only control removed the sentinel from both stores.
  assert.deepEqual(await readSnapshot(snapshotPath), expectedWithoutSentinel);
  await simctl.executeCommandArgs(["terminate", deviceId, appId], 10_000);
  await rm(snapshotPath);
  await simctl.executeCommandArgs(["launch", deviceId, appId], 30_000);
  // A normal cold launch must observe the deletion instead of restoring the fixture.
  assert.deepEqual(await readSnapshot(snapshotPath), expectedWithoutSentinel);
  expected = expectedWithoutSentinel;
  console.log("PASS sentinel deletion: both stores remain absent after another cold launch");

  const ambiguous = new AppPreferences(device, {
    iosKeyValueClientProvider: () => refusingClient("connection_lost"),
  });
  await assert.rejects(
    ambiguous.setPreference({
      scope: "userDefaults",
      appId,
      key: "host",
      type: "string",
      value: "must not reach disk",
    }),
    /may or may not have been applied/,
  );
  await simctl.executeCommandArgs(["terminate", deviceId, appId], 10_000);
  await rm(snapshotPath);
  await simctl.executeCommandArgs(["launch", deviceId, appId], 30_000);
  assert.deepEqual(await readSnapshot(snapshotPath), expected);
  console.log("PASS ambiguous SDK failure: no fallback mutation visible to the app");
} finally {
  if (installed) {
    await simctl.uninstallApp(appId, deviceId, { timeoutMs: 30_000 });
  }
}
