import { expect, test } from "bun:test";
import {
  MAX_PROTOTYPE_LOOPS,
  prototypeLoopFields,
} from "../../../src/features/prototype/prototypeLoops";
import { validatePrototypeSpec } from "../../../src/features/prototype/prototypeValidation";

const loop = { effect: "pulse", periodMs: 400 };
const label = { type: "text", text: "Hi", loop };
const spec = (root: object) => ({
  id: "loops",
  window: { placement: { type: "fullscreen" } },
  root,
});

test("loop budget resets for every validation and excludes shimmer", () => {
  const root = {
    type: "column",
    children: Array.from({ length: 8 }, () => ({
      type: "box",
      children: [],
      loop,
      style: { shimmer: true },
    })),
  };
  expect(MAX_PROTOTYPE_LOOPS).toBe(8);
  expect(validatePrototypeSpec(spec(root)).success).toBe(true);
  expect(validatePrototypeSpec(spec(root)).success).toBe(true);
});
test("loop capability detection ignores opaque payloads", () => {
  expect(prototypeLoopFields({ ...spec(label), data: { loop }, state: { loop: "pulse" } })).toEqual(
    ["root.loop"],
  );
});
test("rest-pose errors follow structural errors on other nodes", () => {
  const result = validatePrototypeSpec(
    spec({
      type: "column",
      children: [
        { ...label, style: { scale: 1 } },
        { ...label, loop: { ...loop, periodMs: 1 } },
      ],
    }),
  );
  expect(result).toEqual({
    success: false,
    error: { path: "root.children[1].loop.periodMs", message: "Invalid number value" },
  });
});
