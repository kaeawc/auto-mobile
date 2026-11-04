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
// roles gained "cluster" (#16741), and when form factors gained "xr-headset"/"xr-glasses" (#16838).
function fingerprint(schema: z.ZodType): string {
  const json = JSON.stringify(z.toJSONSchema(schema, { io: "input", unrepresentable: "any" }));
  return createHash("sha256").update(json).digest("hex").slice(0, 16);
}

describe("device tool schemas", () => {
  test.each([
    ["listDeviceImagesSchema", listDeviceImagesSchema, "82e3009fc71448de"],
    ["listDevicesSchema", listDevicesSchema, "599853357f687c5f"],
    ["listDevicesOutputSchema", listDevicesOutputSchema, "17cce0493f18f8c2"],
    ["killDeviceSchema", killDeviceSchema, "496e3b3b4185e167"],
    ["teardownDeviceSchema", teardownDeviceSchema, "6339d8cad2d9749c"],
  ])("%s keeps its JSON schema", (_name, schema, expected) => {
    expect(fingerprint(schema)).toBe(expected);
  });
});
