import { describe, expect, test } from "bun:test";
import { FakeTimer } from "../../fakes/FakeTimer";
import { TapSearchPhase, type TapSearchHost } from "../../../src/features/action/tapSearchPhase";
import { TapTargetUnavailableError } from "../../../src/features/action/tapTargetSupport";
import type { TapOnElementOptions } from "../../../src/models/TapOnElementOptions";

function phase(): TapSearchPhase {
  const host = {
    timer: new FakeTimer(),
    visionConfig: () => ({ enabled: false }),
  } as never as TapSearchHost;
  return new TapSearchPhase(host);
}

const notFound = (options: object, containerFound = true, selection?: object) =>
  phase()
    .handleElementNotFound(
      { action: "tap", ...options } as TapOnElementOptions,
      undefined,
      containerFound,
      undefined,
      selection as never,
    )
    .then(
      () => null,
      (error: unknown) => error as Error,
    );

describe("TapSearchPhase.handleElementNotFound", () => {
  test("reports a missing container before the target", async () => {
    const error = await notFound({ text: "Go", container: { text: "List" } }, false);
    expect(error?.message).toBe("Container element not found with provided text 'List'");
  });

  test("reports a stale container element id", async () => {
    const error = await notFound({ text: "Go", container: { elementId: "s2-abc" } }, false);
    expect(error?.message).toContain("is stale; re-observe");
  });

  test("names the selector that was not found", async () => {
    expect((await notFound({ text: "Go" }))?.message).toBe(
      "Element not found with provided text 'Go'",
    );
    expect((await notFound({ textAny: ["A", "B"] }))?.message).toBe(
      "Element not found with any provided text 'A', 'B'",
    );
    expect((await notFound({ testTag: "t" }))?.message).toBe(
      "Element not found with provided testTag 't'",
    );
    expect((await notFound({ elementId: "s2-x" }))?.message).toContain("is stale");
  });

  test("describes sibling misses and container scope", async () => {
    const error = await notFound({ text: "Go", sibling: {}, container: { text: "List" } });
    expect(error?.message).toBe(
      "No clickable sibling found next to element with text 'Go' within container text 'List'",
    );
  });

  test("explains soft-keyboard-only matches as not-found", async () => {
    const error = await notFound({ text: "q" }, true, { onlyKeyboardKeyMatch: true });
    expect(error).toBeInstanceOf(TapTargetUnavailableError);
    expect(error?.message).toContain("soft-keyboard key");
  });
});
