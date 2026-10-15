import { describe, expect, test } from "bun:test";
import { isMarkedToolFailure, markToolFailure } from "../../src/utils/toolFailureSignal";
import { createJSONToolResponse, DefaultToolResponseFormatter } from "../../src/utils/toolUtils";

describe("tool failure signal", () => {
  test("marks the same object and its content array without adding any properties", () => {
    const response = Object.freeze({ content: Object.freeze([{ type: "text", text: "x" }]) });
    const before = JSON.stringify(response);
    expect(markToolFailure(response)).toBe(response);
    expect(isMarkedToolFailure(response)).toBe(true);
    expect(isMarkedToolFailure(response.content)).toBe(true);
    expect(JSON.stringify(response)).toBe(before);
    expect(Reflect.ownKeys(response)).toEqual(["content"]);
    expect(Reflect.ownKeys(response.content)).toEqual(["0", "length"]);
  });

  test("spread copies retain the content-array signal, not the object signal", () => {
    const response = markToolFailure({ content: [{ type: "text", text: "x" }] });
    const copy = { ...response };
    expect(copy).not.toBe(response);
    expect(copy.content).toBe(response.content);
    expect(isMarkedToolFailure(copy)).toBe(true);
    // Replacing shared content proves spread did not copy the object marker.
    expect(isMarkedToolFailure({ ...copy, content: [...copy.content] })).toBe(false);
    expect(isMarkedToolFailure({ ...markToolFailure({ value: 1 }) })).toBe(false);
  });

  test.each([undefined, null, false, 0, "x", {}, [], { content: {} }].map((value) => ({ value })))(
    "does not mark unrelated values: %j",
    ({ value }) => {
      expect(isMarkedToolFailure(value)).toBe(false);
    },
  );

  test("also marks responses without an array content field", () => {
    const response = { content: "plain" };
    expect(markToolFailure(response)).toBe(response);
    expect(isMarkedToolFailure(response)).toBe(true);
  });
});

describe("JSON formatter failure signal", () => {
  test.each([
    { payload: { success: false, error: "x" }, marked: true },
    { payload: { success: true }, marked: false },
    { payload: { value: "x" }, marked: false },
    { payload: { success: 0 }, marked: false },
    { payload: null, marked: false },
    { payload: "plain", marked: false },
  ])("preserves wire bytes and keys for $payload", ({ payload, marked }) => {
    for (const formatter of [
      createJSONToolResponse,
      new DefaultToolResponseFormatter().createJSONToolResponse,
    ]) {
      const response = formatter(payload);
      const expected = { content: [{ type: "text", text: JSON.stringify(payload) }] };
      expect(isMarkedToolFailure(response)).toBe(marked);
      expect(response).toEqual(expected);
      expect(JSON.stringify(response)).toBe(JSON.stringify(expected));
      expect(Object.keys(response)).toEqual(["content"]);
      expect(Object.getOwnPropertyNames(response)).toEqual(["content"]);
      expect(Object.getOwnPropertySymbols(response)).toEqual([]);
      expect(Object.getOwnPropertySymbols(response.content)).toEqual([]);
    }
  });
});
