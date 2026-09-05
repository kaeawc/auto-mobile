import { afterEach, describe, expect, test } from "bun:test";
import {
  buildInputTextResultMessage,
  buildTapOnResultMessage,
  registerInteractionTools,
  resetTapOnElementFactory,
  setTapOnElementFactory,
  tapOnHandler,
} from "../../src/server/interactionTools";
import { ToolRegistry } from "../../src/server/toolRegistry";
import type { TapOnArgs } from "../../src/server/interactionToolTypes";
import { getStructuredField } from "../../src/utils/toolUtils";
import type { BootedDevice, TapOnElementResult, TapOnSelectedElement } from "../../src/models";

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
    const message = buildTapOnResultMessage(
      selected({ text: "Internet", totalMatches: 3 }),
      undefined,
    );
    expect(message).toContain("3 matches");
  });

  // Both identity fields must appear: Android rows commonly share a resource id
  // like ...:id/title, so id alone leaves "Internet" and "Calendar" byte-identical.
  test("includes both the resource id and the text as the match identity", () => {
    const message = buildTapOnResultMessage(
      selected({ text: "Internet", resourceId: "com.android.settings:id/title" }),
      undefined,
    );
    expect(message).toContain("matched id=com.android.settings:id/title");
    expect(message).toContain('text="Internet"');
  });

  test("two rows sharing a resource id stay distinguishable via their text", () => {
    const internet = buildTapOnResultMessage(
      selected({ text: "Internet", resourceId: "android:id/title" }),
      undefined,
    );
    const calendar = buildTapOnResultMessage(
      selected({ text: "Calendar", resourceId: "android:id/title" }),
      undefined,
    );
    expect(internet).not.toBe(calendar);
  });

  // For an ambiguous selector the chosen occurrence must be named — index 0 vs 2
  // (or a random pick) among identical rows is otherwise indistinguishable.
  test("names the chosen index when the selector is ambiguous", () => {
    const first = buildTapOnResultMessage(
      selected({ text: "Row", totalMatches: 3, indexInMatches: 0 }),
      undefined,
    );
    const third = buildTapOnResultMessage(
      selected({ text: "Row", totalMatches: 3, indexInMatches: 2 }),
      undefined,
    );
    expect(first).toContain("3 matches (index 0)");
    expect(third).toContain("3 matches (index 2)");
    expect(first).not.toBe(third);
  });

  // A testTag-selected Compose node may expose only a test tag (no text, no id);
  // the message must name it so tapping message_row_42 vs another tag is not
  // byte-identical.
  test("names the test tag when it is the only stable identity", () => {
    const message = buildTapOnResultMessage(selected({ testTag: "message_row_42" }), undefined);
    expect(message).toBe("Tapped on element (matched testTag=message_row_42; 1 match)");
  });

  test("two uniquely-tagged nodes stay distinguishable via their test tag", () => {
    const a = buildTapOnResultMessage(selected({ testTag: "message_row_42" }), undefined);
    const b = buildTapOnResultMessage(selected({ testTag: "message_row_7" }), undefined);
    expect(a).not.toBe(b);
  });

  test("omits the index for a precise single match", () => {
    const message = buildTapOnResultMessage(selected({ text: "Internet" }), undefined);
    expect(message).toContain("1 match");
    expect(message).not.toContain("index");
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
    const message = buildTapOnResultMessage(undefined, undefined, {
      text: "Learn more",
      occurrence: 2,
    });
    expect(message).toContain('activated link "Learn more" [occurrence 2]');
  });

  test("different activated links yield different messages", () => {
    const terms = buildTapOnResultMessage(undefined, undefined, { text: "Terms", occurrence: 0 });
    const privacy = buildTapOnResultMessage(undefined, undefined, {
      text: "Privacy",
      occurrence: 0,
    });
    expect(terms).not.toBe(privacy);
  });

  // Owner-scoped subtext taps resolve BOTH an owner and an activated link, so the
  // message must carry both — the owner identity and which link was activated —
  // otherwise activating "Terms" vs "Privacy" on the same owner is byte-identical.
  test("includes both the owner identity and the activated link when both are present", () => {
    const terms = buildTapOnResultMessage(selected({ text: "Legal" }), undefined, {
      text: "Terms",
      occurrence: 0,
    });
    const privacy = buildTapOnResultMessage(selected({ text: "Legal" }), undefined, {
      text: "Privacy",
      occurrence: 0,
    });
    expect(terms).toContain('matched text="Legal"');
    expect(terms).toContain('activated link "Terms"');
    expect(terms).not.toBe(privacy);
  });

  test("keeps the plain message when nothing was resolved", () => {
    expect(buildTapOnResultMessage(undefined, undefined)).toBe("Tapped on element");
  });

  test("uses only the search summary when there is no selected element", () => {
    const summary = "2 view hierarchy changes over 5 requests within 300ms";
    expect(buildTapOnResultMessage(undefined, summary)).toBe(`Tapped on element (${summary})`);
  });
});

