import { expect, test } from "bun:test";
import { validatePrototypeSpec } from "../../../src/features/prototype/prototypeValidation";
import { prototypeGateCapabilities } from "../../../src/features/prototype/prototypeCapabilityGates";
import { MAX_PROTOTYPE_CLIPBOARD_TEXT_BYTES } from "../../../src/features/prototype/prototypePlatform";
import { prototypePlatformCallEventOf } from "../../../src/features/prototype/prototypePlatformEvent";
const base = {
  id: "clipboard",
  window: { placement: { type: "fullscreen" } },
  requires: { platform: ["clipboard"] },
};
const copy = (text: unknown) => ({
  ...base,
  root: {
    type: "button",
    label: "Copy",
    onTap: [{ type: "platform", call: "clipboard.copy", args: { text: { value: text } } }],
  },
});
test("clipboard copy literal limit measures UTF-8 bytes", () => {
  expect(MAX_PROTOTYPE_CLIPBOARD_TEXT_BYTES).toBe(65536);
  expect(validatePrototypeSpec(copy("é".repeat(32768))).success).toBe(true);
  expect(validatePrototypeSpec(copy("é".repeat(32769))).success).toBe(false);
  expect(validatePrototypeSpec(copy(1)).success).toBe(false);
  expect(validatePrototypeSpec(copy("")).success).toBe(true);
});
test("pasteButton requires declaration, a data destination and both platform gates", () => {
  const spec = { ...base, root: { type: "pasteButton", into: "/data/code" } };
  expect(validatePrototypeSpec(spec).success).toBe(true);
  expect(prototypeGateCapabilities(spec)).toEqual([
    "prototype_platform_clipboard_v1",
    "prototype_platform_v1",
  ]);
  expect(validatePrototypeSpec({ ...spec, requires: undefined }).success).toBe(false);
  expect(
    validatePrototypeSpec({ ...spec, root: { ...spec.root, into: "/platform/clipboard" } }).success,
  ).toBe(false);
});
test("clipboard completion accepts metadata and refuses clipboard text", () => {
  const event = {
    kind: "emit" as const,
    name: "prototype_platform",
    payload: {
      callId: "copy",
      call: "clipboard.copy",
      durationMs: 0,
      outcome: "success",
      op: "copy",
      bytes: 6,
    },
  };
  expect(prototypePlatformCallEventOf(event)?.bytes).toBe(6);
  expect(
    prototypePlatformCallEventOf({ ...event, payload: { ...event.payload, text: "secret" } }),
  ).toBeUndefined();
});
