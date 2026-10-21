import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { chooseIosDeviceType } from "../../../../src/daemon/sessionBroker/provisioning/reconciler";
import type {
  AppleDeviceRuntime,
  AppleDeviceType,
} from "../../../../src/utils/ios-cmdline-tools/SimCtlClient";

const captured: AppleDeviceType[] = JSON.parse(
  readFileSync(
    new URL("../../../fixtures/ios-devicetype-order/xcode-26.6-devicetypes.json", import.meta.url),
    "utf8",
  ),
).devicetypes;
const oldestFirst: AppleDeviceType[] = JSON.parse(
  readFileSync(
    new URL(
      "../../../fixtures/ios-devicetype-order/derived-oldest-first-devicetypes.json",
      import.meta.url,
    ),
    "utf8",
  ),
).devicetypes;
const runtimes: AppleDeviceRuntime[] = JSON.parse(
  readFileSync(
    new URL("../../../fixtures/ios-devicetype-order/xcode-26.6-runtimes.json", import.meta.url),
    "utf8",
  ),
).runtimes;
const typeId = (suffix: string) => `com.apple.CoreSimulator.SimDeviceType.${suffix}`;
const runtimeId = (suffix: string) => `com.apple.CoreSimulator.SimRuntime.iOS-${suffix}`;
// A fixed permutation with no random or process seam: alternate the two halves.
const shuffled = captured.toSorted((a, b) =>
  a.identifier < b.identifier ? -1 : a.identifier > b.identifier ? 1 : 0,
);
const half = Math.ceil(shuffled.length / 2);
const deterministicShuffle = shuffled
  .slice(0, half)
  .flatMap((entry, index) => (shuffled[index + half] ? [shuffled[index + half], entry] : [entry]));
const catalogs = [
  ["capture", captured],
  ["oldest-first", oldestFirst],
  ["reversed", captured.toReversed()],
  ["shuffled", deterministicShuffle],
] as const;
// Explicit expectations computed from hardware generation, variant, and runtime bounds.
// iOS 16.4: iPhone 14 Pro / iPad mini (6th generation).
// iOS 18.0: iPhone 16 Pro / iPad Pro 11-inch (M4).
const expected = [
  ["16-4", "iPhone-14-Pro", "iPad-mini-6th-generation"],
  ["17-5", "iPhone-15-Pro", "iPad-Pro-11-inch-M4-8GB"],
  ["18-0", "iPhone-16-Pro", "iPad-Pro-11-inch-M4-8GB"],
  ["18-6", "iPhone-16-Pro", "iPad-mini-A17-Pro"],
  ["26-2", "iPhone-17-Pro", "iPad-Pro-11-inch-M5-12GB"],
  ["26-5", "iPhone-17-Pro", "iPad-Pro-11-inch-M5-12GB"],
  ["27-0", "iPhone-18-Pro", "iPad-Pro-11-inch-M5-12GB"],
  ["27-1", "iPhone-18-Pro", "iPad-Pro-11-inch-M5-12GB"],
] as const;

function synthetic(suffix: string, extra: Partial<AppleDeviceType> = {}): AppleDeviceType {
  return {
    identifier: typeId(suffix),
    name: suffix,
    productFamily: "iPhone",
    bundlePath: "",
    minRuntimeVersion: 0,
    maxRuntimeVersion: 0,
    minRuntimeVersionString: "16.0",
    maxRuntimeVersionString: "65535.255.255",
    ...extra,
  };
}

const ios = runtimeId("26-5");
describe("chooseIosDeviceType newest hardware", () => {
  for (const [order, types] of catalogs) {
    for (const [version, phone, tablet] of expected) {
      for (const family of ["phone", "tablet", undefined] as const) {
        test(`${order}: iOS ${version}, ${family ?? "default phone"}`, () => {
          const result = chooseIosDeviceType(runtimeId(version), runtimes, types, family);
          expect(result).toBe(typeId(family === "tablet" ? tablet : phone));
          expect(result).not.toContain("iPod");
        });
      }
    }
  }

  test("iOS 26.5 tablet replaces the old fourth-generation iPad Pro", () => {
    const result = chooseIosDeviceType(ios, runtimes, captured, "tablet");
    const selected = captured.find((entry) => entry.identifier === result)!;
    expect(result).not.toBe(typeId("iPad-Pro-12.9-inch-4th-generation"));
    expect(Number(selected.modelIdentifier!.match(/^iPad(\d+),/)![1])).toBeGreaterThanOrEqual(17);
    expect(selected.name).toBe("iPad Pro 11-inch (M5)");
    expect(selected.name).not.toContain("(16GB)");
  });

  test("unparseable model identifiers preserve last-in-catalog selection", () => {
    const types = [
      synthetic("iPhone-first"),
      synthetic("iPhone-last", { modelIdentifier: "invalid" }),
    ];
    expect(chooseIosDeviceType(ios, runtimes, types)).toBe(types[1].identifier);
    expect(chooseIosDeviceType(ios, runtimes, types.toReversed())).toBe(types[0].identifier);
  });

  test("parseable hardware outranks unparseable hardware within either tier", () => {
    for (const bounds of [
      {},
      { minRuntimeVersionString: undefined, maxRuntimeVersionString: undefined },
    ]) {
      const types = [
        synthetic("iPhone-parsed", { modelIdentifier: "iPhone18,1", ...bounds }),
        synthetic("iPhone-unparsed", bounds),
      ];
      expect(chooseIosDeviceType(ios, runtimes, types)).toBe(types[0].identifier);
    }
  });

  test("supported tier beats newer hardware with unknown compatibility", () => {
    const types = [
      synthetic("iPhone-supported", { modelIdentifier: "iPhone15,2" }),
      synthetic("iPhone-unknown", {
        modelIdentifier: "iPhone19,2",
        minRuntimeVersionString: undefined,
        maxRuntimeVersionString: undefined,
      }),
    ];
    expect(chooseIosDeviceType(ios, runtimes, types)).toBe(types[0].identifier);
    expect(chooseIosDeviceType(ios, runtimes, [types[1]])).toBe(types[1].identifier);
  });

  test("equal hardware chooses shorter name, then ascending identifier", () => {
    const types = [
      synthetic("iPhone-B", { modelIdentifier: "iPhone18,1", name: "Pro" }),
      synthetic("iPhone-A", { modelIdentifier: "iPhone18,1", name: "Pro" }),
      synthetic("iPhone-C", { modelIdentifier: "iPhone18,1", name: "Pro (16GB)" }),
    ];
    expect(chooseIosDeviceType(ios, runtimes, types)).toBe(types[1].identifier);
    expect(chooseIosDeviceType(ios, runtimes, types.toReversed())).toBe(types[1].identifier);
  });

  test("default family excludes iPod even when it is the only candidate", () => {
    expect(
      chooseIosDeviceType(ios, runtimes, [synthetic("iPod-touch", { modelIdentifier: "iPod9,1" })]),
    ).toBeUndefined();
  });

  test("missing or unavailable runtime returns undefined", () => {
    expect(chooseIosDeviceType("missing", runtimes, captured)).toBeUndefined();
    expect(
      chooseIosDeviceType(
        ios,
        runtimes.map((entry) => ({ ...entry, isAvailable: false })),
        captured,
      ),
    ).toBeUndefined();
  });
});
