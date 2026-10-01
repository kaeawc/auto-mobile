import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ActionableError } from "../../../src/models/ActionableError";
import {
  CoreDeviceCapabilityProbe,
  checkCoreDeviceDowngrade,
  parseCoreDeviceVersion,
} from "../../../src/utils/ios-cmdline-tools/CoreDeviceCapabilityProbe";
import {
  FakeCoreDeviceGuardVersionProvider,
  FakeCoreDeviceVersionExecutor,
  FakeDevicectlCommandInvoker,
  FakeSimulatorBootStateProvider,
} from "../../fakes/FakeCoreDeviceCapabilityDependencies";

const capturedVersion = readFileSync(
  join(process.cwd(), "test/fixtures/ios-devicectl/version.txt"),
  "utf8",
);
const installed: [number, number, number] = [651, 13, 4];
const required: [number, number, number] = [651, 13, 4];

function harness() {
  const versionExecutor = new FakeCoreDeviceVersionExecutor(capturedVersion);
  const guardVersions = new FakeCoreDeviceGuardVersionProvider();
  guardVersions.versions = {
    installedCoreDevice: installed,
    selectedDeveloperDirCoreDevice: installed,
  };
  const bootState = new FakeSimulatorBootStateProvider();
  const commandInvoker = new FakeDevicectlCommandInvoker();
  const warnings: string[] = [];
  const probe = new CoreDeviceCapabilityProbe({
    versionExecutor,
    guardVersions,
    bootState,
    commandInvoker,
    logger: { warn: (message) => warnings.push(message) },
  });
  return { probe, versionExecutor, guardVersions, bootState, commandInvoker, warnings };
}

describe("CoreDeviceCapabilityProbe", () => {
  test("parses the captured CoreDevice version and compares the required version", async () => {
    expect(parseCoreDeviceVersion(capturedVersion)).toEqual(installed);
    const { probe, commandInvoker } = harness();
    expect(await probe.checkSimulatorCommand("sim-1", "lock-state", [651, 13, 5])).toEqual({
      kind: "unsupported",
      reason: "lock-state requires CoreDevice >= 651.13.5",
    });
    expect(commandInvoker.calls).toHaveLength(0);
  });

  test("coalesces version calls and caches success for the instance", async () => {
    const { probe, versionExecutor } = harness();
    const [first, second] = await Promise.all([probe.getVersion(), probe.getVersion()]);
    expect(first).toEqual({ kind: "available", version: installed });
    expect(second).toEqual(first);
    expect(await probe.getVersion()).toEqual(first);
    expect(versionExecutor.calls).toBe(1);
  });

  test("caches a failed version probe as unavailable and logs it", async () => {
    const { probe, versionExecutor, warnings } = harness();
    versionExecutor.failure = new Error("version command failed");
    expect(await probe.getVersion()).toMatchObject({ kind: "unavailable" });
    expect(await probe.getVersion()).toMatchObject({ kind: "unavailable" });
    expect(versionExecutor.calls).toBe(1);
    expect(warnings[0]).toContain("version command failed");
  });

  test("blocks an older or unverified developer directory before devicectl", async () => {
    const older = harness();
    older.guardVersions.versions = {
      installedCoreDevice: installed,
      selectedDeveloperDirCoreDevice: [650, 0, 0],
    };
    expect(await older.probe.checkSimulatorCommand("sim-1", "copy", required)).toMatchObject({
      kind: "blocked",
      warning: expect.stringContaining("older than installed CoreDevice"),
    });
    expect(older.versionExecutor.calls).toBe(0);
    expect(older.commandInvoker.calls).toHaveLength(0);

    const unknown = harness();
    unknown.guardVersions.versions = undefined;
    expect(await unknown.probe.getVersion()).toMatchObject({ kind: "blocked" });
    expect(unknown.versionExecutor.calls).toBe(0);
    expect(
      checkCoreDeviceDowngrade({
        installedCoreDevice: installed,
        selectedDeveloperDirCoreDevice: installed,
      }),
    ).toEqual({ kind: "safe" });
  });

  test("blocks shut-down or unknown simulator states before command invocation", async () => {
    const { probe, bootState, commandInvoker } = harness();
    bootState.state = "shutdown";
    const shutdown = await probe.checkSimulatorCommand("sim-1", "copy", required);
    expect(shutdown.kind).toBe("notBooted");
    if (shutdown.kind === "notBooted") {
      expect(shutdown.error).toBeInstanceOf(ActionableError);
      expect(shutdown.error.message).toContain("Boot it before running copy");
    }
    bootState.state = "unknown";
    expect(await probe.checkSimulatorCommand("sim-1", "copy", required)).toMatchObject({
      kind: "notBooted",
    });
    expect(commandInvoker.calls).toHaveLength(0);
  });

  test("memoizes typed unsupported per device and command, but retries failures", async () => {
    const { probe, commandInvoker } = harness();
    commandInvoker.result = { kind: "unsupported" };
    expect(await probe.checkSimulatorCommand("sim-1", "copy", required)).toMatchObject({
      kind: "unsupported",
      reason: expect.stringContaining("requires CoreDevice >= 651.13.4"),
    });
    commandInvoker.result = { kind: "ok" };
    expect(await probe.checkSimulatorCommand("sim-1", "copy", required)).toMatchObject({
      kind: "unsupported",
    });
    expect(await probe.checkSimulatorCommand("sim-2", "copy", required)).toEqual({
      kind: "supported",
    });
    expect(await probe.checkSimulatorCommand("sim-1", "profiles", required)).toEqual({
      kind: "supported",
    });
    commandInvoker.result = { kind: "failed", message: "typed failure" };
    expect(await probe.checkSimulatorCommand("sim-3", "copy", required)).toEqual({
      kind: "failed",
      message: "typed failure",
    });
    commandInvoker.result = { kind: "ok" };
    expect(await probe.checkSimulatorCommand("sim-3", "copy", required)).toEqual({
      kind: "supported",
    });
    expect(commandInvoker.calls).toHaveLength(5);
  });
});
