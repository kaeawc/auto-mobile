import { describe, expect, test } from "bun:test";
import { validatePrototypeSpec } from "../../../src/features/prototype/prototypeValidation";
import {
  prototypeSensitiveSinkErrors,
  prototypeStrictPolicyError,
} from "../../../src/features/prototype/prototypeStrictPolicy";

/** A spec whose pasteButton writes `into` (a sensitive clipboard call), then one request. */
function specWith(sink: Record<string, unknown>, into = "/data/code") {
  return {
    id: "sensitive-flow",
    window: { placement: { type: "fullscreen" } },
    requires: { platform: ["clipboard"] },
    root: {
      type: "column",
      children: [
        { type: "pasteButton", into },
        {
          type: "button",
          label: "Send",
          onTap: [{ type: "request", url: "https://example.com/submit", via: "device", ...sink }],
        },
      ],
    },
  };
}

function repeatedSpecWith(
  keys: string[],
  sink: Record<string, unknown> = { query: { code: "{data:/{row.key}}" } },
) {
  const spec = specWith(sink);
  return {
    ...spec,
    root: {
      ...spec.root,
      children: [
        spec.root.children[0],
        {
          type: "column",
          repeat: { items: keys.map((key) => ({ key })), as: "row" },
          children: [spec.root.children[1]],
        },
      ],
    },
  };
}

