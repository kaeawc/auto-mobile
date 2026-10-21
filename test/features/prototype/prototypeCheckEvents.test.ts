import { expect, test } from "bun:test";
import { decodePrototypeEvent } from "../../../src/features/observe/android/CtrlProxyPrototypes";
import { PrototypeEventBuffer } from "../../../src/features/prototype/PrototypeEventBuffer";
import { prototypeChecksFields } from "../../../src/features/prototype/prototypeChecksCapability";
import { event } from "../../helpers/prototypeTestEvent";

test("decode and buffer checked input change and validation_failed events", () => {
  const buffer = new PrototypeEventBuffer();
  for (const wire of [
    { ...event(1), kind: "change", validity: { email: false, consent: true } },
    { ...event(2), kind: "validation_failed", keys: ["email"] },
  ]) {
    const decoded = decodePrototypeEvent(wire, "test");
    expect<unknown>(decoded).toEqual(wire);
    if (!decoded) {
      throw new Error("Missing event");
    }
    expect(buffer.push(decoded)).toBe(true);
    expect<unknown>(buffer.take({})).toEqual(wire);
  }
});
test("new event kinds require their validity or failing keys", () => {
  expect(decodePrototypeEvent({ ...event(1), kind: "change" }, "test")).toBeUndefined();
  expect(decodePrototypeEvent({ ...event(1), kind: "validation_failed" }, "test")).toBeUndefined();
});

test("malformed validity and failing key lists are dropped", () => {
  for (const extra of [
    { validity: { email: "false" } },
    { keys: [] },
    { keys: [1] },
    { keys: Array(9).fill("email") },
  ]) {
    expect(
      decodePrototypeEvent({ ...event(1), kind: "validation_failed", ...extra }, "test"),
    ).toBeUndefined();
  }
});
test("capability detection ignores data, state and opaque emit payloads", () => {
  expect(
    prototypeChecksFields({
      data: { valid: "key" },
      root: { type: "button", onTap: [{ type: "emit", payload: { checks: [], valid: "key" } }] },
    }),
  ).toEqual([]);
  expect(
    prototypeChecksFields({
      root: {
        type: "button",
        enabledWhen: { not: { valid: "email" } },
        onTap: [{ type: "emit", requireValid: ["email"] }],
      },
    }),
  ).toEqual(["root.enabledWhen", "root.onTap[0].requireValid"]);
});