// Handler-level coverage: exercise the REGISTERED tapOn handler path with an
// injected fake TapOnElement and assert the serialized envelope. Before #6152 a
// selector that matched nothing still produced "Tapped on element (...)" and no
// `isError` on the envelope — the exact shape #5902 fixed for inputText only.
describe("tapOnHandler (registered handler wiring)", () => {
  const fakeDevice = { deviceId: "fake", platform: "android" } as unknown as BootedDevice;
  const args: TapOnArgs = { selector: { text: "ZZZ_NO_SUCH_TEXT_ZZZ" }, platform: "android" };

  afterEach(() => {
    resetTapOnElementFactory();
    ToolRegistry.clearTools();
  });

  // The direct-call tests below only pin the wiring if the handler they call is
  // the one registered for "tapOn" — pin that identity so the two cannot drift.
  test("the module-scope handler is the one registered for tapOn", () => {
    ToolRegistry.clearTools();
    registerInteractionTools();
    expect(ToolRegistry.getTool("tapOn")?.deviceAwareHandler).toBe(tapOnHandler);
  });

  const fakeResult = (overrides: Partial<TapOnElementResult>): TapOnElementResult =>
    ({
      success: false,
      action: "tap",
      element: { bounds: { left: 0, top: 0, right: 0, bottom: 0 } },
      ...overrides,
    }) as TapOnElementResult;

  const parseMessage = (response: { content: Array<{ type: string; text: string }> }): string =>
    (JSON.parse(response.content[0].text) as { message: string }).message;

  test("a selector miss sets isError and reports the failure, not a tap", async () => {
    setTapOnElementFactory(() => ({
      execute: async () =>
        fakeResult({
          error:
            "Failed to perform tap on element: Element not found with provided text 'ZZZ_NO_SUCH_TEXT_ZZZ'",
          searchUntil: { durationMs: 1521, requestCount: 29, changeCount: 0 },
        }),
    }));

    const response = await tapOnHandler(fakeDevice, args);
    expect(response.isError).toBe(true);
    const message = parseMessage(response);
    // The failure keeps the search summary: the user sees both that nothing
    // matched and how long the selector was looked for.
    expect(message).toBe(
      "Failed to tap: Failed to perform tap on element: Element not found with provided text 'ZZZ_NO_SUCH_TEXT_ZZZ' (0 view hierarchy changes over 29 requests within 1521ms)",
    );
    expect(message).not.toContain("Tapped on element");
    // The failure message must also be the one on the wire (structuredContent).
    expect(getStructuredField(response, "message")).toBe(message);
    expect(getStructuredField(response, "success")).toBe(false);
  });

  test("a failure without search stats carries no empty summary parenthetical", async () => {
    setTapOnElementFactory(() => ({
      execute: async () => fakeResult({ error: "Element not found with provided text 'Missing'" }),
    }));

    const response = await tapOnHandler(fakeDevice, args);
    expect(response.isError).toBe(true);
    expect(parseMessage(response)).toBe(
      "Failed to tap: Element not found with provided text 'Missing'",
    );
  });

  // `||` not `??`: an empty-string error must still yield a non-empty failure
  // message (#4183 P4), never a blank or success-shaped one.
  test.each([
    [undefined, "Failed to tap: unknown error"],
    ["", "Failed to tap: unknown error"],
  ])("a failure with error %p yields %p", async (error, expected) => {
    setTapOnElementFactory(() => ({ execute: async () => fakeResult({ error }) }));

    const response = await tapOnHandler(fakeDevice, args);
    expect(response.isError).toBe(true);
    expect(parseMessage(response)).toBe(expected);
  });

  test("a successful tap keeps the success message and no isError", async () => {
    setTapOnElementFactory(() => ({
      execute: async () =>
        fakeResult({
          success: true,
          selectedElement: selected({ text: "Internet" }),
          searchUntil: { durationMs: 300, requestCount: 5, changeCount: 2 },
        }),
    }));

    const response = await tapOnHandler(fakeDevice, args);
    expect(response.isError).toBeUndefined();
    expect(parseMessage(response)).toBe(
      'Tapped on element (matched text="Internet"; 1 match; 2 view hierarchy changes over 5 requests within 300ms)',
    );
    expect(getStructuredField(response, "success")).toBe(true);
  });
});

describe("buildInputTextResultMessage", () => {
  test("names the field targeted by a selector", () => {
    expect(
      buildInputTextResultMessage({
        success: true,
        matchedId: "com.test:id/first_name",
        matchedText: "First name",
      }),
    ).toBe('Input text into element (id=com.test:id/first_name text="First name")');
  });

  test("reports selector failures as failures", () => {
    expect(
      buildInputTextResultMessage({
        success: false,
        error: "Element not found with provided text 'Missing'",
      }),
    ).toBe("Failed to input text: Element not found with provided text 'Missing'");
  });
});
