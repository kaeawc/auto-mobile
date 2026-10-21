import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { requiredPrototypeCapabilities } from "../../../src/features/prototype/prototypeCapabilityGates";
import {
  bindPrototypeLinkifyActions,
  prototypeLinkifyFields,
  prototypeLinkifyMatches,
  prototypeLinkifyUnsupportedMessage,
  type PrototypeLinkifyKind,
  type PrototypeLinkifyMatch,
} from "../../../src/features/prototype/prototypeLinkify";
import { validatePrototypeSpec } from "../../../src/features/prototype/prototypeValidation";

const cases = JSON.parse(
  readFileSync(join(import.meta.dir, "../../fixtures/prototype-spec/linkify/cases.json"), "utf8"),
) as { text: string; kinds: PrototypeLinkifyKind[]; matches: PrototypeLinkifyMatch[] }[];

describe("linkify detection (#14233)", () => {
  test("the shared cases cover emails, punctuation, RTL and limits", () => {
    expect(cases.length).toBeGreaterThan(10);
    for (const entry of cases) {
      expect(prototypeLinkifyMatches(entry.text, entry.kinds)).toEqual(entry.matches);
    }
  });

  test("offsets are UTF-16 code units", () => {
    const [match] = prototypeLinkifyMatches("😀 #日本", ["hashtag"]);
    expect(match).toEqual({ kind: "hashtag", text: "#日本", start: 3, end: 6 });
  });

  test("a mention longer than 30 characters is not a mention", () => {
    expect(prototypeLinkifyMatches(`@${"a".repeat(31)}`, ["mention"])).toEqual([]);
  });
});

describe("linkify binding", () => {
  const match = { kind: "mention" as const, text: "@ana" };

  test("setState values become the matched text, other bindings a {value}", () => {
    expect(
      bindPrototypeLinkifyActions(
        [
          { type: "setState", key: "h", value: { match: "text" } },
          { type: "emit", name: "x", context: { kind: { match: "kind" } } },
          { type: "setData", path: "/data/x", value: { match: "text" } },
        ],
        match,
      ),
    ).toEqual([
      { type: "setState", key: "h", value: "@ana" },
      { type: "emit", name: "x", context: { kind: { value: "mention" } } },
      { type: "setData", path: "/data/x", value: { value: "@ana" } },
    ]);
  });

  test("literals and emit payloads stay opaque", () => {
    const actions = [
      { type: "setData", path: "/data/x", value: { value: { match: "text" } } },
      { type: "emit", name: "x", payload: { match: "text" } },
    ];
    expect(bindPrototypeLinkifyActions(actions, match)).toEqual(actions);
  });
});

describe("linkify validation and gate", () => {
  const spec = (root: unknown, extra: Record<string, unknown> = {}) => ({
    id: "l",
    window: { placement: { type: "fullscreen" } },
    ...extra,
    root,
  });
  const linked = {
    type: "text",
    text: "Hi @ana",
    linkify: {
      kinds: ["mention"],
      onTap: [{ type: "setState", key: "h", value: { match: "text" } }],
    },
  };

  test("a setState {match} into a textField-bound key is checked as text", () => {
    const root = { type: "column", children: [linked, { type: "textField", stateKey: "h" }] };
    expect(validatePrototypeSpec(spec(root, { state: { h: "" } })).success).toBe(true);
  });

  test("a setState {match} into a switch-bound key does not fit", () => {
    const root = { type: "column", children: [linked, { type: "switch", stateKey: "h" }] };
    const result = validatePrototypeSpec(spec(root, { state: { h: false } }));
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.path).toBe("root.children[0].linkify.onTap[0].value");
    }
  });

  test("the gate reports each linkify, including component definitions", () => {
    const withComponent = {
      ...spec({ type: "column", children: [linked] }),
      components: { Post: { root: linked } },
    };
    expect(prototypeLinkifyFields(withComponent)).toEqual([
      "root.children[0].linkify",
      "components.Post.root.linkify",
    ]);
    expect(requiredPrototypeCapabilities(spec(linked))).toContain("prototype_linkify_v1");
    expect(prototypeLinkifyFields(spec({ type: "text", text: "@ana" }))).toEqual([]);
  });

  test("the refusal names the capability and the field", () => {
    expect(prototypeLinkifyUnsupportedMessage(["root.linkify", "x"], "ios")).toBe(
      "The connected iOS prototype agent does not advertise prototype_linkify_v1, so it cannot linkify the text at root.linkify (and 1 more). Nothing was shown. Relaunch the app with launchApp prototype: true to load the agent built for this AutoMobile version, or use static spans instead.",
    );
  });
});
