import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  parseLocationdAuthorization,
  SimulatorLocationdClientsReader,
} from "../../../src/utils/ios-cmdline-tools/SimulatorLocationdClients";

const FIXTURES = path.resolve(import.meta.dir, "../../fixtures/ios-locationd-clients");
const BUNDLE = "dev.jasonpearson.automobile.Playground";

function fixture(name: string): string {
  return readFileSync(path.join(FIXTURES, `clients-${name}.xml`), "utf8");
}

describe("parseLocationdAuthorization (#19370)", () => {
  test("reads the captured Authorization after each simctl privacy call", async () => {
    expect(await parseLocationdAuthorization(fixture("granted-location"), BUNDLE)).toBe(2);
    expect(await parseLocationdAuthorization(fixture("revoked-location"), BUNDLE)).toBe(1);
    expect(await parseLocationdAuthorization(fixture("granted-location-always"), BUNDLE)).toBe(4);
  });

  test("a reset entry and an unknown bundle read null", async () => {
    expect(await parseLocationdAuthorization(fixture("reset-location"), BUNDLE)).toBeNull();
    expect(
      await parseLocationdAuthorization(fixture("granted-location"), "com.example.absent"),
    ).toBeNull();
  });
});

describe("SimulatorLocationdClientsReader", () => {
  test("reads the device's locationd clients.plist", async () => {
    const paths: string[] = [];
    const reader = new SimulatorLocationdClientsReader({
      deviceDataRoot: (udid) => `/sims/${udid}`,
      plutilToXml: async (file) => {
        paths.push(file);
        return fixture("granted-location-always");
      },
    });
    expect(await reader.readLocationAuthorization("SIM-1", BUNDLE)).toBe(4);
    expect(paths).toEqual([
      path.join("/sims/SIM-1", "data/Library/Caches/locationd/clients.plist"),
    ]);
  });

  test("a missing clients.plist reads null", async () => {
    const reader = new SimulatorLocationdClientsReader({
      deviceDataRoot: (udid) => `/sims/${udid}`,
      plutilToXml: async () => {
        throw new Error("No such file or directory");
      },
    });
    expect(await reader.readLocationAuthorization("SIM-1", BUNDLE)).toBeNull();
  });
});
