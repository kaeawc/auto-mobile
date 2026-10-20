import { expect, test } from "bun:test";
import {
  prototypeRefreshFields,
  prototypeRefreshUnsupportedMessage,
} from "../../../src/features/prototype/prototypeRefresh";
import {
  bindCheckedKeys,
  bindNodeFields,
  checkedKeyValues,
} from "../../../src/features/prototype/prototypeTemplate";
import { validatePrototypeSpec } from "../../../src/features/prototype/prototypeValidation";

const emit = { type: "emit", name: "refresh" };
const refresh = { stateKey: "busy", onRefresh: [emit] };

test("refresh discovery visits root, nested and component scrolls but not payloads", () => {
  const spec = {
    root: {
      type: "column",
      children: [
        { type: "scroll", refresh, child: { type: "text", text: "x" } },
        { type: "scroll", child: { type: "text", text: "plain" } },
      ],
      onTap: [{ ...emit, payload: { type: "scroll", refresh } }],
    },
    components: { feed: { root: { type: "scroll", refresh, child: { type: "text", text: "x" } } } },
  };
  expect(prototypeRefreshFields(spec)).toEqual([
    "root.children[0].refresh",
    "components.feed.root.refresh",
  ]);
  expect(prototypeRefreshFields(null)).toEqual([]);
});

test("refresh binds its key and actions to a repeat instance", () => {
  const node = {
    type: "scroll",
    refresh: {
      stateKey: "busy_{item.id}",
      onRefresh: [
        { type: "setState", key: "busy_{item.id}", value: true },
        { type: "emit", name: "reload_{item.id}" },
      ],
    },
    child: { type: "text", text: "x" },
  };
  const instance = { binding: { alias: "item", index: false }, values: { id: 7 }, index: 0 };
  expect(bindNodeFields(node, "root", instance).refresh).toEqual({
    stateKey: "busy_7",
    onRefresh: [
      { type: "setState", key: "busy_7", value: true },
      { type: "emit", name: "reload_7" },
    ],
  });
  expect(bindCheckedKeys(node, instance).refresh).toMatchObject({ stateKey: "busy_7" });
  expect(checkedKeyValues(node)).toContain("busy_{item.id}");
});

test("refresh needs a vertical scroll and a boolean key", () => {
  const spec = (scroll: object, state: object = { busy: false }) => ({
    id: "r",
    window: { placement: { type: "fullscreen" } },
    state,
    root: { type: "scroll", refresh, child: { type: "text", text: "x" }, ...scroll },
  });
  expect(validatePrototypeSpec(spec({})).success).toBe(true);
  expect(validatePrototypeSpec(spec({ axis: "vertical" })).success).toBe(true);
  const horizontal = validatePrototypeSpec(spec({ axis: "horizontal" }));
  expect(horizontal.success ? "" : horizontal.error.path).toBe("root.refresh");
  const typed = validatePrototypeSpec(spec({}, { busy: 1 }));
  expect(typed.success ? "" : typed.error.path).toBe("root.refresh.stateKey");
  // A toggle of the refresh key is checked against the same boolean binding.
  const toggled = validatePrototypeSpec({
    ...spec({}),
    root: {
      type: "scroll",
      refresh: { stateKey: "busy", onRefresh: [{ type: "increment", key: "busy" }] },
      child: { type: "text", text: "x" },
    },
  });
  expect(toggled.success).toBe(false);
});

test("the refusal names the capability, the path and the platform's update step", () => {
  expect(prototypeRefreshUnsupportedMessage(["root.refresh"], "android")).toContain(
    "prototype_refresh_v1",
  );
  expect(prototypeRefreshUnsupportedMessage(["root.refresh"], "ios")).toContain(
    "launchApp prototype: true",
  );
});
