import { describe, expect, test } from "bun:test";
import {
  AndroidTransportAliases,
  withAndroidTransportId,
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
    expect(aliases.fold(rows, await aliases.prepare(rows), new Set())).toEqual(rows);
  });

  test("a changed console-slot connection re-verifies its identity", async () => {
    const adb = new FakeAdbExecutor();
    adb.setCommandResponse("ro.serialno", createExecResult("EMULATOR-SERIAL", ""));
    adb.setCommandResponse("ro.kernel.qemu", createExecResult("1", ""));
    adb.setCommandResponse("ro.boot.qemu.avd_name", createExecResult("Pixel", ""));
    const aliases = new AndroidTransportAliases(new FakeAdbClientFactory(adb));
    const initial = [device("emulator-5554"), device("localhost:5555")];
    aliases.fold(initial, await aliases.prepare(initial), new Set());
    adb.setCommandResponse("ro.boot.qemu.avd_name", createExecResult("New_AVD", ""));
    const changed = [
      device("emulator-5554", "New_AVD"),
      withAndroidTransportId(device("localhost:5555"), "new-connection"),
    ];
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
    first.setCommandResponse("boot_id", createExecResult("boot-a", ""));
    const second = new FakeAdbExecutor();
    second.setCommandResponse("ro.serialno", createExecResult("PHONE-B", ""));
    second.setCommandResponse("ro.kernel.qemu", createExecResult("0", ""));
    second.setCommandResponse("boot_id", createExecResult("boot-b", ""));
    const aliases = new AndroidTransportAliases({
      create: (target) => (target?.deviceId === "host-a:5555" ? first : second),
    });
    const rows = [device("host-a:5555"), device("host-b:5555")];
    expect(aliases.fold(rows, await aliases.prepare(rows), new Set())).toHaveLength(2);
  });
});

describe("Android physical transport evidence", () => {
  const device = (deviceId: string): BootedDevice => ({
    deviceId,
    name: deviceId,
    platform: "android",
  });
  const executor = (serial: string, bootId: string) => {
    const adb = new FakeAdbExecutor();
    adb.setCommandResponse("ro.serialno", createExecResult(serial, ""));
    adb.setCommandResponse("ro.kernel.qemu", createExecResult("0", ""));
    adb.setCommandResponse("boot_id", createExecResult(bootId, ""));
    return adb;
  };

  test("transport_id change on a continuously present host:port re-probes and un-folds", async () => {
    const usb = executor("PHONE-A", "boot-a");
    const wifi = executor("PHONE-A", "boot-a");
    const aliases = new AndroidTransportAliases({
      create: (target) => (target?.deviceId === "PHONE-A" ? usb : wifi),
    });
    const initial = [
      withAndroidTransportId(device("PHONE-A"), "1"),
      withAndroidTransportId(device("host-a:5555"), "2"),
    ];
    const pooled = new Set(["PHONE-A"]);
    expect(aliases.fold(initial, await aliases.prepare(initial), pooled)).toHaveLength(1);
    const calls = wifi.getExecutedCommands().length;
    expect(aliases.fold(initial, await aliases.prepare(initial), pooled)).toHaveLength(1);
    expect(wifi.getExecutedCommands()).toHaveLength(calls);
    wifi.setCommandResponse("ro.serialno", createExecResult("PHONE-B", ""));
    wifi.setCommandResponse("boot_id", createExecResult("boot-b", ""));
    const changed = [initial[0], withAndroidTransportId(device("host-a:5555"), "3")];
    expect(
      aliases.fold(changed, await aliases.prepare(changed), pooled).map((row) => row.deviceId),
    ).toEqual(["PHONE-A", "host-a:5555"]);
    expect(wifi.getExecutedCommands()).toHaveLength(calls + 3);
    expect(usb.getExecutedCommands()).toHaveLength(3);
    expect(aliases.aliases("PHONE-A")).toEqual([]);
    expect(aliases.resolveTransport("PHONE-A")).toBe("PHONE-A");
    expect(aliases.mapDiscovery(changed).map((row) => row.deviceId)).toEqual([
      "PHONE-A",
      "host-a:5555",
    ]);
  });

  test.each([true, false])(
    "a DHCP-reused endpoint is reidentified and never routes the old phone to its replacement (observed absence=%s)",
    async (observedAbsence) => {
      const usb = executor("PHONE-A", "boot-a");
      const wifi = executor("PHONE-A", "boot-a");
      const aliases = new AndroidTransportAliases({
        create: (target) => (target?.deviceId === "PHONE-A" ? usb : wifi),
      });
      const initial = [device("PHONE-A"), device("192.168.1.20:5555")];
      const pooled = new Set(["PHONE-A"]);
      expect(aliases.fold(initial, await aliases.prepare(initial), pooled)).toHaveLength(1);
      const disconnected = [device("PHONE-A")];
      if (observedAbsence) {
        aliases.fold(disconnected, await aliases.prepare(disconnected), pooled);
      }
      wifi.setCommandResponse("ro.serialno", createExecResult("PHONE-B", ""));
      wifi.setCommandResponse("boot_id", createExecResult("boot-b", ""));
      const replacement = [
        device("PHONE-A"),
        withAndroidTransportId(device("192.168.1.20:5555"), "replacement-connection"),
      ];
      const calls = wifi.getExecutedCommands().length;
      expect(aliases.fold(replacement, await aliases.prepare(replacement), pooled)).toHaveLength(2);
      expect(wifi.getExecutedCommands()).toHaveLength(calls + 3);
      const onlyReplacement = [
        withAndroidTransportId(device("192.168.1.20:5555"), "replacement-connection"),
      ];
      expect(
        aliases
          .fold(onlyReplacement, await aliases.prepare(onlyReplacement), pooled)
          .map((row) => row.deviceId),
      ).toEqual(["192.168.1.20:5555"]);
      expect(aliases.resolveTransport("PHONE-A")).toBe("PHONE-A");
      expect(aliases.aliases("PHONE-A")).toEqual([]);
    },
  );

  test.each(["0123456789ABCDEF", "unknown", ""])(
    "does not fold generic or absent serial %s even with a shared boot id",
    async (serial) => {
      const adb = executor(serial, "boot-a");
      const aliases = new AndroidTransportAliases(new FakeAdbClientFactory(adb));
      const rows = [device("host-a:5555"), device("host-b:5555")];
      expect(aliases.fold(rows, await aliases.prepare(rows), new Set())).toEqual(rows);
    },
  );

  test.each(["boot-b", ""])(
    "a physical serial requires matching nonempty boot evidence on both transports: %s",
    async (bootId) => {
      const usb = executor("PHONE-A", "boot-a");
      const wifi = executor("PHONE-A", bootId);
      const aliases = new AndroidTransportAliases({
        create: (target) => (target?.deviceId === "PHONE-A" ? usb : wifi),
      });
      const rows = [device("PHONE-A"), device("host-a:5555")];
      expect(aliases.fold(rows, await aliases.prepare(rows), new Set())).toEqual(rows);
    },
  );

  test("identity read failure leaves the row unaliased and preserves iOS", async () => {
    const adb = executor("PHONE-A", "boot-a");
    adb.setCommandError("ro.serialno", new Error("identity unavailable"));
    const aliases = new AndroidTransportAliases(new FakeAdbClientFactory(adb));
    const ios: BootedDevice = { deviceId: "ios", name: "iPhone", platform: "ios" };
    const rows = [ios, device("host-a:5555")];
    expect(aliases.fold(rows, await aliases.prepare(rows), new Set())).toEqual(rows);
  });
});
