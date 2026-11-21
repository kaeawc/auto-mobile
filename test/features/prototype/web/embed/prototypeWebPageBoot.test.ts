import { describe, expect, test } from "bun:test";
import {
  bootPrototypeWebPage,
  type PrototypeWebPageDom,
} from "../../../../../src/features/prototype/web/embed/prototypeWebPageBoot";
import type { PrototypeMountOptions } from "../../../../../src/features/prototype/web/embed/prototypeWebMountState";

interface FakeHost {
  readonly id: string;
}

const dom = (optionsText: string | null, host: FakeHost | null): PrototypeWebPageDom<FakeHost> => ({
  optionsText: () => optionsText,
  host: () => host,
});

describe("bootPrototypeWebPage (#16528)", () => {
  test("mounts the inlined options on the host", () => {
    const calls: Array<[FakeHost, PrototypeMountOptions]> = [];
    const host = { id: "host" };
    const handle = bootPrototypeWebPage(
      dom('{"spec":{"root":{"type":"text"}},"frame":"pixel-9","orientation":"landscape"}', host),
      (on, options) => {
        calls.push([on, options]);
        return "handle";
      },
    );
    expect(handle).toBe("handle");
    expect(calls).toEqual([
      [host, { spec: { root: { type: "text" } }, frame: "pixel-9", orientation: "landscape" }],
    ]);
  });

  test("draws nothing without inlined options or a host", () => {
    const mountOn = () => {
      throw new Error("mounted");
    };
    expect(bootPrototypeWebPage(dom(null, { id: "host" }), mountOn)).toBeUndefined();
    expect(bootPrototypeWebPage(dom('{"spec":{}}', null), mountOn)).toBeUndefined();
  });
});
