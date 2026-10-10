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

function parseListing(payload: unknown) {
  const parsed = parseDevicectlDeviceList(payload);
  expect(parsed.ok).toBe(true);
  if (!parsed.ok) {
    throw new Error(parsed.reason);
  }
  return parsed;
}

function parseFixture(name: string) {
  return parseListing(JSON.parse(loadDevicectlListFixture(name)) as unknown);
}

const PHYSICAL_UDID = "00008120-001C2D3E1234567A";

type DerivedListing = ReturnType<typeof loadDerivedDevicectlListing>;
type PayloadGeneration = "both" | "propertiesOnly" | "deprecatedOnly";

function deriveGeneration({
  listing,
  generation,
}: {
  listing: DerivedListing;
  generation: PayloadGeneration;
}): DerivedListing {
  // DERIVED in-memory copies: preserve both groups or delete only captured field groups.
  const derived = structuredClone(listing);
  for (const record of derived.result.devices) {
    if (generation === "propertiesOnly") {
      delete record.hardwareProperties;
      delete record.deviceProperties;
      delete record.connectionProperties;
      Reflect.deleteProperty(record, "_deprecationNotice");
    } else if (generation === "deprecatedOnly") {
      Reflect.deleteProperty(record, "properties");
    }
  }
  return derived;
}

function capturedLister(
  readFile: () => Promise<string>,
  options: Pick<ConstructorParameters<typeof DevicectlDeviceLister>[0], "timer" | "logger"> = {},
) {
  return new DevicectlDeviceLister({
    platform: () => "darwin",
    timer: new FakeTimer(),
    observationSequence: new FakeDiscoveryObservationSequence(),
    execute: async () => createExecResult("", ""),
    readFile,
    mkdtemp: async () => "/fake/devicectl",
    rm: async () => {},
    tmpdir: () => "/fake",
    logger: { warn: () => {}, debug: () => {} },
    ...options,
  });
}

