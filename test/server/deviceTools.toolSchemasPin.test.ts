import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { z } from "zod/v4";
import {
  killDeviceSchema,
  listDeviceImagesSchema,
  listDevicesOutputSchema,
  listDevicesSchema,
  teardownDeviceSchema,
} from "../../src/server/deviceTools";

// Pins the device tool schemas captured before they moved to
// features/deviceLifecycle/core/toolSchemas (#11827): a drift here changes the wire contract.
// Re-pinned when the platform enums gained "tvos" (#15886 follow-up), and when panel roles gained
// "overlay" (#13138), when descriptions gained the automotive `vehicle` (#16767), and when panel
// roles gained "cluster" (#16741), when form factors gained "xr-headset"/"xr-glasses" (#16838), and
// when listDevices and device descriptions gained the watchOS/tvOS/visionOS platforms (#17320).
function fingerprint(schema: z.ZodType): string {
  const json = JSON.stringify(z.toJSONSchema(schema, { io: "input", unrepresentable: "any" }));
  return createHash("sha256").update(json).digest("hex").slice(0, 16);
}

describe("device tool schemas", () => {
  test.each([
    ["listDeviceImagesSchema", listDeviceImagesSchema, "6e36e4f0ac8620b8"],
    ["listDevicesSchema", listDevicesSchema, "5d79d40ab5756996"],
    ["listDevicesOutputSchema", listDevicesOutputSchema, "85e31ba8e309f944"],
    ["killDeviceSchema", killDeviceSchema, "38ea51a687408052"],
    ["teardownDeviceSchema", teardownDeviceSchema, "66eef42ef74e612b"],
  ])("%s keeps its JSON schema", (_name, schema, expected) => {
    expect(fingerprint(schema)).toBe(expected);
  });
});
