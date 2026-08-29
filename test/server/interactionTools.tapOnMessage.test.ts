import { describe, expect, test } from "bun:test";
import { buildTapOnResultMessage } from "../../src/server/interactionTools";
import type { TapOnSelectedElement } from "../../src/models";

const selected = (overrides: Partial<TapOnSelectedElement>): TapOnSelectedElement => ({
  text: "",
  resourceId: "",
  bounds: { left: 0, top: 0, right: 10, bottom: 10, centerX: 5, centerY: 5 },
  indexInMatches: 0,
  totalMatches: 1,
  selectionStrategy: "first",
  ...overrides,
});

describe("buildTapOnResultMessage", () => {
  // AC3: a precise selector must be distinguishable from an ambiguous one, and the
  // message must say what it matched — a correct tap and a wrong tap must not be
  // byte-identical (#5868).
  test("names the matched text and a single match count", () => {
    const message = buildTapOnResultMessage(selected({ text: "Internet" }), undefined);
    expect(message).toContain('matched text="Internet"');
    expect(message).toContain("1 match");
    expect(message).not.toContain("matches");
  });

  test("reports an ambiguous selector via the match count", () => {
    const message = buildTapOnResultMessage(selected({ text: "Internet", totalMatches: 3 }), undefined);
    expect(message).toContain("3 matches");
  });

  test("prefers the resource id as the match identity when present", () => {
    const message = buildTapOnResultMessage(
      selected({ text: "Internet", resourceId: "com.android.settings:id/title" }),
      undefined,
    );
    expect(message).toContain("matched id=com.android.settings:id/title");
  });

  test("a different matched text yields a different message", () => {
    const right = buildTapOnResultMessage(selected({ text: "Internet" }), undefined);
    const wrong = buildTapOnResultMessage(selected({ text: "Calendar" }), undefined);
    expect(right).not.toBe(wrong);
  });

  test("appends the hierarchy-changed search summary when provided", () => {
    const summary = "0 view hierarchy changes over 28 requests within 1523ms";
    const message = buildTapOnResultMessage(selected({ text: "Internet" }), summary);
    expect(message).toContain('matched text="Internet"');
    expect(message).toContain(summary);
  });

  // The accessibilityLink selector resolves no selectedElement; the message must
  // still say which semantic link was activated so different links are not
  // byte-identical.
  test("names the activated semantic link when there is no selected element", () => {
    const message = buildTapOnResultMessage(undefined, undefined, {
      text: "Terms and privacy",
      occurrence: 0,
    });
    expect(message).toBe('Tapped on element (activated link "Terms and privacy")');
  });

  test("includes the occurrence when it disambiguates repeated link text", () => {
    const message = buildTapOnResultMessage(undefined, undefined, { text: "Learn more", occurrence: 2 });
    expect(message).toContain('activated link "Learn more" [occurrence 2]');
  });

  test("different activated links yield different messages", () => {
    const terms = buildTapOnResultMessage(undefined, undefined, { text: "Terms", occurrence: 0 });
    const privacy = buildTapOnResultMessage(undefined, undefined, { text: "Privacy", occurrence: 0 });
    expect(terms).not.toBe(privacy);
  });

  test("prefers the matched element over the activated link when both are present", () => {
    const message = buildTapOnResultMessage(selected({ text: "Internet" }), undefined, {
      text: "Terms",
      occurrence: 0,
    });
    expect(message).toContain('matched text="Internet"');
    expect(message).not.toContain("activated link");
  });

  test("keeps the plain message when nothing was resolved", () => {
    expect(buildTapOnResultMessage(undefined, undefined)).toBe("Tapped on element");
  });

  test("uses only the search summary when there is no selected element", () => {
    const summary = "2 view hierarchy changes over 5 requests within 300ms";
    expect(buildTapOnResultMessage(undefined, summary)).toBe(`Tapped on element (${summary})`);
  });
});