describe("devicectl list devices host captures", () => {
  for (const [bootState, reason] of [
    ["SHUTDOWN", "shutdown"],
    ["Booting", "booting"],
    ["shuttingDown", "shutting-down"],
    ["future", "not-booted"],
    [undefined, "not-booted"],
    ["BOOTED", "unreachable"],
  ] as const) {
    test(`DERIVED captured simulator with bootState=${bootState} maps to ${reason} and stays complete`, async () => {
      const listing = loadDerivedDevicectlListing();
      const record = listing.result.devices[0];
      if (bootState === undefined) {
        Reflect.deleteProperty(record.properties.state, "bootState");
      } else {
        record.properties.state.bootState = bootState;
      }
      record.properties.connection.state = "disconnected";
      expect(parseDevicectlDeviceList([record])).toMatchObject({
        ok: true,
        notAvailable: [{ reason }],
        unidentified: [],
      });
      expect(
        await capturedLister(async () => JSON.stringify(listing)).listConnectedDevices(),
      ).toEqual({
        complete: true,
        devices: [],
      });
    });
  }

  test("DERIVED visibilityClass substitutes only for missing reality with positive simulator evidence", async () => {
    for (const topLevel of [true, false]) {
      const listing = loadDerivedDevicectlListing();
      const record = listing.result.devices[0];
      delete record.properties.hardware.reality;
      if (!topLevel) {
        Reflect.deleteProperty(record, "visibilityClass");
      }
      expect(parseDevicectlDeviceList([record])).toMatchObject({
        simulators: [expect.anything()],
        unidentified: [],
      });
      expect(
        await capturedLister(async () => JSON.stringify(listing)).listConnectedDevices(),
      ).toEqual({ complete: true, devices: [] });
      const platform = record.properties.hardware.platform;
      delete record.properties.hardware.platform;
      expect(parseDevicectlDeviceList([record])).toMatchObject({
        simulators: [],
        unidentified: [expect.any(String)],
      });
      record.properties.hardware.platform = platform;
      record.properties.hardware.udid = "unknown-shape";
      expect(parseDevicectlDeviceList([record])).toMatchObject({
        simulators: [],
        unidentified: [expect.any(String)],
      });
      record.properties.hardware.udid = PHYSICAL_UDID;
      expect(parseDevicectlDeviceList([record])).toMatchObject({
        physical: [],
        unidentified: [expect.any(String)],
      });
    }
  });

  test("DERIVED explicit simulated reality ignores unknown visibility; unknown visibility alone identifies nothing", () => {
    const record = loadDerivedDevicectlListing().result.devices[0];
    record.visibilityClass = "unknown";
    record.properties.state.visibilityClass = "unknown";
    expect(parseDevicectlDeviceList([record])).toMatchObject({
      simulators: [expect.anything()],
      unidentified: [],
    });
    delete record.properties.hardware.reality;
    expect(parseDevicectlDeviceList([record])).toMatchObject({
      simulators: [],
      unidentified: [expect.any(String)],
    });
  });

  test("DERIVED physical reality contradicting simulator visibility is unidentified; top-level visibility wins", () => {
    const listing = loadDerivedDevicectlListing();
    const record = derivePhysicalDevicectlRecord(listing.result.devices[0], PHYSICAL_UDID);
    record.properties.state.visibilityClass = "simulators";
    expect(parseDevicectlDeviceList([record])).toMatchObject({
      physical: [],
      unidentified: [expect.any(String)],
    });
    record.properties.hardware.platform = "watchOS";
    expect(parseDevicectlDeviceList([record])).toMatchObject({
      physical: [],
      notAvailable: [],
      unidentified: [expect.any(String)],
    });
    record.properties.hardware.platform = "iOS";
    record.visibilityClass = "unknown";
    expect(parseDevicectlDeviceList([record])).toMatchObject({
      physical: [expect.anything()],
      unidentified: [],
    });
    record.visibilityClass = "simulators";
    record.properties.state.visibilityClass = "unknown";
    expect(parseDevicectlDeviceList([record])).toMatchObject({
      physical: [],
      unidentified: [expect.any(String)],
    });
    record.properties.hardware.reality = "future";
    expect(parseDevicectlDeviceList([record])).toMatchObject({
      simulators: [],
      physical: [],
      unidentified: [expect.any(String)],
    });
  });

  test("DERIVED only unidentified records yield an incomplete empty listing", async () => {
    const listing = loadDerivedDevicectlListing();
    listing.result.devices = [listing.result.devices[0]];
    listing.result.devices[0].properties.hardware.platform = "futureOS";
    expect(parseListing(listing).unidentified).toHaveLength(1);
    expect(
      await capturedLister(async () => JSON.stringify(listing)).listConnectedDevices(),
    ).toMatchObject({ complete: false, devices: [] });
  });

  test("DERIVED cold sweep skips an unidentified record and includes its recognized phone", async () => {
    // DERIVED connected physical phone plus schema drift in a captured simulator record.
    const listing = loadDerivedDevicectlListing();
    listing.result.devices.push(
      derivePhysicalDevicectlRecord(listing.result.devices[0], PHYSICAL_UDID),
    );
    listing.result.devices[0].properties.hardware.reality = "future";
    const discovery = await capturedLister(async () =>
      JSON.stringify(listing),
    ).listConnectedDevices();
    expect(discovery.complete).toBe(false);
    expect(discovery.devices.map((device) => device.deviceId)).toEqual([PHYSICAL_UDID]);
    expect(discovery.devices[0]?.observedAt).toBe(1);
  });

  test("DERIVED sweep with an unidentified record is incomplete and replays last-good alongside recognized devices", async () => {
    const timer = new FakeTimer();
    const retainedId = "00008120-001C2D3E1234567B";
    // DERIVED previous-good phone D, using the captured connected simulator's record shape.
    const good = loadDerivedDevicectlListing();
    good.result.devices.push(derivePhysicalDevicectlRecord(good.result.devices[0], retainedId));
    let raw = JSON.stringify(good);
    const lister = capturedLister(async () => raw, { timer });
    await lister.listConnectedDevices();
    // DERIVED recognized phone plus an unidentified captured record.
    const partial = loadDerivedDevicectlListing();
    partial.result.devices.push(
      derivePhysicalDevicectlRecord(partial.result.devices[0], PHYSICAL_UDID),
    );
    partial.result.devices[0].properties.hardware.reality = "future";
    raw = JSON.stringify(partial);
    timer.advanceTime(3_000);
    const complete = await lister.listConnectedDevices();
    expect(complete.complete).toBe(false);
    expect(complete.devices.map((device) => device.deviceId).sort()).toEqual(
      [PHYSICAL_UDID, retainedId].sort(),
    );
    expect(complete.devices.find((device) => device.deviceId === PHYSICAL_UDID)?.observedAt).toBe(
      2,
    );
    expect(complete.devices.find((device) => device.deviceId === retainedId)?.observedAt).toBe(1);
    // DERIVED previously seen device ID: the freshly recognized record replaces last-good.
    partial.result.devices[partial.result.devices.length - 1] = derivePhysicalDevicectlRecord(
      partial.result.devices[0],
      retainedId,
    );
    raw = JSON.stringify(partial);
    timer.advanceTime(3_000);
    const deduplicated = await lister.listConnectedDevices();
    expect(deduplicated.devices).toHaveLength(1);
    expect(deduplicated.devices[0]).toMatchObject({ deviceId: retainedId, observedAt: 3 });
    // DERIVED unsuccessful envelope; replay the latest complete sweep, including its fresh observation.
    raw = JSON.stringify({ ...partial, info: { outcome: "failed" } });
    timer.advanceTime(3_000);
    const failed = await lister.listConnectedDevices();
    expect(failed).toMatchObject({ complete: false, error: { code: "failed" } });
    expect(failed.devices.map((device) => device.deviceId)).toEqual([retainedId]);
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
    const capture = loadDerivedDevicectlListing(row.file);
    // DERIVED generations come only from deletion; the omit-deprecated capture has no legacy evidence.
    const generations: PayloadGeneration[] = capture.result.devices.every(
      (record) =>
        record.hardwareProperties && record.deviceProperties && record.connectionProperties,
    )
      ? ["both", "propertiesOnly", "deprecatedOnly"]
      : ["propertiesOnly"];

    test.each(generations)(
      `${row.file}: DERIVED %s preserves the entire captured parse`,
      async (generation) => {
        const listing = deriveGeneration({ listing: capture, generation });
        expect(parseListing(listing)).toEqual(parseFixture(row.sameStateAs ?? row.file));
        expect(
          await capturedLister(async () => JSON.stringify(listing)).listConnectedDevices(),
        ).toEqual({ complete: true, devices: [] });
      },
    );

    test.each(generations)(
      `${row.file}: DERIVED available %s exposes identical captured device fields`,
      (generation) => {
        // DERIVED availability: update every present generation before deleting field groups.
        const available = structuredClone(capture);
        for (const record of available.result.devices) {
          record.properties.state.bootState = "booted";
          record.properties.connection.state = "connected";
          if (record.deviceProperties) {
            record.deviceProperties.bootState = "booted";
          }
          if (record.connectionProperties) {
            record.connectionProperties.tunnelState = "connected";
          }
        }
        const parsed = parseListing(deriveGeneration({ listing: available, generation }));
        expect(parsed).toEqual(parseListing(available));
        expect(parsed).toMatchObject({
          ok: true,
          physical: [],
          notAvailable: [],
          unidentified: [],
        });
        expect(parsed.simulators).toHaveLength(8);
        expect(parsed.simulators).toEqual(
          capture.result.devices
            .map((record) => ({
              deviceId: record.properties.hardware.udid,
              name: record.properties.state.name,
              platform: "ios",
              iosVersion: record.properties.software.osVersionNumber.stringValue,
              osVersion: record.properties.software.osVersionNumber.stringValue,
              // All captured product types are iPhone models, including Duo.
              formFactor: "phone",
            }))
            .toSorted((a, b) => String(a.deviceId).localeCompare(String(b.deviceId))),
        );
        for (const device of parsed.simulators) {
          expect(device.name).not.toBe("");
          expect(device.iosVersion).toMatch(/^\d+\.\d+$/);
        }
      },
    );

    test.each(generations)(
      `${row.file}: DERIVED mixed %s has the same physical-only inventory`,
      async (generation) => {
        // DERIVED physical record, not hardware evidence; derive before removing properties.
        const mixed = structuredClone(capture);
        mixed.result.devices.push(
          derivePhysicalDevicectlRecord(capture.result.devices[0], PHYSICAL_UDID),
        );
        const listing = deriveGeneration({ listing: mixed, generation });
        const parsed = parseListing(listing);
        const baseline = parseListing(mixed);
        expect(parsed).toEqual(baseline);
        expect(parsed.unidentified).toEqual([]);
        const source = capture.result.devices[0];
        expect(parsed.physical).toEqual([
          {
            deviceId: PHYSICAL_UDID,
            name: source.properties.state.name,
            platform: "ios",
            iosVersion: source.properties.software.osVersionNumber.stringValue,
            osVersion: source.properties.software.osVersionNumber.stringValue,
            formFactor: "phone",
          },
        ]);
        expect(
          await capturedLister(async () => JSON.stringify(listing)).listConnectedDevices(),
        ).toEqual({
          complete: true,
          devices: baseline.physical.map((device) => ({ ...device, observedAt: 1 })),
        });
      },
    );

    test.each(generations)(
      `${row.file}: DERIVED unknown fields in %s leave parsing unchanged`,
      (generation) => {
        const listing = deriveGeneration({ listing: capture, generation });
        const baseline = parseListing(listing);
        // DERIVED arbitrary extras in every present group, without inventing a missing generation.
        for (const record of listing.result.devices) {
          Object.assign(record, { futureTopLevel: [null, "extra", 42] });
          if (record.properties) {
            Object.assign(record.properties, { futureProperties: { enabled: true } });
            Object.assign(record.properties.hardware, { futureHardware: "extra" });
          }
          for (const group of [
            record.hardwareProperties,
            record.deviceProperties,
            record.connectionProperties,
          ]) {
            if (group) {
              Object.assign(group, { futureDeprecated: { values: [false, 123] } });
            }
          }
        }
        expect(parseListing(listing)).toEqual(baseline);
      },
    );

    for (const field of ["platform", "udid"] as const) {
      test.each(generations)(
        `${row.file}: DERIVED missing ${field} in %s skips safely and lists the recognized phone`,
        async (generation) => {
          // DERIVED mixed inventory with one required simulator field absent from every present generation.
          const mixed = structuredClone(capture);
          mixed.result.devices.push(
            derivePhysicalDevicectlRecord(capture.result.devices[0], PHYSICAL_UDID),
          );
          const listing = deriveGeneration({ listing: mixed, generation });
          const record = listing.result.devices[0];
          for (const hardware of [record.properties?.hardware, record.hardwareProperties]) {
            if (hardware) {
              delete hardware[field];
            }
          }
          const parsed = parseListing(listing);
          expect(parsed.unidentified).toHaveLength(1);
          expect(parsed.physical.map((device) => device.deviceId)).toEqual([PHYSICAL_UDID]);
          expect(parsed.simulators.map((device) => device.deviceId)).toEqual(
            parseFixture(row.file)
              .simulators.map((device) => device.deviceId)
              .filter((udid) => udid !== capture.result.devices[0].properties.hardware.udid),
          );
          const warnings: string[] = [];
          const debug: string[] = [];
          const discovery = await capturedLister(async () => JSON.stringify(listing), {
            logger: {
              warn: (message) => {
                warnings.push(message);
              },
              debug: (message) => {
                debug.push(message);
              },
            },
          }).listConnectedDevices();
          expect(discovery.complete).toBe(false);
          expect(discovery.devices).toEqual(
            parsed.physical.map((device) => ({ ...device, observedAt: 1 })),
          );
          expect(
            warnings.filter((message) => message.includes("could not be identified")),
          ).toHaveLength(1);
          for (const message of [...warnings, ...debug]) {
            for (const captured of capture.result.devices) {
              expect(message).not.toContain(captured.identifier);
              expect(message).not.toContain(String(captured.properties.hardware.udid));
              expect(message).not.toContain(captured.properties.state.name);
            }
            expect(message).not.toContain(PHYSICAL_UDID);
          }
        },
      );
    }

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

    test(`${row.file}: DERIVED unidentified phone is incomplete and replays last-good inventory`, async () => {
      const timer = new FakeTimer();
      let listing = loadDerivedDevicectlListing(row.file);
      const phone = derivePhysicalDevicectlRecord(listing.result.devices[0], PHYSICAL_UDID);
      listing.result.devices.push(phone);
      const lister = capturedLister(async () => JSON.stringify(listing), { timer });
      const initial = await lister.listConnectedDevices();
      expect(initial.complete).toBe(true);
      // DERIVED schema drift: only the physical record's reality changes.
      phone.properties.hardware.reality = "future";
      if (phone.hardwareProperties) {
        phone.hardwareProperties.reality = "future";
      }
      timer.advanceTime(3_000);
      const partial = await lister.listConnectedDevices();
      expect(partial).toMatchObject({ complete: false });
      expect(partial.devices.map((device) => device.deviceId)).toEqual([PHYSICAL_UDID]);
      // A subsequent authoritative simulator-only listing clears retention.
      listing = loadDerivedDevicectlListing(row.file);
      timer.advanceTime(3_000);
      expect(await lister.listConnectedDevices()).toEqual({ complete: true, devices: [] });
    });

    for (const [field, value] of [
      ["udid", undefined],
      ["platform", undefined],
      ["reality", "future"],
      ["platform", "futureOS"],
      ["reality", "physical"],
      ["udid", PHYSICAL_UDID],
      ["udid", "unknown-shape"],
    ] as const) {
      for (const index of [0, 1]) {
        test(`${row.file}: DERIVED ${index === 0 ? "booted" : "shutdown"} simulator with ${field}=${value} is skipped in an incomplete listing`, async () => {
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
          });
        });
      }
    }

    test(`${row.file} matches its manifest classifications`, () => {
      const parsed = parseFixture(row.file);
      expect(parsed.physical).toHaveLength(row.physical);
      expect(parsed.simulators).toHaveLength(row.availableSimulators);
      expect(parsed.notAvailable).toHaveLength(row.notAvailable);
      if (row.notAvailableReasons) {
        const counts: Record<string, number> = {};
        for (const { reason } of parsed.notAvailable) {
          counts[reason] = (counts[reason] ?? 0) + 1;
        }
        expect(counts).toEqual(row.notAvailableReasons);
      }
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
