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
    expect(prototypeStrictPolicyError(spec, { library: true }, [])).toBeUndefined();
    expect(validatePrototypeSpec(spec, { library: true }).success).toBe(true);
  });

  test("a sensitive sibling pointer written inside a repeat does not taint the expanded query", () => {
    const spec = specWith({ query: { code: "{data:/{row.key}}" } }, "/data/other");
    const repeated = {
      ...spec,
      root: { ...spec.root, repeat: { items: [{ key: "code" }], as: "row" } },
    };
    expect(prototypeSensitiveSinkErrors(repeated)).toEqual([]);
    expect(validatePrototypeSpec(repeated, { library: true }).success).toBe(true);
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

  test("a sensitive value that only feeds text and conditions is accepted in a library", () => {
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
    expect(validatePrototypeSpec(spec, { library: true }).success).toBe(true);
  });

  test("a parent pointer that contains the sensitive member is reported", () => {
    const parent = specWith({ query: { user: "{data:/user}" } }, "/data/user/name");
    expect(prototypeSensitiveSinkErrors(parent)).toHaveLength(1);
  });

  test("a sibling pointer that does not overlap the sensitive member is accepted", () => {
    const spec = specWith({ query: { email: "{data:/user/email}" } }, "/data/user/name");
    expect(prototypeSensitiveSinkErrors(spec)).toEqual([]);
    expect(validatePrototypeSpec(spec, { library: true }).success).toBe(true);
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
