import { describe, expect, test } from "bun:test";
import {
  AndroidTransportAliases,
  isAndroidEmulatorSerial,
  isAndroidTransportAddressSerial,
} from "../../src/utils/androidSerial";
import type { BootedDevice } from "../../src/models";
import { createExecResult } from "../../src/utils/execResult";
import { FakeAdbExecutor } from "../fakes/FakeAdbExecutor";
import { FakeAdbClientFactory } from "../fakes/FakeAdbClientFactory";

describe("Android serial predicates", () => {
  test.each([
    "192.168.1.24:5555",
    "localhost:5555",
    "[::1]:5555",
    "[fe80::1234%en0]:5555",
    "[fe80::1%25eth0]:5555",
    "adb-XXXX._adb-tls-connect._tcp",
    "adb-XXXX._adb._tcp",
  ])("recognizes transport address %s", (deviceId) => {
    expect(isAndroidTransportAddressSerial(deviceId)).toBe(true);
  });

  test.each(["R5CT123ABC", "emulator-5554", "physical-device-serial"])(
    "does not recognize durable serial %s as a transport address",
    (deviceId) => {
      expect(isAndroidTransportAddressSerial(deviceId)).toBe(false);
    },
  );

  test("keeps emulator and transport predicates disjoint", () => {
    expect(isAndroidEmulatorSerial("emulator-5554")).toBe(true);
    expect(isAndroidTransportAddressSerial("emulator-5554")).toBe(false);
  });
});

describe("Android transport identity", () => {
  const device = (deviceId: string, name = "Pixel"): BootedDevice => ({
    deviceId,
    name,
    platform: "android",
  });

  test("two instances of one AVD stay distinct using their console slots", async () => {
    const adb = new FakeAdbExecutor();
    adb.setCommandResponse("ro.serialno", createExecResult("EMULATOR-SERIAL", ""));
    adb.setCommandResponse("ro.kernel.qemu", createExecResult("1", ""));
    adb.setCommandResponse("ro.boot.qemu.avd_name", createExecResult("Pixel", ""));
    const aliases = new AndroidTransportAliases(new FakeAdbClientFactory(adb));
    const rows = [
      device("emulator-5554"),
      device("localhost:5555"),
      device("emulator-5556"),
      device("127.0.0.1:5557"),
    ];
    const result = aliases.fold(rows, await aliases.prepare(rows), new Set());
    expect(result.map((row) => row.deviceId)).toEqual(["emulator-5554", "emulator-5556"]);
    expect(aliases.aliases("emulator-5554")).toEqual(["localhost:5555"]);
    expect(aliases.aliases("emulator-5556")).toEqual(["127.0.0.1:5557"]);
    expect(adb.getExecutedCommands()).toHaveLength(6);
  });

  test("does not identify a remote emulator with a local console by port or AVD name alone", async () => {
    const adb = new FakeAdbExecutor();
    adb.setCommandResponse("ro.serialno", createExecResult("EMULATOR-SERIAL", ""));
    adb.setCommandResponse("ro.kernel.qemu", createExecResult("1", ""));
    adb.setCommandResponse("ro.boot.qemu.avd_name", createExecResult("Pixel", ""));
    const aliases = new AndroidTransportAliases(new FakeAdbClientFactory(adb));
    const rows = [device("emulator-5554"), device("192.168.1.30:5555")];
    await expect(aliases.prepare(rows)).rejects.toThrow("Could not identify Android transport");
  });

  test("a changed console-slot incarnation invalidates the cached AVD evidence", async () => {
    const adb = new FakeAdbExecutor();
    adb.setCommandResponse("ro.serialno", createExecResult("EMULATOR-SERIAL", ""));
    adb.setCommandResponse("ro.kernel.qemu", createExecResult("1", ""));
    adb.setCommandResponse("ro.boot.qemu.avd_name", createExecResult("Pixel", ""));
    const aliases = new AndroidTransportAliases(new FakeAdbClientFactory(adb));
    const initial = [device("emulator-5554"), device("localhost:5555")];
    aliases.fold(initial, await aliases.prepare(initial), new Set());
    adb.setCommandResponse("ro.boot.qemu.avd_name", createExecResult("New_AVD", ""));
    const changed = [device("emulator-5554", "New_AVD"), device("localhost:5555")];
    const result = aliases.fold(
      changed,
      await aliases.prepare(changed),
      new Set(["emulator-5554"]),
    );
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("New_AVD");
    expect(adb.getExecutedCommands()).toHaveLength(6);
  });

  test("does not fold unrelated handsets sharing a display name", async () => {
    const first = new FakeAdbExecutor();
    first.setCommandResponse("ro.serialno", createExecResult("PHONE-A", ""));
    first.setCommandResponse("ro.kernel.qemu", createExecResult("0", ""));
    const second = new FakeAdbExecutor();
    second.setCommandResponse("ro.serialno", createExecResult("PHONE-B", ""));
    second.setCommandResponse("ro.kernel.qemu", createExecResult("0", ""));
    const aliases = new AndroidTransportAliases({
      create: (target) => (target?.deviceId === "host-a:5555" ? first : second),
    });
    const rows = [device("host-a:5555"), device("host-b:5555")];
    expect(aliases.fold(rows, await aliases.prepare(rows), new Set())).toHaveLength(2);
  });
});
