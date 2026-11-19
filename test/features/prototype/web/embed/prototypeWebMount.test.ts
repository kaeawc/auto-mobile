import { describe, expect, test } from "bun:test";
import { prototypeWebRefusedFrame } from "../../../../../src/features/prototype/web/embed/prototypeWebMount";
import type { PrototypeWebFrame } from "../../../../../src/features/prototype/web/embed/prototypeWebRender";

/** A frame option as a page script may pass it: anything at all. */
const fromScript = (value: unknown) => value as PrototypeWebFrame;

describe("mount's refused frame (#16453)", () => {
  test("names an id, false, or the default frame when unset", () => {
    expect(prototypeWebRefusedFrame("iphone-16")).toBe("iphone-16");
    expect(prototypeWebRefusedFrame(false)).toBe(false);
    expect(prototypeWebRefusedFrame(undefined)).toBe("pixel-9");
  });

  test("names a frame object by its id", () => {
    expect(prototypeWebRefusedFrame(fromScript({ id: "my-phone" }))).toBe("my-phone");
  });

  test("names the default frame for null or an id-less object, without throwing", () => {
    expect(prototypeWebRefusedFrame(fromScript(null))).toBe("pixel-9");
    expect(prototypeWebRefusedFrame(fromScript({ label: "no id" }))).toBe("pixel-9");
  });
});
