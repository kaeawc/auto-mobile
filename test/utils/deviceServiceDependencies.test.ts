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
    // The device and signal come from `request` (provider) or `this.device` / `signal` (action).
    const call = new RegExp(`assertEnabled\\(\\s*[\\w.]+,\\s*"${entry.tool}",\\s*[\\w.]+\\s*\\)`);
    expect(call.test(source)).toBe(true);
    for (const resource of entry.resources) {
      expect(Object.hasOwn(iosDeviceResourceCatalog, resource)).toBe(true);
      expect(Object.hasOwn(iosDeviceResourceImpact, resource)).toBe(true);
      expect(Object.hasOwn(deviceResourceDescriptions, resource)).toBe(true);
    }
  }
  expect(getDeviceServiceDependencies("putAppFile")).toEqual(
    deviceServiceDependencies.filter(({ tool }) => tool === "putAppFile"),
  );
  expect(getDeviceServiceDependencies("siri").map(({ resources }) => resources)).toEqual([
    ["siriAndAppIntents"],
  ]);
  expect(getDeviceServiceDependencies("observe")).toEqual([]);
});
