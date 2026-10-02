import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import manifest from "../fixtures/ios-devicectl/manifest.json";

const FIXTURE_DIRECTORY = join(import.meta.dir, "../fixtures/ios-devicectl");

export interface DevicectlFixtureExpectation {
  file: string;
  physical: number;
  availableSimulators: number;
  notAvailable: number;
  unidentified: number;
  /** True only if the envelope and every record are positively classified. */
  complete: boolean;
  physicalUdids?: string[];
  simulatorUdids?: string[];
  sameStateAs?: string;
}

/** Directory and metadata inputs let the pairing contract be tested without disk writes. */
export function loadDevicectlFixtureManifest(
  captures = readdirSync(FIXTURE_DIRECTORY).filter(
    (name) => name.startsWith("list-devices-") && name.endsWith(".json"),
  ),
  rows: DevicectlFixtureExpectation[] = manifest,
): DevicectlFixtureExpectation[] {
  if (captures.length === 0) {
    throw new Error("No devicectl list-devices captures found");
  }
  const files = new Set(rows.map((row) => row.file));
  if (files.size !== rows.length) {
    throw new Error("Duplicate devicectl fixture manifest row");
  }
  for (const file of captures) {
    if (!files.has(file)) {
      throw new Error(`Devicectl capture has no manifest row: ${file}`);
    }
  }
  for (const row of rows) {
    if (!captures.includes(row.file)) {
      throw new Error(`Devicectl manifest row has no capture: ${row.file}`);
    }
    if (row.sameStateAs && !files.has(row.sameStateAs)) {
      throw new Error(`Unknown devicectl sameStateAs capture: ${row.sameStateAs}`);
    }
  }
  return rows;
}

export const DEVICECTL_FIXTURE_MANIFEST = loadDevicectlFixtureManifest();
export const DEVICECTL_LIST_FIXTURES = DEVICECTL_FIXTURE_MANIFEST.map((row) => row.file);

/** Verbatim host captures; later hardware captures use the same loader. */
export function loadDevicectlListFixture(name: string): string {
  return readFileSync(join(FIXTURE_DIRECTORY, name), "utf8");
}

interface DerivedDevicectlRecord {
  identifier: string;
  properties: {
    hardware: Record<string, unknown>;
    state: { bootState: string };
    connection: { state: string };
  };
  hardwareProperties?: Record<string, unknown>;
}

/** DERIVED in memory from a capture; never represents additional host evidence. */
export function loadDerivedDevicectlListing(
  name = "list-devices-simulators-only-omit-deprecated.json",
): { result: { devices: DerivedDevicectlRecord[] } } {
  return JSON.parse(loadDevicectlListFixture(name));
}

/** DERIVED physical shape: change only reality/udid/platform on a captured record. */
export function derivePhysicalDevicectlRecord(record: DerivedDevicectlRecord, udid: string) {
  const derived = structuredClone(record);
  for (const hardware of [derived.properties.hardware, derived.hardwareProperties]) {
    if (hardware) {
      Object.assign(hardware, { reality: "physical", udid, platform: "iOS" });
    }
  }
  return derived;
}
