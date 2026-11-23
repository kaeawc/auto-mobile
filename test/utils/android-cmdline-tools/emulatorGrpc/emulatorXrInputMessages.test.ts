import { describe, expect, test } from "bun:test";
import { encodeXrPointerInputEvent } from "../../../../src/utils/android-cmdline-tools/emulatorGrpc/emulatorXrInputMessages";
import { decodeFields } from "../../../../src/utils/android-cmdline-tools/emulatorGrpc/protobufWire";

const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString("hex");

describe("encodeXrPointerInputEvent", () => {
  test("wraps a MouseEvent in InputEvent.xr_hand_event (field 7)", () => {
    // 0x3a = field 7, length-delimited; MouseEvent{x=100 (0x64), y=200 (0xc8 0x01), buttons=1}.
    expect(hex(encodeXrPointerInputEvent({ channel: "hand", x: 100, y: 200, buttons: 1 }))).toBe(
      "3a07086410c8011801",
    );
  });

  test("wraps a MouseEvent in InputEvent.xr_eye_event (field 8)", () => {
    // 0x42 = field 8, length-delimited; buttons 0 is the proto3 default and is omitted.
    expect(hex(encodeXrPointerInputEvent({ channel: "eye", x: 1279, y: 1, buttons: 0 }))).toBe(
      "420508ff091001",
    );
  });

  test("keeps the oneof case for an all-default event at the origin", () => {
    expect(hex(encodeXrPointerInputEvent({ channel: "hand", x: 0, y: 0, buttons: 0 }))).toBe(
      "3a00",
    );
  });

  test("never sets MouseEvent.display, which XR AVDs route to 0", () => {
    const [outer] = decodeFields(
      encodeXrPointerInputEvent({ channel: "hand", x: 2559, y: 2557, buttons: 1 }),
    );
    expect(outer.value.kind).toBe("bytes");
    const inner = outer.value.kind === "bytes" ? decodeFields(outer.value.value) : [];
    expect(inner.map(({ field, value }) => [field, value.value])).toEqual([
      [1, 2559],
      [2, 2557],
      [3, 1],
    ]);
  });
});
