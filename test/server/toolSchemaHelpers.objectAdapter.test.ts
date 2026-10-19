import { expect, test } from "bun:test";
import { z } from "zod/v4";
import { addDeviceTargetingToSchema, addSessionUuidToSchema } from "../../src/utils/schemaHelpers";
import { schemaProperty } from "../helpers/toolResponse";

test("device targeting preserves base definitions, field order, and passthrough values", () => {
  const base = z
    .object({ value: z.string(), platform: z.literal("ios"), deviceId: z.literal("owned") })
    .passthrough();
  const extended = addDeviceTargetingToSchema(base);
  expect(schemaProperty(extended.shape, "platform")).toBe(schemaProperty(base.shape, "platform"));
  expect(schemaProperty(extended.shape, "deviceId")).toBe(schemaProperty(base.shape, "deviceId"));
  expect(Object.keys(extended.shape)).toEqual([
    "value",
    "platform",
    "deviceId",
    "sessionUuid",
    "keepScreenAwake",
    "device",
  ]);
  expect(
    JSON.stringify(extended.parse({ value: "a", platform: "ios", deviceId: "owned", extra: 1 })),
  ).toBe('{"value":"a","platform":"ios","deviceId":"owned","extra":1}');
  expect(extended.safeParse({ value: "a", platform: "android", deviceId: "owned" }).success).toBe(
    false,
  );
});

test("session targeting preserves a stricter base field and strict unknown-key policy", () => {
  const base = z.object({ sessionUuid: z.literal("reserved"), value: z.number() }).strict();
  const extended = addSessionUuidToSchema(base);
  expect(schemaProperty(extended.shape, "sessionUuid")).toBe(
    schemaProperty(base.shape, "sessionUuid"),
  );
  expect<unknown>(extended.parse({ sessionUuid: "reserved", value: 1 })).toEqual({
    sessionUuid: "reserved",
    value: 1,
  });
  expect(extended.safeParse({ sessionUuid: "other", value: 1 }).success).toBe(false);
  expect(extended.safeParse({ sessionUuid: "reserved", value: 1, extra: true }).success).toBe(
    false,
  );
});
