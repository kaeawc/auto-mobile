import { describe, expect, test } from "bun:test";
import {
  isAndroidEmulatorSerial,
  isAndroidTransportAddressSerial,
} from "../../src/utils/androidSerial";

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
