import { describe, expect, test } from "bun:test";
import {
  matchesDeviceReadOnlyArgShape,
  anyDeviceReadOnlyArgShapeMatches,
} from "../../src/server/deviceReadOnlyArgShapes";

describe("device read-only argument shapes", () => {
  test("matches only listed string values", () => {
    const shape = { argument: "action", values: ["get", "inspect"] };
    expect(matchesDeviceReadOnlyArgShape(shape, { action: "get" })).toBe(true);
    expect(matchesDeviceReadOnlyArgShape(shape, { action: "inspect", deviceId: "device" })).toBe(
      true,
    );
    for (const action of [undefined, null, 1, true, ["get"], "GET", "set"]) {
      expect(matchesDeviceReadOnlyArgShape(shape, { action })).toBe(false);
    }
  });

  test("absence means undefined, and null and false are present", () => {
    const shape = { absentArguments: ["talkback", "voiceover"] };
    expect(matchesDeviceReadOnlyArgShape(shape, {})).toBe(true);
    expect(matchesDeviceReadOnlyArgShape(shape, { talkback: undefined, deviceId: "device" })).toBe(
      true,
    );
    for (const value of [null, false, true, 0, ""]) {
      expect(matchesDeviceReadOnlyArgShape(shape, { talkback: value })).toBe(false);
      expect(matchesDeviceReadOnlyArgShape(shape, { voiceover: value })).toBe(false);
    }
  });

  test("garbage metadata and malformed entries never match or throw", () => {
    const invalid = [
      undefined,
      null,
      true,
      3,
      "get",
      {},
      [],
      [null],
      [true],
      ["get"],
      [[]],
      [{}],
      [{ argument: "action" }],
      [{ argument: 1, values: ["get"] }],
      [{ argument: "action", values: "get" }],
      [{ argument: "", values: ["get"] }],
      [{ argument: "action", values: [] }],
      [{ argument: "action", values: ["get", null] }],
      [{ absentArguments: "action" }],
      [{ absentArguments: [null] }],
      [{ argument: "action", values: ["get"], absentArguments: [] }],
      [{ absentArguments: [], values: ["get"] }],
    ];
    for (const shapes of invalid) {
      expect(anyDeviceReadOnlyArgShapeMatches(shapes, { action: "get" })).toBe(false);
    }
  });

  test("any valid matching shape wins, even among malformed or nonmatching entries", () => {
    const shapes = [
      null,
      {},
      { argument: "action", values: ["get"] },
      { absentArguments: ["action"] },
    ];
    expect(anyDeviceReadOnlyArgShapeMatches(shapes, { action: "get" })).toBe(true);
    expect(anyDeviceReadOnlyArgShapeMatches(shapes, {})).toBe(true);
    expect(anyDeviceReadOnlyArgShapeMatches(shapes, { action: "set" })).toBe(false);
    expect(
      anyDeviceReadOnlyArgShapeMatches([{ argument: "", values: ["get"] }], { action: "get" }),
    ).toBe(false);
    expect(
      anyDeviceReadOnlyArgShapeMatches([{ argument: "action", values: [] }], { action: "get" }),
    ).toBe(false);
    expect(anyDeviceReadOnlyArgShapeMatches([{ absentArguments: [] }], {})).toBe(false);
    expect(
      anyDeviceReadOnlyArgShapeMatches(
        [{ absentArguments: [] }, { argument: "action", values: ["get"] }],
        { action: "get" },
      ),
    ).toBe(true);
  });
});
