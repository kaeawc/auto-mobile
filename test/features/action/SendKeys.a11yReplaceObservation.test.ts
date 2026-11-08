import { describe, expect, test } from "bun:test";
import type { ObserveResult } from "../../../src/models";
import { SendKeys } from "../../../src/features/action/SendKeys";
import { A11Y_REPLACE_OBSERVATION_STALE_WARNING } from "../../../src/features/action/sendkeys/A11yReplaceObservationFence";
import { FakeTimer } from "../../fakes/FakeTimer";
import { android, createSendKeysHarness, focused } from "./SendKeysTestHarness";

// Model-level observer fake: the Contacts phone field from the #17462 dogfood run.
function phoneField(text: string): ObserveResult {
  return {
    ...focused,
    viewHierarchy: {
      hierarchy: { node: { $: { focused: "true", class: "android.widget.EditText", text } } },
    },
  };
}

/** The hierarchy lags the accessibility set-text by `lagReads` observations after the replace. */
function harness(lagReads: number) {
  let replaced = false;
  let readsSinceReplace = 0;
  let reads = 0;
  const observer = {
    execute: async () => {
      reads++;
      if (replaced && readsSinceReplace++ >= lagReads) {
        return phoneField("+1 512-555-0142");
      }
      return phoneField("+1 512-555");
    },
  };
  const timer = new FakeTimer();
  timer.enableAutoAdvance();
  const h = createSendKeysHarness(android, observer, timer);
  const replace = h.client.replace;
  h.client.replace = async (text) => {
    const result = await replace(text);
    replaced = true;
    return result;
  };
  const action = new SendKeys(android, h.adbFactory, {
    executor: h.executor,
    observer,
    timer,
    timestampProvider: { now: async () => 1 },
  });
  return {
    action,
    get reads() {
      return reads;
    },
  };
}

const command = {
  action: "type" as const,
  text: "+1 512-555-0142",
  operation: "replace" as const,
  mode: "a11y" as const,
};

describe("sendKeys a11y replace terminal observation (#17462)", () => {
  test("returns an observation taken after the text change", async () => {
    const h = harness(1);

    const result = await h.action.execute([command]);

    expect(result.success).toBe(true);
    expect(result.commands[0]).toMatchObject({ resolvedMode: "a11y", operation: "replace" });
    expect(JSON.stringify(result.observation?.viewHierarchy)).toContain("+1 512-555-0142");
    expect(result.warnings ?? []).not.toContain(A11Y_REPLACE_OBSERVATION_STALE_WARNING);
  });

  test("says the observation may be stale when the field never catches up", async () => {
    const h = harness(Number.POSITIVE_INFINITY);

    const result = await h.action.execute([command]);

    expect(result.success).toBe(true);
    expect(result.warnings).toContain(A11Y_REPLACE_OBSERVATION_STALE_WARNING);
  });
});
