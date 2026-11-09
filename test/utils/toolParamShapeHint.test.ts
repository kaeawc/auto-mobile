import { describe, expect, test } from "bun:test";
import { z } from "zod/v4";
import { formatToolParamError } from "../../src/utils/toolParamError";
import { allowedKeysAt, formatShapeHint, minimalExample } from "../../src/utils/toolParamShapeHint";
import { sendKeysSchema, tapOnSchema } from "../../src/server/interactionTools";

// #17666: a wrong argument shape names the allowed keys of the object the caller
// got wrong and a minimal valid call, both read off the tool's own schema.

function messageFor(toolName: string, schema: z.ZodType, input: Record<string, unknown>): string {
  const result = schema.safeParse(input);
  if (result.success) {
    throw new Error(`expected invalid ${toolName} input`);
  }
  return formatToolParamError(toolName, result.error, input, schema);
}

// A small stand-in tool schema, so the generic derivation is pinned without
// depending on any real tool's evolving parameter list.
const fakeToolSchema = z
  .object({
    target: z.union([
      z.object({ id: z.string() }).strict(),
      z.object({ label: z.string(), exact: z.boolean().optional() }).strict(),
    ]),
    steps: z
      .array(
        z.discriminatedUnion("kind", [
          z.object({ kind: z.literal("press"), times: z.number().int().min(1) }).strict(),
          z.object({ kind: z.literal("wait") }).strict(),
        ]),
      )
      .min(1),
    poll: z.object({ ms: z.number().optional() }).strict().optional(),
    mode: z.enum(["fast", "slow"]).optional(),
  })
  .strict();

describe("toolParamShapeHint derivation (#17666)", () => {
  test("lists top-level, nested-union and array-element keys from the schema", () => {
    expect(allowedKeysAt(fakeToolSchema, [])).toEqual(["target", "steps", "poll", "mode"]);
    expect(allowedKeysAt(fakeToolSchema, ["target"])).toEqual(["id", "label", "exact"]);
    expect(allowedKeysAt(fakeToolSchema, ["steps"])).toEqual(["kind", "times"]);
    expect(allowedKeysAt(fakeToolSchema, ["steps", 0])).toEqual(["kind", "times"]);
    expect(allowedKeysAt(fakeToolSchema, ["poll"])).toEqual(["ms"]);
    expect(allowedKeysAt(fakeToolSchema, ["mode"])).toEqual([]);
  });

  test("builds a minimal example the schema accepts", () => {
    const example = minimalExample(fakeToolSchema);
    expect(example).toEqual({ target: { id: "<id>" }, steps: [{ kind: "press", times: 1 }] });
    expect(fakeToolSchema.safeParse(example).success).toBe(true);
  });

  test("omits the example when no valid value can be derived", () => {
    const schema = z.object({ when: z.date() });
    expect(minimalExample(schema)).toBeUndefined();
  });

  test("is empty for value errors and without a schema", () => {
    const input = { target: { id: "a" }, steps: [{ kind: "wait" }], mode: "medium" };
    const result = fakeToolSchema.safeParse(input);
    if (result.success) {
      throw new Error("expected invalid input");
    }
    expect(formatShapeHint("fake", fakeToolSchema, result.error.issues, input)).toBe("");
    expect(formatShapeHint("fake", undefined, result.error.issues, input)).toBe("");
  });

  test("names the nested object's keys for an unknown nested key", () => {
    const message = messageFor("fake", fakeToolSchema, {
      target: { id: "a" },
      steps: [{ kind: "wait" }],
      poll: { duration: 5 },
    });
    expect(message).toContain("Allowed poll keys: ms.");
    expect(message).toContain(
      'Example: fake({"target":{"id":"<id>"},"steps":[{"kind":"press","times":1}]})',
    );
  });
});

describe("formatToolParamError shape hints for real tools (#17666)", () => {
  test("tapOn with a bare text names the top-level keys and the selector shape", () => {
    const message = messageFor("tapOn", tapOnSchema, { platform: "android", text: "OK" });
    expect(message).toMatch(/Allowed keys: selector, .*searchUntil/);
    expect(message).toContain("Allowed selector keys: elementId, testTag, text,");
    expect(message).toContain('Example: tapOn({"selector":{');
  });

  test("tapOn with a string selector names the selector keys", () => {
    const message = messageFor("tapOn", tapOnSchema, { platform: "android", selector: "OK" });
    expect(message).toContain("selector expected object, received string");
    expect(message).toContain("Allowed selector keys: elementId, testTag, text,");
    expect(message).not.toContain("Allowed keys:");
  });

  test("tapOn searchUntil as a number names the searchUntil object keys", () => {
    const message = messageFor("tapOn", tapOnSchema, {
      platform: "android",
      selector: { text: "OK" },
      searchUntil: 3000,
    });
    expect(message).toContain("searchUntil expected object, received number");
    expect(message).toContain("Allowed searchUntil keys: duration.");
    expect(message).toContain("Example: tapOn(");
  });

  test("the tapOn example is a call the schema accepts", () => {
    const example = minimalExample(tapOnSchema);
    expect(example).toBeDefined();
    expect(tapOnSchema.safeParse(example).success).toBe(true);
  });

  test("sendKeys with a top-level text names the keys and a commands example", () => {
    const message = messageFor("sendKeys", sendKeysSchema, { platform: "ios", text: "Hi" });
    expect(message).toMatch(/Allowed keys: .*commands/);
    expect(message).toContain(
      'Example: sendKeys({"commands":[{"action":"type","text":"<text>"}]})',
    );
  });

  test("sendKeys with a command missing its action names the command keys", () => {
    const message = messageFor("sendKeys", sendKeysSchema, {
      platform: "ios",
      commands: [{ type: "Hi" }],
    });
    expect(message).toMatch(/Allowed commands\[\] keys: action, text,/);
  });

  test("a valid-shape value error carries no shape hint", () => {
    const message = messageFor("tapOn", tapOnSchema, {
      platform: "android",
      selector: { text: "OK" },
      action: "swipe",
    });
    expect(message).not.toContain("Allowed");
    expect(message).not.toContain("Example:");
  });
});
