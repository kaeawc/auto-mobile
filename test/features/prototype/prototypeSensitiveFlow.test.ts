import { describe, expect, test } from "bun:test";
import { validatePrototypeSpec } from "../../../src/features/prototype/prototypeValidation";
import { prototypeSensitiveSinkErrors } from "../../../src/features/prototype/prototypeStrictPolicy";

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
