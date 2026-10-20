import { describe, expect, test } from "bun:test";
import {
  readToolResponse,
  toolField,
  toolIsError,
  toolJson,
  toolPayload,
  toolStructured,
  toolText,
} from "./toolResponse";

describe("toolResponse helpers", () => {
  const ok = { content: [{ type: "text", text: '{"a":1}' }], structuredContent: { b: 2 } };

  test("reads text, json, structured content and error flag", () => {
    expect(toolText(ok)).toBe('{"a":1}');
    expect(toolJson(ok)).toEqual({ a: 1 });
    expect(toolStructured(ok)).toEqual({ b: 2 });
    expect(toolIsError(ok)).toBe(false);
    expect(toolIsError({ ...ok, isError: true })).toBe(true);
  });

  test("reads the envelope payload and tolerates non-envelope values", () => {
    expect(toolPayload(ok)).toEqual({ b: 2 });
    expect(toolPayload("nope")).toBeUndefined();
  });

  test("throws clear errors on shape mismatch", () => {
    expect(() => readToolResponse("nope")).toThrow("invalid response");
    expect(() => readToolResponse({ content: "x" })).toThrow("invalid response");
    expect(() => toolText({ content: [] })).toThrow("no text in content[0]");
    expect(() => toolText({ content: [{ type: "image" }] })).toThrow("no text");
    expect(() => toolText({ content: [{ type: "image", text: "looks like text" }] })).toThrow(
      "no text",
    );
    expect(() => toolJson({ content: [{ type: "text", text: "[1]" }] })).toThrow(
      "not a JSON object",
    );
    expect(() => toolStructured({ content: [] })).toThrow("no structuredContent");
  });

  test("toolField reads own structuredContent keys and tolerates missing payloads", () => {
    const response = { content: [], structuredContent: { success: true } };
    expect(toolField(response, "success")).toBe(true);
    expect(toolField(response, "missing")).toBeUndefined();
    expect(toolField(response, "toString")).toBeUndefined();
    expect(toolField({ content: [] }, "success")).toBeUndefined();
    expect(toolField(undefined, "success")).toBeUndefined();
  });
});
