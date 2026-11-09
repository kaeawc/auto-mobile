import { describe, expect, test } from "bun:test";
import { z } from "zod/v4";
import { formatToolParamError } from "../../src/utils/toolParamError";
import { allowedKeysAt, formatShapeHint, minimalExample } from "../../src/utils/toolParamShapeHint";
import { sendKeysSchema, tapOnSchema } from "../../src/server/interactionTools";

// #17666: a wrong argument shape names the allowed keys of the object the caller
// got wrong and a minimal valid call, both read off the tool's own schema.

// The hint text after " Hint: ", which #17675 keeps under about 250 characters.
const MAX_HINT_CHARS = 250;

function hintOf(message: string): string {
  const marker = " Hint: ";
  const index = message.indexOf(marker);
  return index < 0 ? "" : message.slice(index + marker.length);
}

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
      'Example: fake({"target":{"id":"<id>"},"steps":[{"kind":"press","times":1}],"poll":{"ms":0}})',
    );
  });
});

describe("formatToolParamError shape hints for real tools (#17666)", () => {
  test("tapOn with a bare text says where text belongs instead of every key", () => {
    const message = messageFor("tapOn", tapOnSchema, { platform: "android", text: "OK" });
    expect(message).toContain('"text" belongs under selector,');
    expect(message).not.toContain("Allowed keys:");
    expect(message).toContain("Allowed selector keys: elementId, testTag, text,");
    expect(message).toContain('Example: tapOn({"selector":{');
    expect(hintOf(message).length).toBeLessThanOrEqual(MAX_HINT_CHARS);
  });

  test("tapOn with a string selector names the selector keys", () => {
    const message = messageFor("tapOn", tapOnSchema, { platform: "android", selector: "OK" });
    expect(message).toContain("selector expected object, received string");
    expect(message).toContain("Allowed selector keys: elementId, testTag, text,");
    expect(message).not.toContain("Allowed keys:");
    expect(hintOf(message).length).toBeLessThanOrEqual(MAX_HINT_CHARS);
  });

  test("tapOn searchUntil as a number shows a searchUntil object in the example", () => {
    const input = { platform: "android", selector: { text: "OK" }, searchUntil: 3000 };
    const message = messageFor("tapOn", tapOnSchema, input);
    expect(message).toContain("searchUntil expected object, received number");
    expect(message).toContain("Allowed searchUntil keys: duration.");
    expect(message).toContain('"searchUntil":{"duration":100}');
    const example = JSON.parse(hintOf(message).replace(/^.*Example: tapOn\((.*)\)$/, "$1"));
    expect(tapOnSchema.safeParse(example).success).toBe(true);
    expect(hintOf(message).length).toBeLessThanOrEqual(MAX_HINT_CHARS);
  });

  test("the tapOn example is a call the schema accepts", () => {
    const example = minimalExample(tapOnSchema);
    expect(example).toBeDefined();
    expect(tapOnSchema.safeParse(example).success).toBe(true);
  });

  test.each([
    { name: "a top-level text", input: { platform: "ios", text: "Hi" } },
    {
      name: "a command missing its action",
      input: { platform: "ios", commands: [{ type: "Hi" }] },
    },
  ])("sendKeys with $name gives one merged commands hint", ({ input }) => {
    const message = messageFor("sendKeys", sendKeysSchema, input);
    const hint = hintOf(message);
    expect(
      hint.startsWith('sendKeys takes commands: [{ "action": "type", "text": "<text>" }]'),
    ).toBe(true);
    expect(hint.split("sendKeys").length - 1).toBe(1);
    expect(hint).not.toContain("Allowed");
    expect(hint).not.toContain("Example:");
    expect(hint.length).toBeLessThanOrEqual(MAX_HINT_CHARS);
  });

  // #17680: the commands hint must not drop the allowed keys for an unrelated
  // unknown top-level key reported beside a commands error.
  test.each([
    {
      name: "a command missing its action",
      input: { platform: "ios", commands: [{ type: "Hi" }], bogus: 1 },
    },
    { name: "a top-level text", input: { platform: "ios", text: "Hi", bogus: 1 } },
  ])("sendKeys with $name and an unrelated unknown key keeps both hints", ({ input }) => {
    const hint = hintOf(messageFor("sendKeys", sendKeysSchema, input));
    expect(
      hint.startsWith('sendKeys takes commands: [{ "action": "type", "text": "<text>" }]'),
    ).toBe(true);
    expect(hint).toMatch(/\. Allowed keys: commands, .*… \(\d+ more\)\.$/);
    expect(hint.split("sendKeys").length - 1).toBe(1);
    expect(hint).not.toContain("Example:");
    expect(hint.length).toBeLessThanOrEqual(MAX_HINT_CHARS);
  });

  test("an unrelated unknown top-level key lists required keys first, capped", () => {
    const message = messageFor("sendKeys", sendKeysSchema, {
      platform: "ios",
      commands: [{ action: "type", text: "a" }],
      bogus: 1,
    });
    expect(message).toMatch(/Allowed keys: commands, .*… \(\d+ more\)\./);
    expect(message).toContain(
      'Example: sendKeys({"commands":[{"action":"type","text":"<text>"}]})',
    );
    expect(hintOf(message).length).toBeLessThanOrEqual(MAX_HINT_CHARS);
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
