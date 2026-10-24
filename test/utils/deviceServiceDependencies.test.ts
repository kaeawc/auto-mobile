import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import {
  deviceServiceDependencies,
  getDeviceServiceDependencies,
} from "../../src/utils/deviceServiceDependencies";
import { iosDeviceResourceCatalog } from "../../src/utils/iosDeviceResourceCatalog";
import { iosDeviceResourceImpact } from "../../src/utils/iosDeviceResourceImpact";
import { deviceResourceDescriptions } from "../../src/models/deviceResourceDescriptions";
import definitions from "../../schemas/tool-definitions.json";

test("every dependency has registered metadata and a literal preflight call", () => {
  const pairs = new Set<string>();
  for (const entry of deviceServiceDependencies) {
    const key = JSON.stringify([entry.tool, entry.scope]);
    expect(pairs.has(key)).toBe(false);
    pairs.add(key);
    expect(definitions.some(({ name }) => name === entry.tool)).toBe(true);
    expect(entry.unavailable.trim().length).toBeGreaterThan(0);
    expect(existsSync(entry.preflight)).toBe(true);
    const source = readFileSync(entry.preflight, "utf8");
    expect(source.includes(`assertEnabled(request.device, "${entry.tool}", request.signal)`)).toBe(
      true,
    );
    for (const resource of entry.resources) {
      expect(Object.hasOwn(iosDeviceResourceCatalog, resource)).toBe(true);
      expect(Object.hasOwn(iosDeviceResourceImpact, resource)).toBe(true);
      expect(Object.hasOwn(deviceResourceDescriptions, resource)).toBe(true);
    }
  }
  expect(getDeviceServiceDependencies("putAppFile")).toEqual(deviceServiceDependencies);
  expect(getDeviceServiceDependencies("observe")).toEqual([]);
});
