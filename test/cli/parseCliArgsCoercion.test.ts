import { describe, expect, test } from "bun:test";
import { parseCliArgs } from "../../src/cli";

// The CLI ran every value through JSON.parse, so a numeric-looking string
// argument arrived as a number and string-typed params rejected it (#4241).
// Coercion must follow the tool's declared zod type, not the token's shape.

describe("parseCliArgs schema-aware coercion (#4241)", () => {
  test("keeps a numeric-looking value as a string for a string-typed param", () => {
    const { params } = parseCliArgs(["inputText", "--platform", "android", "--text", "12345"]);

    expect(params.text).toBe("12345");
    expect(typeof params.text).toBe("string");
  });

  test("keeps an all-digit phone number as a string", () => {
    const { params } = parseCliArgs([
      "sendSms",
      "--platform",
      "android",
      "--phoneNumber",
      "5551234567",
      "--message",
      "hi",
    ]);

    expect(params.phoneNumber).toBe("5551234567");
    expect(typeof params.phoneNumber).toBe("string");
  });

  test("still coerces a number-typed param to a number", () => {
    const { params } = parseCliArgs([
      "videoRecording",
      "--platform",
      "android",
      "--action",
      "start",
      "--maxDuration",
      "240",
    ]);

    expect(params.maxDuration).toBe(240);
    expect(typeof params.maxDuration).toBe("number");
  });

  test("still coerces a boolean-typed param to a boolean", () => {
    const { params } = parseCliArgs(["observe", "--platform", "android", "--raw", "true"]);

    expect(params.raw).toBe(true);
    expect(typeof params.raw).toBe("boolean");
  });

  test("still parses an object-typed param as JSON", () => {
    const { params } = parseCliArgs([
      "tapOn",
      "--platform",
      "android",
      "--selector",
      '{"text":"Settings"}',
    ]);

    expect(params.selector).toEqual({ text: "Settings" });
  });

  test("a nested string value inside an object param stays a string", () => {
    const { params } = parseCliArgs([
      "tapOn",
      "--platform",
      "android",
      "--selector",
      '{"text":"12345"}',
    ]);

    expect(params.selector).toEqual({ text: "12345" });
  });

  test("falls back to best-effort parsing for an unknown tool", () => {
    const { params } = parseCliArgs(["noSuchTool", "--count", "5"]);

    expect(params.count).toBe(5);
  });

  test("falls back to best-effort parsing for an undeclared param", () => {
    const { params } = parseCliArgs(["observe", "--platform", "android", "--notARealParam", "5"]);

    expect(params.notARealParam).toBe(5);
  });

  test("bare flags with no value remain true", () => {
    const { params } = parseCliArgs(["observe", "--platform", "android", "--raw"]);

    expect(params.raw).toBe(true);
  });
});

describe("parseCliArgs coercion for union-rooted schemas (#4241 review)", () => {
  // clipboard / deviceSnapshot are z.union at the root, and postNotification is a
  // pipe into a union, so a shape lookup that only understands a flat object
  // returns nothing and these tools kept the old JSON coercion.

  test("clipboard --text keeps a numeric-looking value as a string", () => {
    const { params } = parseCliArgs([
      "clipboard",
      "--platform",
      "android",
      "--action",
      "copy",
      "--text",
      "12345",
    ]);

    expect(params.text).toBe("12345");
    expect(typeof params.text).toBe("string");
  });

  test("deviceSnapshot --snapshotName keeps a numeric-looking value as a string", () => {
    const { params } = parseCliArgs([
      "deviceSnapshot",
      "--platform",
      "android",
      "--action",
      "capture",
      "--snapshotName",
      "20260722",
    ]);

    expect(params.snapshotName).toBe("20260722");
    expect(typeof params.snapshotName).toBe("string");
  });

  test("postNotification --title keeps a numeric-looking value as a string", () => {
    const { params } = parseCliArgs([
      "postNotification",
      "--platform",
      "android",
      "--title",
      "911",
      "--body",
      "test",
    ]);

    expect(params.title).toBe("911");
    expect(typeof params.title).toBe("string");
  });
});

