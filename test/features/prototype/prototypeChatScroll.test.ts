import { describe, expect, test } from "bun:test";
import { requiredPrototypeCapabilities } from "../../../src/features/prototype/prototypeCapabilityGates";
import {
  prototypeChatScrollFields,
  prototypeChatScrollUnsupportedMessage,
} from "../../../src/features/prototype/prototypeChatScroll";
import { validatePrototypeSpec } from "../../../src/features/prototype/prototypeValidation";

const spec = (root: unknown, extra: Record<string, unknown> = {}) => ({
  id: "chat",
  window: { placement: { type: "fullscreen" } },
  ...extra,
  root,
});
const scroll = (extra: Record<string, unknown>) => ({
  type: "scroll",
  id: "chat",
  child: { type: "spacer" },
  ...extra,
});

describe("chat scroll validation (#14232)", () => {
  test("a repeat-bound atEndKey is checked per row, not as a literal key", () => {
    const repeated = {
      type: "column",
      repeat: { items: [{ id: "a" }], as: "room", key: "id" },
      children: [{ type: "scroll", atEndKey: "atEnd_{room.id}", child: { type: "spacer" } }],
    };
    expect(validatePrototypeSpec(spec(repeated, { state: { atEnd_a: true } })).success).toBe(true);
  });

  test("scrollTo targets a scroll by id from a sibling's actions", () => {
    const root = {
      type: "column",
      children: [
        scroll({ reverse: true }),
        { type: "button", label: "End", onTap: [{ type: "scrollTo", scroll: "chat", to: "end" }] },
      ],
    };
    expect(validatePrototypeSpec(spec(root)).success).toBe(true);
  });
});

describe("chat scroll gate", () => {
  test("reports the first chat option and every scrollTo", () => {
    const root = {
      type: "column",
      children: [
        scroll({ stickToEnd: true, onStartReached: [{ type: "emit", name: "older" }] }),
        { type: "button", label: "End", onTap: [{ type: "scrollTo", scroll: "chat", to: "end" }] },
      ],
    };
    expect(prototypeChatScrollFields(spec(root))).toEqual([
      "root.children[0].stickToEnd",
      "root.children[1].onTap[0]",
    ]);
    expect(requiredPrototypeCapabilities(spec(root))).toContain("prototype_chat_scroll_v1");
  });

  test("a plain scroll needs no gate", () => {
    expect(prototypeChatScrollFields(spec(scroll({})))).toEqual([]);
  });

  test("the refusal names the capability and the field", () => {
    expect(prototypeChatScrollUnsupportedMessage(["root.reverse"], "android")).toBe(
      "The connected CtrlProxy does not advertise prototype_chat_scroll_v1, so it cannot run the chat scroll at root.reverse. Nothing was shown. Update the connected CtrlProxy, or use a plain scroll.",
    );
  });
});
