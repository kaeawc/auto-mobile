import { describe, expect, test } from "bun:test";
import {
  parseIosMajorVersion,
  iosMajorVersionFromSimctlListDevices,
  iosMajorVersionFromDevicectlDetails,
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

  // Boundary table: the leading-digit regex `/^(\d+)/` on trimmed input has
  // several surprising-but-load-bearing outcomes that no earlier test pins.
  // `"0"` returns the falsy `0` (NOT null), so callers must use `=== null`, not
  // truthiness, to detect "unknown". `"1e309"` reads only the leading `1` (the
  // exponent is not part of the leading digit run — it is NOT parsed as
  // Infinity). `"018"` reads `18` (base-10, no octal). Negatives and
  // leading-dot forms have no leading digit and are "unknown".
  const boundaryRows: ReadonlyArray<{ input: string; expected: number | null }> = [
    { input: "0", expected: 0 },
    { input: "1", expected: 1 },
    { input: "018", expected: 18 },
    { input: "1e309", expected: 1 },
    { input: "26.2", expected: 26 },
    { input: "17.5.1", expected: 17 },
    { input: "18", expected: 18 },
    { input: "007", expected: 7 },
    { input: "42abc", expected: 42 },
    { input: "  9 ", expected: 9 },
    { input: "\t26.0\n", expected: 26 },
    { input: "-3", expected: null },
    { input: ".5", expected: null },
    { input: "v18", expected: null },
    { input: "iOS 18", expected: null },
    { input: "unknown", expected: null },
    { input: " ", expected: null },
    { input: "NaN", expected: null },
    { input: "Infinity", expected: null },
  ];

  for (const { input, expected } of boundaryRows) {
    test(`parses ${JSON.stringify(input)} as ${expected === null ? "null" : expected}`, () => {
      expect(parseIosMajorVersion(input)).toBe(expected);
    });
  }

  test("distinguishes the falsy 0 from unknown (null)", () => {
    // Regression guard: callers must not collapse `0` into "unknown".
    expect(parseIosMajorVersion("0")).toBe(0);
    expect(parseIosMajorVersion("0")).not.toBeNull();
    expect(parseIosMajorVersion("x")).toBeNull();
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

  test("returns null for valid JSON scalars (never throws)", () => {
    // `JSON.parse` accepts these; the function must still honor its null contract.
    expect(iosMajorVersionFromSimctlListDevices("null", udid)).toBeNull();
    expect(iosMajorVersionFromSimctlListDevices("42", udid)).toBeNull();
    expect(iosMajorVersionFromSimctlListDevices('"hi"', udid)).toBeNull();
    expect(iosMajorVersionFromSimctlListDevices("[]", udid)).toBeNull();
    expect(iosMajorVersionFromSimctlListDevices('{"devices":null}', udid)).toBeNull();
  });

  test("returns null when the runtime id has no iOS version token", () => {
    const weird = JSON.stringify({
      devices: { "com.apple.CoreSimulator.SimRuntime.watchOS-11-0": [{ udid }] },
    });
    expect(iosMajorVersionFromSimctlListDevices(weird, udid)).toBeNull();
  });

  test("keeps scanning past a non-iOS runtime that also lists the udid", () => {
    // A tokenless runtime iterated first must not short-circuit the resolution of
    // a later iOS runtime that lists the same udid.
    const multi = JSON.stringify({
      devices: {
        "com.apple.CoreSimulator.SimRuntime.watchOS-11-0": [{ udid }],
        "com.apple.CoreSimulator.SimRuntime.iOS-18-6": [{ udid }],
      },
    });
    expect(iosMajorVersionFromSimctlListDevices(multi, udid)).toBe(18);
  });
});

describe("iosMajorVersionFromDevicectlDetails", () => {
  test("reads osVersionNumber from the deviceProperties envelope", () => {
    const json = JSON.stringify({
      result: { deviceProperties: { osVersionNumber: "18.6" } },
    });
    expect(iosMajorVersionFromDevicectlDetails(json)).toBe(18);
  });

  test("resolves an iOS 16 device", () => {
    const json = JSON.stringify({
      result: { deviceProperties: { osVersionNumber: "16.7.1" } },
    });
    expect(iosMajorVersionFromDevicectlDetails(json)).toBe(16);
  });

  test("accepts alternate field spellings (productVersion)", () => {
    const json = JSON.stringify({ result: { hardware: { productVersion: "17.0" } } });
    expect(iosMajorVersionFromDevicectlDetails(json)).toBe(17);
  });

  test("returns null for malformed JSON", () => {
    expect(iosMajorVersionFromDevicectlDetails("{not json")).toBeNull();
  });

  test("returns null when no version field is present", () => {
    const json = JSON.stringify({ result: { deviceProperties: { name: "iPhone" } } });
    expect(iosMajorVersionFromDevicectlDetails(json)).toBeNull();
  });

  test("returns null for a non-object scalar payload", () => {
    expect(iosMajorVersionFromDevicectlDetails("42")).toBeNull();
  });
});