describe("parseCliArgs coercion sees through schema wrappers (#4241 review)", () => {
  // getCliHelpParameterInfo unwraps `optional` only, so a param wrapped in
  // nullable/default reported the wrapper and fell back to JSON coercion.

  test("a default-wrapped enum still coerces as a string", () => {
    const { params } = parseCliArgs([
      "tapOn",
      "--platform",
      "android",
      "--selector",
      '{"text":"x"}',
      "--action",
      "tap",
    ]);

    expect(params.action).toBe("tap");
    expect(typeof params.action).toBe("string");
  });

  test("a default-wrapped number still coerces as a number", () => {
    const { params } = parseCliArgs([
      "executePlan",
      "--platform",
      "android",
      "--planContent",
      "x",
      "--startStep",
      "3",
    ]);

    expect(params.startStep).toBe(3);
    expect(typeof params.startStep).toBe("number");
  });

  test("a nullable string keeps a numeric-looking value as a string", async () => {
    // setKeyValue is embeddedSdkOnly, so it is only visible to the registry --
    // and only callable at all -- in embedded-SDK mode.
    const { serverConfig } = await import("../../src/utils/ServerConfig");
    const previous = serverConfig.isEmbeddedSdkEnabled();
    serverConfig.setEmbeddedSdkEnabled(true);
    try {
      const { params } = parseCliArgs([
        "setKeyValue",
        "--platform",
        "android",
        "--appId",
        "com.example",
        "--name",
        "prefs",
        "--key",
        "pin",
        "--type",
        "STRING",
        "--value",
        "12345",
      ]);

      expect(params.value).toBe("12345");
      expect(typeof params.value).toBe("string");
    } finally {
      serverConfig.setEmbeddedSdkEnabled(previous);
    }
  });
});

describe("parseCliArgs preserves JSON-encoded scalars and rejects bad numbers (#4241 review)", () => {
  test("a JSON-encoded string for a string param unwraps to the inner string", () => {
    const { params } = parseCliArgs(["inputText", "--platform", "android", "--text", '"12345"']);

    expect(params.text).toBe("12345");
  });

  test("a JSON-encoded string containing spaces unwraps", () => {
    const { params } = parseCliArgs(["inputText", "--platform", "android", "--text", '"a b"']);

    expect(params.text).toBe("a b");
  });

  test("a bare token for a string param is unchanged", () => {
    const { params } = parseCliArgs(["inputText", "--platform", "android", "--text", "plain"]);

    expect(params.text).toBe("plain");
  });

  test.each([
    ["", "empty"],
    [" ", "whitespace"],
    ["0x10", "hex"],
    ["[]", "array"],
  ])("a non-JSON number token (%p, %s) is left for schema validation to reject", (raw) => {
    const { params } = parseCliArgs(["startDevice", "--platform", "ios", "--timeout-ms", raw]);

    expect(typeof params.timeoutMs).toBe("string");
    expect(params.timeoutMs).toBe(raw);
  });

  test.each([
    ["12", 12],
    ["1e3", 1000],
    ["-5", -5],
  ])("a valid JSON number token (%p) still coerces to %p", (raw, expected) => {
    const { params } = parseCliArgs(["startDevice", "--platform", "ios", "--timeout-ms", raw]);

    expect(params.timeoutMs).toBe(expected);
  });
});

describe("parseCliArgs preserves JSON null for nullable params (#4241 review)", () => {
  async function withEmbeddedSdk<T>(run: () => T): Promise<T> {
    const { serverConfig } = await import("../../src/utils/ServerConfig");
    const previous = serverConfig.isEmbeddedSdkEnabled();
    serverConfig.setEmbeddedSdkEnabled(true);
    try {
      return run();
    } finally {
      serverConfig.setEmbeddedSdkEnabled(previous);
    }
  }

  const setKeyValue = (value: string) => [
    "setKeyValue",
    "--platform",
    "android",
    "--appId",
    "com.example",
    "--name",
    "prefs",
    "--key",
    "k",
    "--type",
    "STRING",
    "--value",
    value,
  ];

  test("an explicit null reaches a nullable param as null", async () => {
    // storageTools removes the key only when value === null; the literal string
    // "null" would overwrite it instead.
    const params = await withEmbeddedSdk(() => parseCliArgs(setKeyValue("null")).params);

    expect(params.value).toBeNull();
  });

  test("a nullable param still keeps other numeric-looking strings as strings", async () => {
    const params = await withEmbeddedSdk(() => parseCliArgs(setKeyValue("12345")).params);

    expect(params.value).toBe("12345");
  });

  test("a value merely containing 'null' is untouched", async () => {
    const params = await withEmbeddedSdk(() => parseCliArgs(setKeyValue("null-ish")).params);

    expect(params.value).toBe("null-ish");
  });

  test("a non-nullable string param keeps the literal token 'null'", () => {
    const { params } = parseCliArgs(["inputText", "--platform", "android", "--text", "null"]);

    expect(params.text).toBe("null");
  });
});
