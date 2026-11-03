import { describe, expect, test } from "bun:test";
import { prototypeSensitiveSinkErrors } from "../../../src/features/prototype/prototypeStrictPolicy";

const COPIES = 600;
const PER_BUTTON = 30;

/** Copies listed destination-first: /c600 <- /c599 ... /c1 <- /c0, with /c0 the paste target. */
function chainSpec(storageKey: string) {
  const actions = Array.from({ length: COPIES }, (_, i) => ({
    type: "setData",
    path: `/data/c${COPIES - i}`,
    value: { data: `/c${COPIES - i - 1}` },
  }));
  const buttons = Array.from({ length: COPIES / PER_BUTTON }, (_, i) => ({
    type: "button",
    label: `Copy ${i}`,
    onTap: actions.slice(i * PER_BUTTON, (i + 1) * PER_BUTTON),
  }));
  return {
    id: "chain",
    requires: { platform: ["clipboard"] },
    root: {
      type: "column",
      children: [{ type: "pasteButton", into: "/data/c0" }, ...buttons],
    },
    storage: { version: 1, keys: [storageKey] },
  };
}

describe("sensitive copy-taint propagation", () => {
  test("a reverse-ordered chain of copies taints its far end quickly", () => {
    const spec = chainSpec(`data:/c${COPIES}`);
    const started = performance.now();
    const errors = prototypeSensitiveSinkErrors(spec);
    expect(performance.now() - started).toBeLessThan(100);
    expect(errors).toEqual([
      { path: "storage.keys[0]", message: "Sensitive value cannot be persisted" },
    ]);
  });

  test("an unrelated destination stays untainted", () => {
    expect(prototypeSensitiveSinkErrors(chainSpec("data:/other"))).toEqual([]);
  });
});
