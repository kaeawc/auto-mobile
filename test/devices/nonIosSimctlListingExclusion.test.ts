import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Simctl } from "../../src/utils/ios-cmdline-tools/SimCtlClient";
import {
  isIosDeviceType,
  isIosSimulatorRuntime,
} from "../../src/utils/ios-cmdline-tools/simulatorRuntimeFamily";
import type { ExecResult } from "../../src/models";
import type { AppleDeviceType } from "../../src/utils/ios-cmdline-tools/SimCtlSupport";
import { createExecResult } from "../../src/utils/execResult";
import { FakeTimer } from "../fakes/FakeTimer";
import { WATCH_RUNTIME_ID, watchDevice } from "../fakes/FakeWatchSimctl";
import {
  TVOS_RUNTIME_ID,
  XROS_RUNTIME_ID,
  appleTvDevice,
  visionProDevice,
} from "../fakes/nonIosAppleSimulators";

// `simctl list devices --json` groups every simulator by runtime. The iOS listing keeps only iOS
// runtimes, so a booted Apple TV or Vision Pro is never published as `platform: "ios"` and driven
// as an iPhone by CtrlProxy, prototypes, keyboard or biometric setup (#15885).

const IOS_RUNTIME = "com.apple.CoreSimulator.SimRuntime.iOS-18-6";

interface CapturedList {
  devices: Record<string, Array<Record<string, unknown>>>;
}

const captured = JSON.parse(
  readFileSync(join(import.meta.dir, "../fixtures/ios-simctl/list-devices.json"), "utf8"),
) as CapturedList;

const iosRow = captured.devices[IOS_RUNTIME][0];
const capturedDeviceTypes = (
  JSON.parse(
    readFileSync(
      join(import.meta.dir, "../fixtures/ios-devicetype-order/xcode-26.6-devicetypes.json"),
      "utf8",
    ),
  ) as { devicetypes: AppleDeviceType[] }
).devicetypes;

/** iOS, watchOS, tvOS and xrOS runtimes on one host, each with one simulator in `state`. */
function mixedHost(state: string): CapturedList["devices"] {
  return {
    [IOS_RUNTIME]: [{ ...iosRow, state }],
    [WATCH_RUNTIME_ID]: [{ ...watchDevice({ state }) }],
    [TVOS_RUNTIME_ID]: [{ ...appleTvDevice({ state }) }],
    [XROS_RUNTIME_ID]: [{ ...visionProDevice({ state }) }],
  };
}

function simctlFor(devices: CapturedList["devices"]): Simctl {
  const payload = JSON.stringify({ ...captured, devices });
  const exec = async (file: string, args: string[]): Promise<ExecResult> =>
    file === "xcrun" && args.join(" ") === "simctl list devices --json"
      ? createExecResult(payload, "")
      : createExecResult("", "");
  return new Simctl(null, exec, { timer: new FakeTimer() });
}

describe("iOS simulator listing excludes Apple TV and Vision Pro simulators", () => {
  beforeEach(() => Simctl.invalidateDeviceListCache());
  afterEach(() => Simctl.invalidateDeviceListCache());

  test("only the iPhone of a booted mixed host is a booted iOS simulator", async () => {
    const booted = await simctlFor(mixedHost("Booted")).getBootedSimulatorsChecked();

    expect(booted.map((device) => [device.deviceId, device.platform])).toEqual([
      [String(iosRow.udid), "ios"],
    ]);
  });

  test("shut-down Apple TV and Vision Pro simulators are not iOS images", async () => {
    const images = await simctlFor(mixedHost("Shutdown")).listSimulatorImages();

    expect(images.map((device) => [device.deviceId, device.platform])).toEqual([
      [String(iosRow.udid), "ios"],
    ]);
  });

  test("a booting Apple TV or Vision Pro is not a transitional iOS simulator", async () => {
    const listing = await simctlFor({
      [TVOS_RUNTIME_ID]: [{ ...appleTvDevice({ state: "Booting" }) }],
      [XROS_RUNTIME_ID]: [{ ...visionProDevice({ state: "Booting" }) }],
    }).getSimulatorListingChecked();

    expect(listing).toEqual({ booted: [], transitional: [] });
  });

  test("an Apple TV or Vision Pro never resolves as an iOS device by udid", async () => {
    const client = simctlFor(mixedHost("Booted"));

    expect(await client.getDeviceInfo(appleTvDevice().udid)).toBeNull();
    expect(await client.getDeviceInfo(visionProDevice().udid)).toBeNull();
  });

  test("an iOS-only host lists exactly what it listed before", async () => {
    const withOthers = await simctlFor({
      ...captured.devices,
      [TVOS_RUNTIME_ID]: [{ ...appleTvDevice() }],
      [XROS_RUNTIME_ID]: [{ ...visionProDevice() }],
    }).listSimulatorImages();
    Simctl.invalidateDeviceListCache();

    const iosOnly = await simctlFor(captured.devices).listSimulatorImages();

    expect(iosOnly.length).toBeGreaterThan(0);
    expect(iosOnly).toEqual(withOthers);
  });
});

describe("iOS simulator family predicates", () => {
  test("only iOS runtimes are iOS", () => {
    expect(isIosSimulatorRuntime(IOS_RUNTIME)).toBe(true);
    expect(isIosSimulatorRuntime(WATCH_RUNTIME_ID)).toBe(false);
    expect(isIosSimulatorRuntime(TVOS_RUNTIME_ID)).toBe(false);
    expect(isIosSimulatorRuntime(XROS_RUNTIME_ID)).toBe(false);
  });

  test("only iPhone and iPad models (the Duo included) are iOS device types", () => {
    const families = (types: AppleDeviceType[]) => [
      ...new Set(types.map((type) => type.productFamily)),
    ];
    const ios = capturedDeviceTypes.filter((type) => isIosDeviceType(type));
    const other = capturedDeviceTypes.filter((type) => !isIosDeviceType(type));

    expect(families(ios).sort()).toEqual(["iPad", "iPhone"]);
    expect(families(other).sort()).toEqual(["Apple TV", "Apple Vision", "Apple Watch"]);
    expect(ios.map((type) => type.identifier)).toContain(
      "com.apple.CoreSimulator.SimDeviceType.iPhone-Duo",
    );
  });

  test("the Duo is iOS by identifier even if its product family changes", () => {
    expect(
      isIosDeviceType({
        identifier: "com.apple.CoreSimulator.SimDeviceType.iPhone-Duo",
        productFamily: "Duo",
      }),
    ).toBe(true);
  });
});
