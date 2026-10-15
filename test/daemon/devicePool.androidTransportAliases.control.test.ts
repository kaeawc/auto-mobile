import { afterEach, describe, expect, test } from "bun:test";
import { DevicePool } from "../../src/daemon/devicePool";
import { SessionManager } from "../../src/daemon/sessionManager";
import { androidTransportCouldAliasHeldDevice } from "../../src/daemon/frameDeviceIdentity";
import type { BindingExclusion } from "../../src/daemon/sessionBroker/provisioning/exclusion";
import type { ManagedDeviceEntry } from "../../src/daemon/sessionBroker/registry/bindingRegistry";
import type { BootedDevice } from "../../src/models";
import { withAndroidTransportId } from "../../src/utils/androidSerial";
import { createExecResult } from "../../src/utils/execResult";
import { FakeAdbClientFactory } from "../fakes/FakeAdbClientFactory";
import { FakeAdbExecutor } from "../fakes/FakeAdbExecutor";
import { FakeDeviceSessionPersistence } from "../fakes/FakeDeviceSessionPersistence";
import { FakeDeviceUtils } from "../fakes/FakeDeviceUtils";
import { FakeInstalledAppsRepository } from "../fakes/FakeInstalledAppsRepository";
import { FakeTimer } from "../fakes/FakeTimer";
import { createDevicePoolDependencies } from "../helpers/devicePoolDependencies";

const USB = "PHONE-A";
const WIRELESS = "192.168.1.20:5555";
const row = (deviceId: string, transportId = deviceId): BootedDevice =>
  withAndroidTransportId({ deviceId, name: deviceId, platform: "android" }, transportId);
const timers: FakeTimer[] = [];
afterEach(() => timers.splice(0).forEach((timer) => timer.reset()));
function harness(bindingExclusion?: BindingExclusion) {
  const timer = new FakeTimer();
  timers.push(timer);
  const sessions = new SessionManager(timer, new FakeDeviceSessionPersistence());
  const manager = new FakeDeviceUtils();
  const adb = new FakeAdbExecutor();
  adb.setCommandResponse("ro.serialno", createExecResult(USB, ""));
  adb.setCommandResponse("ro.kernel.qemu", createExecResult("0", ""));
  adb.setCommandResponse("boot_id", createExecResult("boot-a", ""));
  const pool = new DevicePool(
    createDevicePoolDependencies(sessions, "control-alias", {
      timer,
      deviceManager: manager,
      installedAppsRepository: new FakeInstalledAppsRepository(),
      androidAdbFactory: new FakeAdbClientFactory(adb),
      bindingExclusion,
    }),
  );
  return { pool, adb, manager, timer };
}

