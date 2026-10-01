import { describe, expect, test } from "bun:test";
import {
  DevicectlDeviceLister,
  parseDevicectlDeviceList,
} from "../../../src/utils/ios-cmdline-tools/DevicectlDeviceLister";
import { createExecResult } from "../../../src/utils/execResult";
import {
  DEVICECTL_FIXTURE_MANIFEST,
  loadDevicectlFixtureManifest,
  loadDevicectlListFixture,
} from "../../helpers/devicectlListFixtures";
import { FakeTimer } from "../../fakes/FakeTimer";
import { FakeDiscoveryObservationSequence } from "../../fakes/FakeDiscoveryObservationSequence";

function parseFixture(name: string) {
  const parsed = parseDevicectlDeviceList(JSON.parse(loadDevicectlListFixture(name)) as unknown);
  expect(parsed.ok).toBe(true);
  if (!parsed.ok) {
    throw new Error(parsed.reason);
  }
  return parsed;
}

describe("devicectl list devices host captures", () => {
  test("manifest pairing rejects zero captures, missing rows, and orphaned rows", () => {
    const names = DEVICECTL_FIXTURE_MANIFEST.map((row) => row.file);
    expect(() => loadDevicectlFixtureManifest([], [])).toThrow("No devicectl");
    expect(() => loadDevicectlFixtureManifest([...names, "list-devices-new.json"])).toThrow(
      "capture has no manifest row",
    );
    expect(() => loadDevicectlFixtureManifest(names.slice(1))).toThrow(
      "manifest row has no capture",
    );
  });

  for (const row of DEVICECTL_FIXTURE_MANIFEST) {
    test(`${row.file} matches its manifest classifications`, () => {
      const parsed = parseFixture(row.file);
      expect(parsed.physical).toHaveLength(row.physical);
      expect(parsed.simulators).toHaveLength(row.availableSimulators);
      expect(parsed.notAvailable).toHaveLength(row.notAvailable);
      expect(parsed.unidentified).toHaveLength(row.unidentified);
      if (row.physicalUdids) {
        expect(parsed.physical.map((device) => device.deviceId)).toEqual(row.physicalUdids);
      }
      if (row.simulatorUdids) {
        expect(parsed.simulators.map((device) => device.deviceId)).toEqual(row.simulatorUdids);
      }
      if (row.sameStateAs) {
        expect(parsed).toEqual(parseFixture(row.sameStateAs));
      }
    });

    test(`${row.file} matches its manifest physical inventory and completeness`, async () => {
      const parsed = parseFixture(row.file);
      const lister = new DevicectlDeviceLister({
        platform: () => "darwin",
        timer: new FakeTimer(),
        observationSequence: new FakeDiscoveryObservationSequence(),
        execute: async () => createExecResult("", ""),
        readFile: async () => loadDevicectlListFixture(row.file),
        mkdtemp: async () => "/fake/devicectl",
        rm: async () => {},
        tmpdir: () => "/fake",
        logger: { warn: () => {}, debug: () => {} },
      });
      const discovery = await lister.listConnectedDevices();
      expect(discovery.complete).toBe(row.complete);
      expect(discovery.devices).toHaveLength(row.physical);
      expect(discovery.devices).toEqual(
        parsed.physical.map((device) => ({ ...device, observedAt: 1 })),
      );
    });
  }
});
