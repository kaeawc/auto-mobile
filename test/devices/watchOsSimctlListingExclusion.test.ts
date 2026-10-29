import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Simctl } from "../../src/utils/ios-cmdline-tools/SimCtlClient";
import type { ExecResult } from "../../src/models";
import { createExecResult } from "../../src/utils/execResult";
import { FakeTimer } from "../fakes/FakeTimer";

// `simctl list devices --json` groups every simulator by runtime, Apple Watch ones included. The
// iOS listing must never publish a watch as `platform: "ios"`, or readiness, pools and iOS-only
// tools would drive it as an iPhone (#14901, docs/decisions/watchos-platform.md).

const IOS_RUNTIME = "com.apple.CoreSimulator.SimRuntime.iOS-18-6";
const WATCH_RUNTIME = "com.apple.CoreSimulator.SimRuntime.watchOS-11-0";
const WATCH_UDID = "6B1F3C2E-0000-4000-8000-00000000A7C1";

interface CapturedList {
  devices: Record<string, Array<Record<string, unknown>>>;
}

const captured = JSON.parse(
  readFileSync(join(import.meta.dir, "../fixtures/ios-simctl/list-devices.json"), "utf8"),
) as CapturedList;

const iosRow = captured.devices[IOS_RUNTIME][0];

/** The captured iPhone row, re-keyed as a watch: simctl uses the same row shape for both. */
function watchRow(state: string): Record<string, unknown> {
  return {
    ...iosRow,
    udid: WATCH_UDID,
    name: "Apple Watch Series 10 (46mm)",
    deviceTypeIdentifier: "com.apple.CoreSimulator.SimDeviceType.Apple-Watch-Series-10-46mm",
    state,
  };
}

function simctlFor(devices: CapturedList["devices"]): { client: Simctl; calls: string[] } {
  const calls: string[] = [];
  const payload = JSON.stringify({ ...captured, devices });
  const exec = async (file: string, args: string[]): Promise<ExecResult> => {
    calls.push(`${file} ${args.join(" ")}`);
    return file === "xcrun" && args.join(" ") === "simctl list devices --json"
      ? createExecResult(payload, "")
      : createExecResult("", "");
  };
  return { client: new Simctl(null, exec, { timer: new FakeTimer() }), calls };
}

describe("iOS simulator listing excludes Apple Watch simulators", () => {
  beforeEach(() => Simctl.invalidateDeviceListCache());
  afterEach(() => Simctl.invalidateDeviceListCache());

  test("a booted watch is not a booted iOS simulator", async () => {
    const iosBooted = { ...iosRow, state: "Booted" };
    const { client } = simctlFor({
      [IOS_RUNTIME]: [iosBooted],
      [WATCH_RUNTIME]: [watchRow("Booted")],
    });

    const booted = await client.getBootedSimulatorsChecked();

    expect(booted.map((device) => [device.deviceId, device.platform])).toEqual([
      [String(iosRow.udid), "ios"],
    ]);
  });

  test("a shutdown watch is not an iOS simulator image", async () => {
    const { client } = simctlFor({
      [IOS_RUNTIME]: [iosRow],
      [WATCH_RUNTIME]: [watchRow("Shutdown")],
    });

    const images = await client.listSimulatorImages();

    expect(images.map((device) => device.deviceId)).toEqual([String(iosRow.udid)]);
    expect(images.every((device) => device.platform === "ios")).toBe(true);
  });

  test("a booting watch is not a transitional iOS simulator", async () => {
    const { client } = simctlFor({ [WATCH_RUNTIME]: [watchRow("Booting")] });

    const listing = await client.getSimulatorListingChecked();

    expect(listing).toEqual({ booted: [], transitional: [] });
  });

  test("a watch never resolves as an iOS device by udid", async () => {
    const { client } = simctlFor({ [WATCH_RUNTIME]: [watchRow("Booted")] });

    expect(await client.getDeviceInfo(WATCH_UDID)).toBeNull();
  });

  test("a listing without watches is unchanged", async () => {
    const { client: withWatch } = simctlFor({
      ...captured.devices,
      [WATCH_RUNTIME]: [watchRow("Shutdown")],
    });
    const withWatchImages = await withWatch.listSimulatorImages();
    Simctl.invalidateDeviceListCache();
    const { client: withoutWatch } = simctlFor(captured.devices);

    expect(await withoutWatch.listSimulatorImages()).toEqual(withWatchImages);
  });
});