describe("positive evidence distinguishing an unassignable control transport", () => {
  test("rule 4: a probe-proven remote emulator distinguishes only a held physical phone", async () => {
    const { pool, adb } = harness();
    const remote = row("10.0.0.7:5555");
    expect(androidTransportCouldAliasHeldDevice(pool, remote, USB)).toBe(true);
    adb.setCommandResponse("ro.kernel.qemu", createExecResult("1", ""));
    adb.setCommandResponse("ro.boot.qemu.avd_name", createExecResult("", ""));
    await pool.normalizeAndroidDiscovery([remote]);

    expect(pool.isAndroidTransportAssignable(remote)).toBe(false);
    expect(androidTransportCouldAliasHeldDevice(pool, remote, USB)).toBe(false);
    expect(androidTransportCouldAliasHeldDevice(pool, remote, "emulator-5554")).toBe(true);
    expect(androidTransportCouldAliasHeldDevice(pool, remote, "10.0.0.8:5555")).toBe(true);
    expect(androidTransportCouldAliasHeldDevice(pool, remote)).toBe(true);
  });

  test("rule 4: remote emulator proof distinguishes a held physical wireless alias group", async () => {
    const { pool, adb } = harness();
    await pool.normalizeAndroidDiscovery([row(WIRELESS)]);
    const remote = row("10.0.0.7:5555");
    adb.setCommandResponse("ro.kernel.qemu", createExecResult("1", ""));
    adb.setCommandResponse("ro.boot.qemu.avd_name", createExecResult("Pixel", ""));
    await pool.normalizeAndroidDiscovery([remote], false, () => true, false);

    expect(pool.isAndroidTransportAssignable(remote)).toBe(false);
    expect(androidTransportCouldAliasHeldDevice(pool, remote, WIRELESS)).toBe(false);
  });

  test("rule 4: qemu proof never carries over to a stale or failed replacement connection", async () => {
    const { pool, adb } = harness();
    const remote = row("10.0.0.7:5555", "old");
    adb.setCommandResponse("ro.kernel.qemu", createExecResult("1", ""));
    adb.setCommandResponse("ro.boot.qemu.avd_name", createExecResult("Pixel", ""));
    await pool.normalizeAndroidDiscovery([remote]);
    expect(androidTransportCouldAliasHeldDevice(pool, remote, USB)).toBe(false);
    const replacement = row(remote.deviceId, "new");
    expect(androidTransportCouldAliasHeldDevice(pool, replacement, USB)).toBe(true);

    adb.setCommandError("ro.kernel.qemu", new Error("probe failed"));
    await pool.normalizeAndroidDiscovery([replacement]);
    expect(androidTransportCouldAliasHeldDevice(pool, replacement, USB)).toBe(true);
    expect(androidTransportCouldAliasHeldDevice(pool, remote, USB)).toBe(true);
  });

  test("rule 4: unresolved emulator identity is retried and a failed probe retains no qemu proof", async () => {
    const { pool, adb } = harness();
    const remote = row("10.0.0.7:5555");
    adb.setCommandResponse("ro.kernel.qemu", createExecResult("1", ""));
    adb.setCommandResponse("ro.boot.qemu.avd_name", createExecResult("Pixel", ""));
    await pool.normalizeAndroidDiscovery([remote]);
    expect(androidTransportCouldAliasHeldDevice(pool, remote, USB)).toBe(false);

    adb.setCommandError("ro.kernel.qemu", new Error("probe failed"));
    await pool.normalizeAndroidDiscovery([remote]);
    expect(pool.isAndroidTransportAssignable(remote)).toBe(false);
    expect(androidTransportCouldAliasHeldDevice(pool, remote, USB)).toBe(true);
  });

  test("rule 1: a current folded alias distinguishes another canonical device and an unknown slot", async () => {
    const { pool } = harness();
    await pool.normalizeAndroidDiscovery([row(USB), row(WIRELESS)]);
    expect(pool.isAndroidTransportAssignable(row(WIRELESS))).toBe(false);
    expect(androidTransportCouldAliasHeldDevice(pool, row(WIRELESS), "PHONE-B")).toBe(false);
    expect(androidTransportCouldAliasHeldDevice(pool, row(WIRELESS))).toBe(false);
    expect(androidTransportCouldAliasHeldDevice(pool, row(WIRELESS), USB)).toBe(true);
    // Old transport_id evidence is never proof for the replacement connection.
    expect(
      androidTransportCouldAliasHeldDevice(pool, row(WIRELESS, "replacement"), "PHONE-B"),
    ).toBe(true);
  });

  test("rule 2: physical proof blocked by an unproven pooled peer still distinguishes a different USB", async () => {
    const { pool, manager } = harness();
    manager.setBootedDevices("android", [row(USB)]);
    await pool.refreshDevices();
    await pool.normalizeAndroidDiscovery([row(WIRELESS)], false, () => true, false);
    expect(pool.isAndroidTransportAssignable(row(WIRELESS))).toBe(false);
    expect(androidTransportCouldAliasHeldDevice(pool, row(WIRELESS), USB)).toBe(true);
    expect(androidTransportCouldAliasHeldDevice(pool, row(WIRELESS), "PHONE-B")).toBe(false);
    expect(androidTransportCouldAliasHeldDevice(pool, row(WIRELESS), "emulator-5554")).toBe(true);
    expect(androidTransportCouldAliasHeldDevice(pool, row(WIRELESS), "unknown-host:5555")).toBe(
      true,
    );
    expect(androidTransportCouldAliasHeldDevice(pool, row(WIRELESS))).toBe(true);
  });

  test("rule 2: held alias groups retain their physical identity when the canonical id is wireless", async () => {
    const { pool, adb, manager } = harness();
    manager.setBootedDevices("android", [row("PHONE-B")]);
    await pool.refreshDevices();
    await pool.normalizeAndroidDiscovery([row("other-host:5555")], false, () => true, false);
    adb.setCommandResponse("ro.serialno", createExecResult("PHONE-B", ""));
    await pool.normalizeAndroidDiscovery([row(WIRELESS)], false, () => true, false);
    expect(pool.isAndroidTransportAssignable(row(WIRELESS))).toBe(false);
    expect(androidTransportCouldAliasHeldDevice(pool, row(WIRELESS), "other-host:5555")).toBe(
      false,
    );
  });

  test("rule 3: loopback console distinguishes only a different emulator", async () => {
    const { pool } = harness();
    for (const id of ["localhost:5555", "127.0.0.1:5555", "[::1]:5555"]) {
      expect(androidTransportCouldAliasHeldDevice(pool, row(id), "emulator-5556")).toBe(false);
      expect(androidTransportCouldAliasHeldDevice(pool, row(id), "emulator-5554")).toBe(true);
      expect(androidTransportCouldAliasHeldDevice(pool, row(id), USB)).toBe(true);
      expect(androidTransportCouldAliasHeldDevice(pool, row(id))).toBe(true);
    }
    expect(androidTransportCouldAliasHeldDevice(pool, row(WIRELESS), "emulator-5556")).toBe(true);
  });

  test("rule 3: an AVD-named group uses its console key even with a wireless canonical id", async () => {
    const { pool, adb } = harness();
    adb.setCommandResponse("ro.kernel.qemu", createExecResult("1", ""));
    adb.setCommandResponse("ro.boot.qemu.avd_name", createExecResult("Pixel", ""));
    await pool.normalizeAndroidDiscovery([row("localhost:5557")]);
    expect(
      androidTransportCouldAliasHeldDevice(pool, row("localhost:5555"), "localhost:5557"),
    ).toBe(false);
    expect(
      androidTransportCouldAliasHeldDevice(pool, row("localhost:5557"), "localhost:5557"),
    ).toBe(true);
  });
});