describe("sensitive data flow into network sinks (R2)", () => {
  test("a library refuses a sensitive typed data binding in a request query", () => {
    const spec = specWith({ query: { q: { data: "/code" } } });
    expect(validatePrototypeSpec(spec).success).toBe(true);
    expect(validatePrototypeSpec(spec, { library: true })).toEqual({
      success: false,
      error: {
        path: "root.children[1].onTap[0].query.q",
        message: "Sensitive value cannot be bound into a request",
      },
    });
  });

  test.each([
    { sink: { headers: { Authorization: { data: "/code" } } }, path: "headers.Authorization" },
    { sink: { method: "POST", body: { data: "/code" } }, path: "body" },
    { sink: { method: "POST", body: { form: { q: { data: "/code" } } } }, path: "body.form.q" },
    {
      sink: { method: "POST", body: { multipart: [{ name: "q", value: { data: "/code" } }] } },
      path: "body.multipart[0].value",
    },
  ])("a library refuses a sensitive typed binding at $path", ({ sink, path }) => {
    const spec = specWith(sink);
    const error = {
      path: `root.children[1].onTap[0].${path}`,
      message: "Sensitive value cannot be bound into a request",
    };
    expect(validatePrototypeSpec(spec).success).toBe(true);
    expect(prototypeSensitiveSinkErrors(spec)).toEqual([error]);
    expect(validatePrototypeSpec(spec, { library: true })).toEqual({ success: false, error });
  });

  test("a library accepts non-overlapping typed request bindings", () => {
    const spec = specWith({
      method: "POST",
      headers: { Authorization: { data: "/other" } },
      query: { q: { data: "/other" } },
      body: { data: "/other" },
    });
    expect(prototypeSensitiveSinkErrors(spec)).toEqual([]);
  });

  test.each([
    { pointer: "/user", into: "/data/user/name", refused: true },
    { pointer: "/user/name/first", into: "/data/user/name", refused: true },
    { pointer: "/user/email", into: "/data/user/name", refused: false },
    { pointer: "/codeword", into: "/data/code", refused: false },
  ])(
    "typed pointer $pointer uses segment-wise overlap with $into",
    ({ pointer, into, refused }) => {
      const spec = specWith({ query: { q: { data: pointer } } }, into);
      expect(validatePrototypeSpec(spec).success).toBe(true);
      expect(prototypeSensitiveSinkErrors(spec)).toEqual(
        refused
          ? [
              {
                path: "root.children[1].onTap[0].query.q",
                message: "Sensitive value cannot be bound into a request",
              },
            ]
          : [],
      );
      expect(prototypeSensitiveSinkErrors(spec).length > 0).toBe(refused);
    },
  );

  test("a library refuses a sensitive typed channel header", () => {
    const spec = {
      ...specWith({}),
      requires: { platform: ["clipboard", "realtime"] },
      channels: {
        updates: {
          kind: "sse",
          via: "device",
          url: "https://example.com/events",
          headers: { Authorization: { data: "/code" } },
        },
      },
    };
    const error = {
      path: "channels.updates.headers.Authorization",
      message: "Sensitive value cannot be bound into a request",
    };
    expect(validatePrototypeSpec(spec).success).toBe(true);
    expect(prototypeSensitiveSinkErrors(spec)).toEqual([error]);
    expect(validatePrototypeSpec(spec, { library: true })).toEqual({ success: false, error });
  });

  test("sensitive typed data bindings outside request sinks remain accepted", () => {
    const spec = specWith({});
    const outside = {
      ...spec,
      root: {
        ...spec.root,
        onAppear: [{ type: "emit", name: "pasted", context: { code: { data: "/code" } } }],
      },
    };
    expect(prototypeSensitiveSinkErrors(outside)).toEqual([]);
  });

  test("a library spec refuses a sensitive /data pointer bound into a request query", () => {
    const spec = specWith({ query: { code: "{data:/code}" } });
    expect(validatePrototypeSpec(spec).success).toBe(true);
    expect(validatePrototypeSpec(spec, { library: true })).toEqual({
      success: false,
      error: {
        path: "root.children[1].onTap[0].query.code",
        message: "Sensitive value cannot be bound into a request",
      },
    });
  });

  test("a sensitive pointer bound into a request URL, header or query is reported", () => {
    for (const sink of [
      { url: "https://example.com/{data:/code}" },
      { headers: { "X-Code": "{data:/code}" } },
      { query: { q: "{data:/code}" } },
    ]) {
      expect(prototypeSensitiveSinkErrors(specWith(sink))).toHaveLength(1);
    }
  });

  test("a library refuses a request query whose repeat-expanded pointer reaches sensitive data", () => {
    const spec = repeatedSpecWith(["code"]);
    const error = {
      path: "root.children[1].children[0].onTap[0].query.code",
      message: "Sensitive value cannot be bound into a request",
    };
    expect(validatePrototypeSpec(spec).success).toBe(true);
    expect(prototypeStrictPolicyError(spec, { library: true }, [])).toEqual(error);
    expect(validatePrototypeSpec(spec, { library: true })).toEqual({ success: false, error });
  });

  test("a library accepts a repeat-expanded query pointer that does not overlap sensitive data", () => {
    const spec = repeatedSpecWith(["other"]);
    expect(prototypeSensitiveSinkErrors(spec)).toEqual([]);
  });

  test.each([
    { pointer: "/code", refused: true },
    { pointer: "/other", refused: false },
  ])("derived repeat text retains the authored data pointer $pointer", ({ pointer, refused }) => {
    const spec = specWith({ query: { q: `{data:${pointer}}{row.suffix}` } });
    const repeated = {
      ...spec,
      root: {
        ...spec.root,
        repeat: {
          items: [{ n: 2 }],
          as: "row",
          derive: { suffix: { of: { item: "n" }, format: { number: {} } } },
        },
      },
    };
    const error = {
      path: "root.children[1].onTap[0].query.q",
      message: "Sensitive value cannot be bound into a request",
    };
    expect(validatePrototypeSpec(repeated).success).toBe(true);
    expect(prototypeSensitiveSinkErrors(repeated)).toEqual(refused ? [error] : []);
    expect(prototypeSensitiveSinkErrors(repeated).length > 0).toBe(refused);
  });

  test.each([
    { binding: "{row.code}", into: "/data/rows/0/code", refused: true },
    { binding: { item: "code" }, into: "/data/rows/0/code", refused: true },
    { binding: "{row.code}", into: "/data/rows", refused: true },
    { binding: { item: "code" }, into: "/data/rows/{index}/code", refused: true },
    { binding: "{row.code}", into: "/data/rowsOther/0/code", refused: false },
    { binding: { item: "code" }, into: "/data/other/0/code", refused: false },
    { binding: "static", into: "/data/rows/0/code", refused: false },
    { binding: { value: "{row.code}" }, into: "/data/rows/0/code", refused: false },
  ])(
    "data-backed repeat sink $binding with sensitive write $into",
    ({ binding, into, refused }) => {
      const spec = specWith({ query: { q: binding } }, into);
      const repeated = {
        ...spec,
        data: { rows: [{ code: "authored" }] },
        root: { ...spec.root, repeat: { items: { path: "/rows" }, as: "row" } },
      };
      const error = {
        path: "root.children[1].onTap[0].query.q",
        message: "Sensitive value cannot be bound into a request",
      };
      expect(validatePrototypeSpec(repeated).success).toBe(true);
      expect(prototypeSensitiveSinkErrors(repeated)).toEqual(refused ? [error] : []);
      expect(prototypeSensitiveSinkErrors(repeated).length > 0).toBe(refused);
    },
  );

  test("literal repeat rows do not read the overlapping data collection", () => {
    const spec = specWith(
      { query: { text: "{row.code}", typed: { item: "code" } } },
      "/data/rows/0/code",
    );
    const repeated = {
      ...spec,
      root: { ...spec.root, repeat: { items: [{ code: "authored" }], as: "row" } },
    };
    expect(prototypeSensitiveSinkErrors(repeated)).toEqual([]);
  });

  test.each(["{entry.code}", { item: "code" }])(
    "data-backed repeats retain live row reads with no authored rows: %p",
    (binding) => {
      const spec = specWith({ query: { q: binding } }, "/data/rows/0/code");
      const repeated = {
        ...spec,
        data: { rows: [] },
        root: { ...spec.root, repeat: { items: { path: "/rows" }, as: "entry" } },
      };
      const error = {
        path: "root.children[1].onTap[0].query.q",
        message: "Sensitive value cannot be bound into a request",
      };
      expect(validatePrototypeSpec(repeated).success).toBe(true);
      expect(prototypeSensitiveSinkErrors(repeated)).toEqual([error]);
      expect(validatePrototypeSpec(repeated, { library: true })).toEqual({ success: false, error });
    },
  );

  test("a live repeat row used only in a label is accepted", () => {
    const spec = specWith({ query: { q: "static" } }, "/data/rows/0/code");
    const repeated = {
      ...spec,
      data: { rows: [{ code: "authored" }] },
      root: {
        ...spec.root,
        repeat: { items: { path: "/rows" }, as: "row" },
        children: spec.root.children.map((node) =>
          node.type === "button" ? { ...node, label: "{row.code}" } : node,
        ),
      },
    };
    expect(prototypeSensitiveSinkErrors(repeated)).toEqual([]);
  });

  test.each([
    { into: "/data/users/0/token", pointer: "/users/{index}", refused: false },
    { into: "/data/users/{index}/token", pointer: "/users/0", refused: true },
    { into: "/data/users/{index}/token", pointer: "/other/0", refused: false },
  ])("typed sink pointer $pointer stays literal for $into", ({ into, pointer, refused }) => {
    const spec = specWith({ query: { q: { data: pointer } } }, into);
    const repeated = {
      ...spec,
      root: { ...spec.root, repeat: { items: [{ code: "authored" }], as: "row" } },
    };
    const error = {
      path: "root.children[1].onTap[0].query.q",
      message: "Sensitive value cannot be bound into a request",
    };
    expect(validatePrototypeSpec(repeated).success).toBe(true);
    expect(prototypeSensitiveSinkErrors(repeated)).toEqual(refused ? [error] : []);
    expect(prototypeSensitiveSinkErrors(repeated).length > 0).toBe(refused);
  });

  test("a sensitive sibling pointer written inside a repeat does not taint the expanded query", () => {
    const spec = specWith({ query: { code: "{data:/{row.key}}" } }, "/data/other");
    const repeated = {
      ...spec,
      root: { ...spec.root, repeat: { items: [{ key: "code" }], as: "row" } },
    };
    expect(prototypeSensitiveSinkErrors(repeated)).toEqual([]);
  });

  test("repeated sensitive sinks are reported once per authored path in sorted order", () => {
    const spec = repeatedSpecWith(["other", "code", "code"], {
      query: { z: "{data:/{row.key}}", a: "{data:/{row.key}}" },
    });
    const errors = ["a", "z"].map((key) => ({
      path: `root.children[1].children[0].onTap[0].query.${key}`,
      message: "Sensitive value cannot be bound into a request",
    }));
    expect(prototypeSensitiveSinkErrors(spec)).toEqual(errors);
    expect(prototypeStrictPolicyError(spec, { library: true }, [])).toEqual(errors[0]);
  });

  test("sensitive scans cap repeated sink UTF-8 bytes including literal text", () => {
    const spec = repeatedSpecWith(
      Array.from({ length: 128 }, () => "other"),
      {
        query: { code: "é".repeat(16385) },
      },
    );
    const error = {
      path: "root.children[1].children[0].onTap[0].query.code",
      message: "Secure binding scan exceeds 4194304 expanded UTF-8 bytes",
    };
    expect(prototypeSensitiveSinkErrors(spec)).toEqual([error]);
    expect(prototypeStrictPolicyError(spec, { library: true }, [])).toEqual(error);
  });

  test("invalid repeat bindings retain the authored sensitive sink scan", () => {
    const spec = repeatedSpecWith(["code"], {
      query: { code: "{data:/code}", unresolved: "{data:/{row.key}} {row.missing}" },
    });
    expect(validatePrototypeSpec(spec).success).toBe(false);
    expect(prototypeSensitiveSinkErrors(spec)).toEqual([
      {
        path: "root.children[1].children[0].onTap[0].query.code",
        message: "Sensitive value cannot be bound into a request",
      },
    ]);
  });

  test("a sensitive value that only feeds text and conditions has no R2 sink error", () => {
    const spec = {
      id: "sensitive-text",
      window: { placement: { type: "fullscreen" } },
      requires: { platform: ["clipboard"] },
      root: {
        type: "column",
        children: [
          { type: "pasteButton", into: "/data/code" },
          { type: "text", text: "Pasted: {data:/code}" },
          {
            type: "button",
            label: "Send",
            onTap: [
              {
                type: "request",
                url: "https://example.com/submit",
                via: "device",
                query: { q: "static" },
              },
            ],
          },
        ],
      },
    };
    expect(prototypeSensitiveSinkErrors(spec)).toEqual([]);
  });

  test("a parent pointer that contains the sensitive member is reported", () => {
    const parent = specWith({ query: { user: "{data:/user}" } }, "/data/user/name");
    expect(prototypeSensitiveSinkErrors(parent)).toHaveLength(1);
  });

  test("a sibling pointer that does not overlap the sensitive member is accepted", () => {
    const spec = specWith({ query: { email: "{data:/user/email}" } }, "/data/user/name");
    expect(prototypeSensitiveSinkErrors(spec)).toEqual([]);
  });

  test("a non-sensitive call's /data result may reach a request", () => {
    const spec = {
      id: "plain-flow",
      window: { placement: { type: "fullscreen" } },
      requires: { platform: ["sound"] },
      root: {
        type: "button",
        label: "Play",
        onTap: [
          { type: "platform", call: "sound.play", into: "/data/played" },
          {
            type: "request",
            url: "https://example.com/x",
            via: "device",
            query: { p: "{data:/played}" },
          },
        ],
      },
    };
    expect(prototypeSensitiveSinkErrors(spec)).toEqual([]);
  });
});
