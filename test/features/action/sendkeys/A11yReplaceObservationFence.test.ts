import { describe, expect, test } from "bun:test";
import type { ObserveResult } from "../../../../src/models";
import type { SendKeysCommand } from "../../../../src/features/action/SendKeys";
import {
  A11Y_REPLACE_OBSERVATION_STALE_WARNING,
  a11yReplaceExpectedText,
  observeAfterA11yReplace,
} from "../../../../src/features/action/sendkeys/A11yReplaceObservationFence";
import { FakeTimer } from "../../../fakes/FakeTimer";
import { focused } from "../SendKeysTestHarness";

// Model-level observer fake: the Contacts phone field from the #17462 dogfood run.
function phoneField(text: string, password = false): ObserveResult {
  return {
    ...focused,
    viewHierarchy: {
      hierarchy: {
        node: {
          $: {
            focused: "true",
            class: "android.widget.EditText",
            text,
            ...(password ? { password: "true" } : {}),
          },
        },
      },
    },
  };
}

function timer(): FakeTimer {
  const fake = new FakeTimer();
  fake.enableAutoAdvance();
  return fake;
}

const replace: SendKeysCommand = {
  action: "type",
  text: "+1 512-555-0142",
  operation: "replace",
  mode: "a11y",
};

describe("a11yReplaceExpectedText", () => {
  test("names the text of a successful final a11y replace", () => {
    expect(
      a11yReplaceExpectedText([replace], {
        results: [{ index: 0, action: "type", success: true, resolvedMode: "a11y" }],
      }),
    ).toBe("+1 512-555-0142");
  });

  test.each([
    ["an IME replace", [replace], [{ success: true, resolvedMode: "ime" as const }], undefined],
    ["a failed replace", [replace], [{ success: false, resolvedMode: "a11y" as const }], undefined],
    [
      "an a11y insert",
      [{ ...replace, operation: "insert" as const }],
      [{ success: true, resolvedMode: "a11y" as const }],
      undefined,
    ],
    [
      "a replace followed by a key",
      [replace, { action: "key" as const, key: "enter" as const }],
      [
        { success: true, resolvedMode: "a11y" as const },
        { success: true, resolvedMode: undefined },
      ],
      undefined,
    ],
  ])("ignores %s", (_name, commands, results, expected) => {
    expect(
      a11yReplaceExpectedText(commands as SendKeysCommand[], {
        results: results.map((result, index) => ({
          index,
          action: commands[index]!.action,
          ...result,
        })),
      }),
    ).toBe(expected);
  });
});

describe("observeAfterA11yReplace", () => {
  test("re-observes until the field shows the replaced text (#17462 stale observation)", async () => {
    const reads = [phoneField("+1 512-555"), phoneField("+1 512-555-0142")];
    let count = 0;
    const result = await observeAfterA11yReplace(
      "+1 512-555-0142",
      async () => reads[Math.min(count++, reads.length - 1)]!,
      { timer: timer(), checkAbort: () => {} },
    );
    expect(count).toBe(2);
    expect(result.warning).toBeUndefined();
    expect(result.observation).toBe(reads[1]!);
  });

  test("accepts a formatter's separators around the replaced digits", async () => {
    let count = 0;
    const result = await observeAfterA11yReplace(
      "5125550142",
      async () => {
        count++;
        return phoneField("(512) 555-0142");
      },
      { timer: timer(), checkAbort: () => {} },
    );
    expect(count).toBe(1);
    expect(result.warning).toBeUndefined();
  });

  test("returns the last observation with a staleness warning after the bounded wait", async () => {
    const stale = phoneField("+1 512-555");
    let count = 0;
    const result = await observeAfterA11yReplace(
      "+1 512-555-0142",
      async () => {
        count++;
        return stale;
      },
      { timer: timer(), checkAbort: () => {} },
    );
    expect(count).toBe(3);
    expect(result).toEqual({ observation: stale, warning: A11Y_REPLACE_OBSERVATION_STALE_WARNING });
  });

  test("never waits on a password field it cannot read", async () => {
    let count = 0;
    const result = await observeAfterA11yReplace(
      "hunter2",
      async () => {
        count++;
        return phoneField("•••", true);
      },
      { timer: timer(), checkAbort: () => {} },
    );
    expect(count).toBe(1);
    expect(result.warning).toBeUndefined();
  });

  test("checks for abort before every read", async () => {
    let checks = 0;
    await observeAfterA11yReplace("x", async () => phoneField("y"), {
      timer: timer(),
      checkAbort: () => {
        checks++;
      },
    });
    expect(checks).toBe(3);
  });
});
