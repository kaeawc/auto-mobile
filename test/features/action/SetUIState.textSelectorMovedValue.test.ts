import { describe, expect, test } from "bun:test";
import { SetUIState } from "../../../src/features/action/SetUIState";
import type { InputTextOptions } from "../../../src/features/action/InputText";
import type { Element, ViewHierarchyResult } from "../../../src/models";
import { FakeTimer } from "../../fakes/FakeTimer";
import {
  FakeClearText,
  FakeInputText,
  FakeObserveScreenForSetUIState,
  FakeSwipeOn,
  FakeTapOnElement,
} from "../../fakes/FakeSetUIStateDependencies";
import { buildObserveResult } from "../../helpers/observeFixture";

// #17197: Settings search on an API 36 emulator. The selector names the field by the
// text it held before input ("display"); after typing "brightness" that text names a
// search-result breadcrumb instead of the field.
const searchFieldId = "com.google.android.settings.intelligence:id/open_search_view_edit_text";
const titleId = "com.google.android.settings.intelligence:id/title";
const breadcrumbId = "com.google.android.settings.intelligence:id/breadcrumb";

function searchField(text: string, resourceId = searchFieldId): Element {
  return {
    "resource-id": resourceId,
    class: "android.widget.EditText",
    text,
    "hint-text": "Search settings",
    editable: true,
    focusable: true,
    focused: true,
    bounds: { left: 168, top: 147, right: 912, bottom: 273 },
  };
}

function resultRow(title: string, breadcrumb: string, top: number): Element[] {
  return [
    {
      "resource-id": titleId,
      class: "android.widget.TextView",
      text: title,
      bounds: { left: 189, top, right: 1038, bottom: top + 59 },
    },
    {
      "resource-id": breadcrumbId,
      class: "android.widget.TextView",
      text: breadcrumb,
      bounds: { left: 189, top: top + 59, right: 1038, bottom: top + 112 },
    },
  ];
}

function hierarchy(fields: Element[], rows: Element[]): ViewHierarchyResult {
  return {
    hierarchy: {
      node: {
        $: {
          class: "android.widget.FrameLayout",
          bounds: { left: 0, top: 0, right: 1080, bottom: 2400 },
        },
        node: [...fields, ...rows].map(($) => ({ $ })),
      },
    },
  };
}

function harness(options: {
  /** What the device shows in the field after an input call. */
  typed: (text: string, inputCalls: number) => string;
  /** Extra nodes after input; defaults to a result row whose breadcrumb says "Display". */
  postInputFields?: (value: string) => Element[];
}) {
  const timer = new FakeTimer();
  timer.enableAutoAdvance();
  const tap = new FakeTapOnElement();
  const input = new FakeInputText();
  let fieldValue = "display";
  const observe = new FakeObserveScreenForSetUIState();
  observe.setResultFactory(() => {
    const typed = input.getCallCount() > 0;
    const fields = typed
      ? (options.postInputFields?.(fieldValue) ?? [searchField(fieldValue)])
      : [searchField(fieldValue)];
    const rows = typed ? resultRow("Brightness level", "Display", 420) : [];
    return buildObserveResult({
      updatedAt: timer.now(),
      screenSize: { width: 1080, height: 2400 },
      systemInsets: { top: 0, right: 0, bottom: 0, left: 0 },
      viewHierarchy: hierarchy(fields, rows),
    });
  });
  const action = new SetUIState(
    { name: "Settings", platform: "android", deviceId: "emulator-5554" },
    null,
    {
      timer,
      tapOnElement: tap,
      clearText: new FakeClearText(),
      swipeOn: new FakeSwipeOn(),
      observeScreen: observe,
      inputText: {
        execute: async (text: string, inputOptions?: InputTextOptions) => {
          const result = await input.execute(text, inputOptions);
          fieldValue = options.typed(text, input.getCallCount());
          return result;
        },
      },
    },
  );
  return { action, tap, input };
}

const request = { fields: [{ selector: { text: "display" }, value: "brightness" }] };

describe("SetUIState Android text selector whose old value moves to another node (#17197)", () => {
  test("verifies the edited field, not the result row the old text now names", async () => {
    const { action, input } = harness({ typed: (text) => text });

    const result = await action.execute(request);

    expect(result.success).toBe(true);
    expect(result.fields[0]).toMatchObject({ success: true, attempts: 1, verified: true });
    expect(input.getCallCount()).toBe(1);
  });

  test("a retry re-targets the field by its ID instead of tapping the result row", async () => {
    // The first input drops its last character, so verification retries once.
    const { action, tap } = harness({
      typed: (text, calls) => (calls === 1 ? text.slice(0, -1) : text),
    });

    const result = await action.execute(request);

    expect(result.success).toBe(true);
    expect(result.fields[0]).toMatchObject({ success: true, attempts: 2, verified: true });
    expect(tap.getCalls().map((call) => call.options)).toEqual([
      { elementId: searchFieldId, action: "focus" },
      { elementId: searchFieldId, action: "focus" },
    ]);
  });

  test("an ID shared by several nodes falls back to the text selector", async () => {
    // A second EditText with the same ID makes the ID ambiguous, so the text selector
    // decides: it names the result row, which is not verified and not retried into.
    const { action } = harness({
      typed: (text) => text,
      postInputFields: (value) => [
        searchField(value),
        { ...searchField("other"), bounds: { left: 168, top: 300, right: 912, bottom: 400 } },
      ],
    });

    const result = await action.execute(request);

    expect(result.success).toBe(false);
    expect(result.fields[0].attempts).toBe(2);
    expect(result.fields[0].error).toContain("not an editable field");
  });
});
