import { beforeAll, describe, expect, test } from "bun:test";
import { getFocusedTextField, type FocusedTextField } from "../../../src/features/action/ClearText";
import {
  IOS_TOKEN_SETTLE_MAX_MS,
  compareIosTypedText,
  describeIosCommittedText,
  explainIosIndeterminateText,
  verifyIosTypedText,
  type IosTypedTextObserver,
} from "../../../src/features/action/iosTypedTextVerification";
import { TextIndeterminateError } from "../../../src/features/action/TextIndeterminateError";
import type { ObserveResult } from "../../../src/models";
import { FakeTimer } from "../../fakes/FakeTimer";
import editMenuCapture from "../../fixtures/ios-messages-compose/runner-to-edit-menu.json";
import emptyCapture from "../../fixtures/ios-messages-compose/runner-to-empty-focused.json";
import tokenCapture from "../../fixtures/ios-messages-compose/runner-to-token.json";
import trailingCapture from "../../fixtures/ios-messages-compose/runner-to-token-trailing-text.json";
import { observationFromRunnerCapture } from "../../helpers/iosRunnerCapture";

// Typing verification for the Messages "To:" recipient token field, read from real iOS runner
// captures (iPhone 18 Pro, iOS 27.0) through the production focused-field reader (#15405).
const LABEL = "No Name, Searching";

let empty: ObserveResult;
let token: ObserveResult;
let trailing: ObserveResult;
let menu: ObserveResult;

function read(observation: ObserveResult): FocusedTextField {
  const field = getFocusedTextField(observation.viewHierarchy!, undefined, {
    includeIosNativeEditableValues: true,
  });
  expect(field).toBeDefined();
  return field!;
}

/** Serves the frames in order, repeating the last; `reads` counts the observations taken. */
function observerOf(...frames: ObserveResult[]) {
  const state = { reads: 0 };
  const observer: IosTypedTextObserver = {
    execute: async () => frames[Math.min(state.reads++, frames.length - 1)],
  };
  return { observer, state };
}

beforeAll(() => {
  empty = observationFromRunnerCapture(emptyCapture);
  token = observationFromRunnerCapture(tokenCapture);
  trailing = observationFromRunnerCapture(trailingCapture);
  menu = observationFromRunnerCapture(editMenuCapture);
});

describe("token field recognition", () => {
  test("an empty focused recipient field has no tokens", () => {
    expect(read(empty).tokens).toBeUndefined();
  });

  test("a committed token is read with no trailing text", () => {
    expect(read(token)).toMatchObject({ tokens: [LABEL], trailingText: "", secure: false });
  });

  test("the trailing text is the value minus the token labels", () => {
    expect(read(trailing)).toMatchObject({ tokens: [LABEL], trailingText: "ab" });
  });

  test("the open edit menu changes neither tokens nor trailing text", () => {
    const { tokens, trailingText, value } = read(menu);
    expect({ tokens, trailingText, value }).toEqual({
      tokens: [LABEL],
      trailingText: "ab",
      value: read(trailing).value,
    });
  });
});

describe("verifying typing against a token field", () => {
  test("a new token appearing is success for recipient entry", () => {
    expect(compareIosTypedText("5551234,", read(empty), read(token))).toEqual({ success: true });
  });

  test("typed text after an existing token is verified against the trailing text", () => {
    expect(compareIosTypedText("ab", read(token), read(trailing))).toEqual({ success: true });
  });

  test("a token plus trailing text is not compared as the full value", () => {
    const result = compareIosTypedText("ab", read(token), read(menu));
    expect(result).toEqual({ success: true });
  });

  test("unchanged trailing text and tokens means nothing was typed, naming the tokens", () => {
    const result = compareIosTypedText("ab", read(token), read(token));
    expect(result.success).toBe(false);
    expect(result.error).toContain(`"${LABEL}"`);
    expect(result.error).toContain("no new recipient token");
  });

  test("trailing text that lacks the typed characters is a warning, not a failure", () => {
    const result = compareIosTypedText("xyz", read(token), read(trailing));
    expect(result.success).toBe(true);
    expect(result.warning).toContain('"ab"');
  });
});

describe("bounded settle wait", () => {
  test("a token that commits on a later read is success", async () => {
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const { observer, state } = observerOf(token, token, trailing);
    const result = await verifyIosTypedText("ab", read(token), { observer, timer });
    expect(result).toEqual({ success: true });
    expect(state.reads).toBe(3);
  });

  test("an unchanged token field stops re-reading at the bound", async () => {
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const { observer, state } = observerOf(token);
    const result = await verifyIosTypedText("ab", read(token), { observer, timer });
    expect(result.success).toBe(false);
    expect(timer.getSleepHistory().reduce((sum, ms) => sum + ms, 0)).toBeLessThanOrEqual(
      IOS_TOKEN_SETTLE_MAX_MS,
    );
    expect(state.reads).toBeLessThanOrEqual(5);
  });

  test("an ordinary unchanged field is not re-read", async () => {
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const { observer, state } = observerOf(empty);
    await verifyIosTypedText("ab", read(empty), { observer, timer });
    expect(state.reads).toBe(1);
    expect(timer.getSleepCallCount()).toBe(0);
  });
});

describe("indeterminate typing into a token field", () => {
  const indeterminate = new TextIndeterminateError("Set text timed out after 5000ms").message;

  test("states the committed token when a new one appeared", async () => {
    const timer = new FakeTimer();
    const error = await explainIosIndeterminateText(indeterminate, "5551234,", read(empty), {
      observer: observerOf(token).observer,
      timer,
    });
    expect(error).toContain("Text outcome is indeterminate");
    expect(error).toContain("a new recipient token was committed");
    expect(error).toContain(LABEL);
  });

  test("states the tokens and the unchanged trailing text when nothing landed", () => {
    const text = describeIosCommittedText("ab", read(token), read(token));
    expect(text).toContain("no new recipient token");
    expect(text).toContain(LABEL);
  });

  test("states typed trailing text that did land", () => {
    expect(describeIosCommittedText("ab", read(token), read(trailing))).toContain(
      "now contains the typed characters",
    );
  });
});
