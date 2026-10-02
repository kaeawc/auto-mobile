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
  loadDerivedDevicectlListing,
  derivePhysicalDevicectlRecord,
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

const PHYSICAL_UDID = "00008120-001C2D3E1234567A";

function capturedLister(readFile: () => Promise<string>, timer = new FakeTimer()) {
  return new DevicectlDeviceLister({
    platform: () => "darwin",
    timer,
    observationSequence: new FakeDiscoveryObservationSequence(),
    execute: async () => createExecResult("", ""),
    readFile,
    mkdtemp: async () => "/fake/devicectl",
    rm: async () => {},
    tmpdir: () => "/fake",
    logger: { warn: () => {}, debug: () => {} },
  });
}

describe("devicectl list devices host captures", () => {
  test("DERIVED deprecated-only fields retain positive simulator evidence", async () => {
    const listing = loadDerivedDevicectlListing("list-devices-simulators-only.json");
    // DERIVED older payload: remove the modern field group, retaining captured deprecated fields.
    for (const record of listing.result.devices) {
      Reflect.deleteProperty(record, "properties");
    }
    const parsed = parseDevicectlDeviceList(listing);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.simulators).toHaveLength(2);
      expect(parsed.notAvailable).toHaveLength(6);
      expect(parsed.unidentified).toEqual([]);
    }
    expect(
      await capturedLister(async () => JSON.stringify(listing)).listConnectedDevices(),
    ).toEqual({
      complete: true,
      devices: [],
    });
  });

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
    test(`${row.file}: DERIVED missing reality and unknown UDID cannot be an unavailable simulator`, async () => {
      const listing = loadDerivedDevicectlListing(row.file);
      const record = listing.result.devices[1];
      for (const hardware of [record.properties.hardware, record.hardwareProperties]) {
        if (!hardware) {
          continue;
        }
        delete hardware.reality;
        hardware.udid = "unknown-shape";
      }
      expect(
        await capturedLister(async () => JSON.stringify(listing)).listConnectedDevices(),
      ).toMatchObject({
        complete: false,
        devices: [],
        error: { code: "failed" },
      });
    });

    for (const platform of ["watchOS", "tvOS", "xrOS", "visionOS"]) {
      test(`${row.file}: DERIVED known ${platform} record is positively excluded`, async () => {
        const listing = loadDerivedDevicectlListing(row.file);
        listing.result.devices[0].properties.hardware.platform = platform;
        const parsed = parseDevicectlDeviceList(listing);
        expect(parsed.ok).toBe(true);
        if (parsed.ok) {
          expect(parsed.unidentified).toEqual([]);
          expect(parsed.notAvailable).toContainEqual({ reason: "non-ios" });
        }
        expect(
          await capturedLister(async () => JSON.stringify(listing)).listConnectedDevices(),
        ).toEqual({
          complete: true,
          devices: [],
        });
      });
    }

    test(`${row.file}: DERIVED mixed inventory contains only the physical phone`, async () => {
      const listing = loadDerivedDevicectlListing(row.file);
      listing.result.devices.push(
        derivePhysicalDevicectlRecord(listing.result.devices[0], PHYSICAL_UDID),
      );
      const discovery = await capturedLister(async () =>
        JSON.stringify(listing),
      ).listConnectedDevices();
      expect(discovery.complete).toBe(true);
      expect(discovery.devices.map((device) => device.deviceId)).toEqual([PHYSICAL_UDID]);
    });

    test(`${row.file}: DERIVED unidentified phone retains last-good inventory`, async () => {
      const timer = new FakeTimer();
      let listing = loadDerivedDevicectlListing(row.file);
      const phone = derivePhysicalDevicectlRecord(listing.result.devices[0], PHYSICAL_UDID);
      listing.result.devices.push(phone);
      const lister = capturedLister(async () => JSON.stringify(listing), timer);
      const initial = await lister.listConnectedDevices();
      expect(initial.complete).toBe(true);
      // DERIVED schema drift: only the physical record's reality changes.
      phone.properties.hardware.reality = "future";
      if (phone.hardwareProperties) {
        phone.hardwareProperties.reality = "future";
      }
      timer.advanceTime(3_000);
      const partial = await lister.listConnectedDevices();
      expect(partial).toMatchObject({ complete: false, error: { code: "failed" } });
      expect(partial.devices).toEqual(initial.devices);
      expect(partial.devices.map((device) => device.deviceId)).toEqual([PHYSICAL_UDID]);
      // A subsequent authoritative simulator-only listing clears retention.
      listing = loadDerivedDevicectlListing(row.file);
      timer.advanceTime(3_000);
      expect(await lister.listConnectedDevices()).toEqual({ complete: true, devices: [] });
    });

    for (const [field, value] of [
      ["reality", undefined],
      ["udid", undefined],
      ["platform", undefined],
      ["reality", "future"],
      ["platform", "futureOS"],
      ["reality", "physical"],
      ["udid", PHYSICAL_UDID],
      ["udid", "unknown-shape"],
    ] as const) {
      for (const index of [0, 1]) {
        test(`${row.file}: DERIVED ${index === 0 ? "booted" : "shutdown"} simulator with ${field}=${value} is incomplete`, async () => {
          const listing = loadDerivedDevicectlListing(row.file);
          const record = listing.result.devices[index];
          // DERIVED field deletion/change in both copies; all other capture fields remain verbatim.
          for (const hardware of [record.properties.hardware, record.hardwareProperties]) {
            if (!hardware) {
              continue;
            }
            if (value === undefined) {
              delete hardware[field];
            } else {
              hardware[field] = value;
            }
          }
          const parsed = parseDevicectlDeviceList(listing);
          expect(parsed.ok).toBe(true);
          if (parsed.ok) {
            expect(parsed.unidentified).toHaveLength(1);
          }
          expect(
            await capturedLister(async () => JSON.stringify(listing)).listConnectedDevices(),
          ).toMatchObject({
            complete: false,
            devices: [],
            error: { code: "failed" },
          });
        });
      }
    }

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
