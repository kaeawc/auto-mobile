import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseProvisioningProfileXml } from "../../../src/utils/ios-cmdline-tools/provisioningProfileFields";

const profileXml = readFileSync(
  join(import.meta.dir, "../../fixtures/ios-signing/embedded-mobileprovision-development.plist"),
  "utf8",
);

describe("parseProvisioningProfileXml (#14099)", () => {
  test("lifts identity, dates, devices and entitlements from a decoded profile", async () => {
    const fields = await parseProvisioningProfileXml(profileXml);
    expect(fields).toMatchObject({
      uuid: "8F6C2B1A-3D4E-4F50-9A6B-7C8D9E0F1A2B",
      name: "iOS Team Provisioning Profile: dev.jasonpearson.automobile.Playground",
      teamIds: ["ABCDE12345"],
      teamName: "Jane Appleseed",
      provisionsAllDevices: false,
      provisionedDevices: ["00008110-001A2B3C4D5E801E", "00008120-000F1E2D3C4B5A6E"],
    });
    expect(fields?.expirationDate.toISOString()).toBe("2027-04-21T09:00:00.000Z");
    expect(fields?.creationDate?.toISOString()).toBe("2026-04-21T09:00:00.000Z");
    expect(fields?.entitlements["get-task-allow"]).toBe(true);
  });

  test("a profile without ExpirationDate yields an invalid date, not a throw", async () => {
    const fields = await parseProvisioningProfileXml(
      '<?xml version="1.0"?><plist version="1.0"><dict><key>Name</key><string>x</string></dict></plist>',
    );
    expect(Number.isNaN(fields?.expirationDate.getTime())).toBe(true);
    expect(fields?.provisionedDevices).toBeNull();
  });
});
