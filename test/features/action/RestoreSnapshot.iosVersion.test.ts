import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { parseIosSnapshotOsVersion } from "../../../src/features/action/RestoreSnapshot";

const capture: {
  result: {
    devices: Array<{
      visibilityClass: string;
      deviceProperties: { osVersionNumber: string };
    }>;
  };
} = JSON.parse(
  readFileSync(
    new URL("../../fixtures/ios-devicectl/list-devices-simulators-only.json", import.meta.url),
    "utf8",
  ),
);
const capturedVersions = [
  ...new Set(
    capture.result.devices
      .filter((device) => device.visibilityClass === "simulators")
      .map((device) => device.deviceProperties.osVersionNumber),
  ),
];
const accepted = [
  ...capturedVersions.map((value) => ({
    source: "captured",
    value,
    major: Number(value.split(".")[0]),
    minor: Number(value.split(".")[1]),
  })),
  ...[
    ["iOS 26.5", 26, 5],
    ["iOS 16.4", 16, 4],
    ["iOS-17-0", 17, 0],
    ["iOS_17_0", 17, 0],
    ["ios 17.0", 17, 0],
    ["iOS17 5 1", 17, 5],
    ["17", 17, undefined],
    ["17.5.1", 17, 5],
    ["com.apple.CoreSimulator.SimRuntime.iOS-26-5", 26, 5],
    ["com.apple.CoreSimulator.SimRuntime.iOS-17-0", 17, 0],
    ["com.apple.CoreSimulator.SimRuntime.iOS-17", 17, undefined],
    ["com.apple.CoreSimulator.SimRuntime.ios-17-5-1", 17, 5],
  ].map(([value, major, minor]) => ({ source: "synthetic", value: String(value), major, minor })),
];

// All rejected inputs are synthetic; none is a captured simctl response.
const rejected = [
  "watchOS-11-0",
  "tvOS 17.2",
  "visionOS 2.0",
  "macOS 15.1",
  "xrOS 2.0",
  "iPadOS 17.0",
  "com.apple.CoreSimulator.SimRuntime.iPadOS-17-0",
  "com.apple.CoreSimulator.SimRuntime.watchOS-11-0",
  "com.apple.CoreSimulator.SimRuntime.tvOS-17-2",
  "com.apple.CoreSimulator.SimRuntime.visionOS-2-0",
  "com.apple.CoreSimulator.SimRuntime.macOS-15-1",
  "com.apple.CoreSimulator.SimRuntime.xrOS-2-0",
  "garbage 99 text",
  "42abc",
  "17.0-beta",
  "xiOS-17",
  "iOS 17 something",
  "1.2.3.4.5",
  "17,0",
  "0x11",
  "17e2",
  "1_7",
  "17.0.1.2",
  "iOS-17-0-1-2",
  "com.apple.CoreSimulator.SimRuntime.iOS-17-0-1-2",
  "COM.APPLE.CoreSimulator.SimRuntime.iOS-17-0",
  "iOS  17",
  "iOS\t17",
  "",
  "   ",
  "non-numeric",
];

describe("parseIosSnapshotOsVersion", () => {
  it("reads simulator versions from the captured devicectl fixture", () => {
    expect(capturedVersions.length).toBeGreaterThan(0);
  });
  for (const row of accepted) {
    it(`accepts ${row.source} ${row.value}`, () => {
      expect(parseIosSnapshotOsVersion(row.value)).toEqual({ major: row.major, minor: row.minor });
    });
    it(`accepts synthetic whitespace padding around ${row.source} ${row.value}`, () => {
      expect(parseIosSnapshotOsVersion(` \t${row.value}\n `)).toEqual({
        major: row.major,
        minor: row.minor,
      });
    });
  }
  for (const value of rejected) {
    it(`rejects synthetic ${JSON.stringify(value)}`, () => {
      expect(parseIosSnapshotOsVersion(value)).toBeNull();
    });
  }
});