describe("binding Android hold snapshot", () => {
  test("refreshes with the input's one-second budget and counts only unrepresented Android holds", async () => {
    const entry: ManagedDeviceEntry = {
      platform: "android",
      stableDeviceId: "Pixel",
      holder: "session_broker",
      scopeKey: "scope",
      bindingIndex: 0,
      scopeState: "valid",
      execSessionUuid: "slot-session",
    };
    const refreshes: unknown[] = [];
    const exclusion: BindingExclusion = {
      refresh: async (options) => {
        refreshes.push(options);
      },
      stableIdsFor: (platform) => new Set(platform === "android" ? ["Pixel"] : ["ios-sim"]),
      holderOf: () => entry,
    };
    const { pool } = harness(exclusion);
    expect(await pool.androidBindingHold([])).toEqual({ entry });
    expect(await pool.androidBindingHold(["Pixel"])).toBeUndefined();
    expect(refreshes).toEqual([{ maxAgeMs: 1000 }, { maxAgeMs: 1000 }]);
  });

  test("recognizes a session's pooled emulator by its stable AVD id", async () => {
    const exclusion: BindingExclusion = {
      refresh: async () => {},
      stableIdsFor: () => new Set(["Pixel"]),
      holderOf: () => undefined,
    };
    const { pool, manager } = harness(exclusion);
    manager.setBootedDevices("android", [{ ...row("emulator-5554"), name: "Pixel" }]);
    await pool.refreshDevices();
    expect(await pool.androidBindingHold(["emulator-5554"])).toBeUndefined();
    expect(await pool.androidBindingHold([])).toEqual({ entry: undefined });
  });
});
