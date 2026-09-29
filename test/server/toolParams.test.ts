import { describe, expect, test } from "bun:test";
import { z } from "zod/v4";
import {
  getAndroidSchema,
  killDeviceSchema,
  listDeviceImagesSchema,
  listDevicesSchema,
} from "../../src/server/deviceTools";
import { stripUndeclaredSessionUuid } from "../../src/utils/toolParams";

describe("stripUndeclaredSessionUuid", () => {
  const sessionUuid = "11111111-2222-3333-4444-555555555555";

  test.each([
    [
      "killDevice",
      killDeviceSchema,
      { device: { name: "Pixel", deviceId: "emulator-5554", platform: "android" } },
    ],
    ["listDevices", listDevicesSchema, {}],
    ["getAndroid", getAndroidSchema, { avdName: "Pixel" }],
  ] as const)("%s accepts a caller-wide sessionUuid", (_name, schema, validParams) => {
    const params = stripUndeclaredSessionUuid({ ...validParams, sessionUuid }, schema);
    expect(schema.safeParse(params).success).toBe(true);
  });

  test.each([
    [
      "killDevice",
      killDeviceSchema,
      { device: { name: "Pixel", deviceId: "emulator-5554", platform: "android" } },
    ],
    ["listDevices", listDevicesSchema, {}],
    ["getAndroid", getAndroidSchema, { avdName: "Pixel" }],
  ] as const)("%s still rejects unrelated unknown keys", (_name, schema, validParams) => {
    const params = stripUndeclaredSessionUuid(
      { ...validParams, sessionUuid, bogusKey: true },
      schema,
    );
    const result = schema.safeParse(params);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((issue) => issue.message.includes("bogusKey"))).toBe(true);
    }
  });

  test("keeps sessionUuid for a schema that declares it", () => {
    const params = { platform: "android", sessionUuid };
    const stripped = stripUndeclaredSessionUuid(params, listDeviceImagesSchema);
    expect(stripped).toEqual(params);
    expect(listDeviceImagesSchema.parse(stripped)).toMatchObject({ sessionUuid });
  });

  test("keeps other fields and does not mutate the caller object", () => {
    const schema = z.object({ count: z.number() }).strict();
    const params = { count: 1, sessionUuid };
    const stripped = stripUndeclaredSessionUuid(params, schema);
    expect(stripped).toEqual({ count: 1 });
    expect(params).toEqual({ count: 1, sessionUuid });
  });
});
