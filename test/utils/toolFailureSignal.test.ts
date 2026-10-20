import { describe, expect, test } from "bun:test";
import {
  carryToolFailureMark,
  isMarkedToolFailure,
  markToolFailure,
} from "../../src/utils/toolFailureSignal";
import {
  createJSONToolResponse,
  createStructuredToolResponse,
  DefaultToolResponseFormatter,
} from "../../src/utils/toolUtils";

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

  test.each([true, false])("carries only an existing mark to rebuilt content: %s", (marked) => {
    const source = { content: [{ type: "text", text: "x" }] };
    if (marked) {
      markToolFailure(source);
    }
    // Also exercise a shallow copy whose only signal lives on the shared array.
    const from = { ...source };
    const to = Object.freeze({ ...from, content: Object.freeze([...from.content]) });
    const wire = JSON.stringify(to);
    expect(isMarkedToolFailure(to)).toBe(false);
    expect(carryToolFailureMark(from, to)).toBe(to);
    expect(isMarkedToolFailure(to)).toBe(marked);
    expect(isMarkedToolFailure(to.content)).toBe(marked);
    expect(isMarkedToolFailure({ ...to })).toBe(marked);
    expect(JSON.stringify(to)).toBe(wire);
    expect(Reflect.ownKeys(to)).toEqual(["content"]);
    expect(Reflect.ownKeys(to.content)).toEqual(["0", "length"]);
  });

  test("carries an object-only mark and ignores non-object sources", () => {
    const target = {};
    expect(carryToolFailureMark(markToolFailure({}), target)).toBe(target);
    expect(isMarkedToolFailure(target)).toBe(true);
    expect(Reflect.ownKeys(target)).toEqual([]);
    for (const from of [undefined, null, false, 0, "x"]) {
      const unmarked = {};
      expect(carryToolFailureMark(from, unmarked)).toBe(unmarked);
      expect(isMarkedToolFailure(unmarked)).toBe(false);
    }
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
      const expected = { content: [{ type: "text" as const, text: JSON.stringify(payload) }] };
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

describe("formatter wire identity", () => {
  const symbol = Symbol("internal");
  test.each([
    {
      name: "object with nested accessibility extras",
      payload: { value: "x", extras: { hidden: true }, nested: { extras: "hidden", visible: 1 } },
      hoisted: {},
    },
    {
      name: "failed payload",
      payload: { success: false, error: "x", extras: "hidden" },
      hoisted: { success: false, error: "x" },
    },
    { name: "successful payload", payload: { success: true }, hoisted: { success: true } },
    { name: "null", payload: null, hoisted: {} },
    { name: "string", payload: "plain", hoisted: {} },
    {
      name: "enumerable symbol key",
      payload: { success: false, value: "x", [symbol]: "internal" },
      hoisted: { success: false },
    },
  ])("preserves serialized envelopes and key order: $name", ({ payload, hoisted }) => {
    // The pre-convergence text serialization, independent of the shared builder.
    const text = JSON.stringify(payload, (key, value) => (key === "extras" ? undefined : value));
    const content = [{ type: "text" as const, text }];
    const expectedStructured = {
      content,
      structuredContent:
        payload && typeof payload === "object" && Object.getOwnPropertySymbols(payload).length > 0
          ? Object.fromEntries(Object.entries(payload))
          : payload,
      ...hoisted,
    };
    const json = createJSONToolResponse(payload);
    const structured = createStructuredToolResponse(payload);
    expect(json.content).toEqual(content);
    expect(structured.content).toEqual(content);
    expect(JSON.stringify(json)).toBe(JSON.stringify({ content }));
    expect(JSON.stringify(structured)).toBe(JSON.stringify(expectedStructured));
    expect(Reflect.ownKeys(json)).toEqual(["content"]);
    expect(Object.keys(structured)).toEqual([
      "content",
      "structuredContent",
      ...Object.keys(hoisted),
    ]);
    expect(Object.getOwnPropertySymbols(structured)).toEqual([]);
    expect(Object.getOwnPropertySymbols(structured.structuredContent ?? {})).toEqual([]);
    expect(isMarkedToolFailure(json)).toBe(hoisted.success === false);
    expect(isMarkedToolFailure(structured)).toBe(false);
    if (payload && typeof payload === "object" && symbol in payload) {
      expect(payload[symbol]).toBe("internal");
      expect(structured.structuredContent).not.toBe(payload);
    } else {
      expect(structured.structuredContent).toBe(payload);
    }
  });
});
