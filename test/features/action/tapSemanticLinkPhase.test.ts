import { describe, expect, test } from "bun:test";
import {
  TapSemanticLinkPhase,
  type TapSemanticLinkHost,
} from "../../../src/features/action/tapSemanticLinkPhase";
import type { TapOnElementOptions } from "../../../src/models/TapOnElementOptions";

function phase(): TapSemanticLinkPhase {
  const host = {
    device: { platform: "android", deviceId: "emulator-5554" },
    accessibilityService: () => {
      throw new Error("not used");
    },
    elementParser: () => {
      throw new Error("not used");
    },
  } as never as TapSemanticLinkHost;
  return new TapSemanticLinkPhase(host);
}

const error = (options: object) =>
  phase().validateSemanticLinkOptions({ action: "tap", ...options } as TapOnElementOptions);

describe("TapSemanticLinkPhase.validateSemanticLinkOptions", () => {
  test("passes options without a semantic link target", () => {
    expect(error({ text: "Go" })).toBeNull();
  });

  test("rejects layer with a semantic link", () => {
    expect(error({ accessibilityLink: "Terms", layer: "app" })).toBe(
      "tapOn layer cannot be used with accessibilityLink or subtext",
    );
  });

  test("rejects unique selection with sibling or direct link", () => {
    expect(error({ accessibilityLink: "Terms", selectionStrategy: "unique" })).toContain(
      "unique selection cannot use sibling",
    );
  });

  test("rejects link and subtext together", () => {
    expect(error({ accessibilityLink: "A", subtext: { text: "B" } })).toBe(
      "tapOn accessibilityLink and subtext cannot be used together",
    );
  });

  test("rejects non-tap actions, blank text and negative occurrence", () => {
    expect(error({ accessibilityLink: "A", action: "longPress" })).toContain("only the tap action");
    expect(error({ accessibilityLink: "  " })).toBe("tapOn semantic link text must be non-empty");
    expect(error({ subtext: { text: "A", occurrence: -1 } })).toBe(
      "tapOn semantic link occurrence must be a non-negative integer",
    );
  });

  test("rejects index and random selection for owner-scoped links", () => {
    expect(error({ subtext: { text: "A" }, index: 1 })).toContain("cannot use index");
    expect(error({ subtext: { text: "A" }, selectionStrategy: "random" })).toContain(
      "cannot use random selection",
    );
  });

  test("accepts a plain accessibility link", () => {
    expect(error({ accessibilityLink: "Terms" })).toBeNull();
  });
});

describe("TapSemanticLinkPhase.hasSemanticLinkTarget", () => {
  test("is true for either selector", () => {
    const p = phase();
    expect(p.hasSemanticLinkTarget({ action: "tap", accessibilityLink: "A" } as never)).toBe(true);
    expect(p.hasSemanticLinkTarget({ action: "tap", subtext: { text: "A" } } as never)).toBe(true);
    expect(p.hasSemanticLinkTarget({ action: "tap", text: "A" } as never)).toBe(false);
  });
});
