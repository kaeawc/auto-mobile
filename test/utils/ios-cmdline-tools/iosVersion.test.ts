import { describe, expect, test } from "bun:test";
import {
  parseIosMajorVersion,
  iosMajorVersionFromSimctlListDevices,
} from "../../../src/utils/ios-cmdline-tools/iosVersion";

describe("parseIosMajorVersion", () => {
  test("parses dotted versions", () => {
    expect(parseIosMajorVersion("18.6")).toBe(18);
    expect(parseIosMajorVersion("17.5.1")).toBe(17);
    expect(parseIosMajorVersion("26.2")).toBe(26);
  });

  test("parses a bare major version", () => {
    expect(parseIosMajorVersion("18")).toBe(18);
  });

  test("tolerates surrounding whitespace", () => {
    expect(parseIosMajorVersion("  18.6 \n")).toBe(18);
  });

  test("returns null for missing or unparseable input", () => {
    expect(parseIosMajorVersion(undefined)).toBeNull();
    expect(parseIosMajorVersion(null)).toBeNull();
    expect(parseIosMajorVersion("")).toBeNull();
    expect(parseIosMajorVersion("unknown")).toBeNull();
  });
});

describe("iosMajorVersionFromSimctlListDevices", () => {
  const udid = "7B3A3792-DB53-4654-BA94-27A1D305C3B7";

  const listJson = JSON.stringify({
    devices: {
      "com.apple.CoreSimulator.SimRuntime.iOS-18-6": [
        { udid, name: "iPhone 16 Pro", state: "Booted" },
      ],
      "com.apple.CoreSimulator.SimRuntime.iOS-17-5": [
        { udid: "OTHER-UDID", name: "iPhone 15", state: "Shutdown" },
      ],
    },
  });

  test("resolves the major version for the runtime containing the udid", () => {
    expect(iosMajorVersionFromSimctlListDevices(listJson, udid)).toBe(18);
  });

  test("resolves an iOS 17 device", () => {
    expect(iosMajorVersionFromSimctlListDevices(listJson, "OTHER-UDID")).toBe(17);
  });

  test("returns null when the udid is not present", () => {
    expect(iosMajorVersionFromSimctlListDevices(listJson, "MISSING")).toBeNull();
  });

  test("returns null for malformed JSON", () => {
    expect(iosMajorVersionFromSimctlListDevices("not json", udid)).toBeNull();
    expect(iosMajorVersionFromSimctlListDevices("", udid)).toBeNull();
  });

  test("returns null when the runtime id has no iOS version token", () => {
    const weird = JSON.stringify({
      devices: { "com.apple.CoreSimulator.SimRuntime.watchOS-11-0": [{ udid }] },
    });
    expect(iosMajorVersionFromSimctlListDevices(weird, udid)).toBeNull();
  });
});
