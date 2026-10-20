import { specTypeSchemas } from "@modelcontextprotocol/server";
import { asObservedResult } from "../../src/features/action/observedInteractionStages";
import { recordObservationRead } from "../../src/features/observe/observationReadScope";
import { z } from "zod/v4";
import { FakeTapStrategy } from "../fakes/FakeTapStrategy";
import { TapOnElement, tapResolvedLayer } from "../../src/features/action/TapOnElement";
import { DefaultElementParser } from "../../src/features/utility/ElementParser";
import { FakeElementSelector } from "../fakes/FakeElementSelector";
import { imeOcclusionHierarchy } from "../fixtures/observe/imeOcclusion";
import { FakeTimer } from "../fakes/FakeTimer";
import { FakeAdbExecutor } from "../fakes/FakeAdbExecutor";
import type { ObserveResult } from "../../src/models";
import { warmedTests } from "../helpers/interactionCancellation";
import { afterEach, describe, expect } from "bun:test";
import { readFileSync } from "node:fs";
import {
  type InteractionToolDependencies,
  buildTapOnResultMessage,
  hitTestHandler,
  hitTestSchema,
  registerInteractionTools,
  tapAtHandler,
  tapAtSchema,
  tapOnHandler,
} from "../../src/server/interactionTools";
import { loadAndroidHomeObserve } from "../fixtures/observe/observeFixture";
import { ToolRegistry } from "../../src/server/toolRegistry";
import type { TapAtArgs, TapOnArgs } from "../../src/server/interactionToolTypes";
import { getStructuredField } from "../../src/utils/toolUtils";
import type {
  BootedDevice,
  TapAtResult,
  TapOnElementResult,
  TapOnSelectedElement,
} from "../../src/models";
import { tapOnResultSchema } from "../../src/server/toolOutputSchemas";
import { ActionableError } from "../../src/models/ActionableError";
import type { TapOnCall } from "../../src/features/action/ActionCall";
import { isolateToolRegistry } from "../helpers/withTemporaryTool";

isolateToolRegistry();

const interactionDeps: InteractionToolDependencies = {};
/** Validates a value as a spec `CallToolResult`, as the v1 SDK's `CallToolResultSchema.parse` did. */
function parseCallToolResult(value: unknown) {
  const result = specTypeSchemas.CallToolResult["~standard"].validate(value);
  if (result.issues) {
    throw new Error(`Invalid CallToolResult: ${JSON.stringify(result.issues)}`);
  }
  return result.value;
}

const test = warmedTests(() => {
  delete interactionDeps.tapAtElementFactory;
  delete interactionDeps.tapOnElementFactory;
  delete interactionDeps.hitTestObservationFactory;
  ToolRegistry.clearTools();
});

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
// `isError` on the envelope — the exact shape #5902 first fixed for text input.
describe("tapOnHandler (registered handler wiring)", () => {
  const fakeDevice: BootedDevice = { deviceId: "fake", name: "fake", platform: "android" };
  const args: TapOnArgs = {
    selector: { text: "ZZZ_NO_SUCH_TEXT_ZZZ" },
    action: "tap",
    platform: "android",
  };

  afterEach(() => {
    delete interactionDeps.tapAtElementFactory;
    delete interactionDeps.tapOnElementFactory;
    ToolRegistry.clearTools();
  });

  // The direct-call tests below only pin the wiring if the handler registered for
  // "tapOn" produces the same response as the one they call, with the same injected
  // dependencies — pin that equivalence so the two cannot drift.
  test("the registered tapOn handler behaves like the module-scope handler", async () => {
    ToolRegistry.clearTools();
    registerInteractionTools(interactionDeps);
    interactionDeps.tapOnElementFactory = () => ({
      execute: async () => fakeResult({ error: "Element not found" }),
    });
    const registered = ToolRegistry.getTool("tapOn")?.deviceAwareHandler;
    expect(registered).toBeDefined();
    expect(await registered!(fakeDevice, { ...args })).toEqual(
      await tapOnHandler(fakeDevice, args, undefined, undefined, interactionDeps),
    );
  });

  test("IME-occluded Android focus keeps the tapOn MCP failure payload", async () => {
    const device: BootedDevice = { name: "Pixel", deviceId: "fake", platform: "android" };
    const hierarchy = imeOcclusionHierarchy();
    const element = new DefaultElementParser()
      .flattenViewHierarchy(hierarchy, { includeWindows: true })
      .find(({ element }) => element.text === "Continue as Guest")!.element;
    element.class = "android.widget.EditText";
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const adb = new FakeAdbExecutor();
    const observation: ObserveResult = {
      observationId: "occluded-focus",
      updatedAt: 1,
      screenSize: { width: 400, height: 240 },
      systemInsets: { top: 0, bottom: 0, left: 0, right: 0 },
      viewHierarchy: hierarchy,
      display: { key: "default", role: "unknown", posture: "unknown", generation: 0 },
    };
    class ObservedTap extends TapOnElement {
      override observedInteraction: TapOnElement["observedInteraction"] = async (action) => {
        const result = asObservedResult(await action(recordObservationRead(observation)));
        result.observation = observation;
        return result;
      };
    }
    const tap = new ObservedTap(device, adb, {
      timer,
      elementSelector: new FakeElementSelector(element),
      tapStrategy: new FakeTapStrategy(),
      selectionStateTracker: { prepare: async () => null, finalize: async () => [] },
    });
    const error =
      'Failed to perform tap on element: Target "Continue as Guest" is covered by the soft keyboard; dismiss the keyboard first.';
    interactionDeps.tapOnElementFactory = () => tap;
    const response = await tapOnHandler(
      device,
      {
        selector: { text: "Continue as Guest" },
        action: "focus",
        platform: "android",
      },
      undefined,
      undefined,
      interactionDeps,
    );
    expect(response.isError).toBe(true);
    const payload = {
      message: `Failed to tap: ${error}`,
      observation: undefined,
      success: false,
      action: "tap",
      error,
      searchUntil: { durationMs: 0, requestCount: 0, changeCount: 0 },
      element: { bounds: { left: 0, top: 0, right: 0, bottom: 0 } },
    };
    expect(response.structuredContent).toEqual(payload);
    expect(JSON.parse(response.content[0].text)).toEqual(JSON.parse(JSON.stringify(payload)));
    expect(adb.getExecutedCommands()).toEqual([]);
  });

  const fakeResult = (overrides: Partial<TapOnElementResult>): TapOnElementResult =>
    ({
      success: false,
      action: "tap",
      element: { bounds: { left: 0, top: 0, right: 0, bottom: 0 } },
      ...overrides,
    }) as TapOnElementResult;

  test("tapOn result with internal layer metadata passes the MCP SDK schema", async () => {
    const result = { ...fakeResult({ success: true }), [tapResolvedLayer]: "prototype" as const };
    interactionDeps.tapOnElementFactory = () => ({ execute: async () => result });
    const response = await tapOnHandler(fakeDevice, args, undefined, undefined, interactionDeps);

    expect(parseCallToolResult(response).structuredContent).toEqual(response.structuredContent);
    expect(
      Reflect.ownKeys(response.structuredContent).every((key) => typeof key === "string"),
    ).toBe(true);
    expect(result[tapResolvedLayer]).toBe("prototype");
  });

  const parseMessage = (response: { content: Array<{ type: string; text: string }> }): string =>
    (JSON.parse(response.content[0].text) as { message: string }).message;

  test("a selector miss sets isError and reports the failure, not a tap", async () => {
    interactionDeps.tapOnElementFactory = () => ({
      execute: async () =>
        fakeResult({
          error:
            "Failed to perform tap on element: Element not found with provided text 'ZZZ_NO_SUCH_TEXT_ZZZ'",
          searchUntil: { durationMs: 1521, requestCount: 29, changeCount: 0 },
        }),
    });

    const response = await tapOnHandler(fakeDevice, args, undefined, undefined, interactionDeps);
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

  test("unconfirmed activation warning appears in tapOn message and structured result", async () => {
    const warning = "TalkBack activation is unconfirmed";
    interactionDeps.tapOnElementFactory = () => ({
      execute: async () => fakeResult({ success: true, warnings: [warning] }),
    });
    const response = await tapOnHandler(fakeDevice, args, undefined, undefined, interactionDeps);
    expect(parseMessage(response)).toContain(`Warning: ${warning}`);
    expect(getStructuredField(response, "warnings")).toEqual([warning]);
  });

  test("a failure without search stats carries no empty summary parenthetical", async () => {
    interactionDeps.tapOnElementFactory = () => ({
      execute: async () => fakeResult({ error: "Element not found with provided text 'Missing'" }),
    });

    const response = await tapOnHandler(fakeDevice, args, undefined, undefined, interactionDeps);
    expect(response.isError).toBe(true);
    expect(parseMessage(response)).toBe(
      "Failed to tap: Element not found with provided text 'Missing'",
    );
  });

  // `||` not `??`: an empty-string error must still yield a non-empty failure
  // message (#4183 P4), never a blank or success-shaped one.
  const emptyErrorCases: ReadonlyArray<readonly [string | undefined, string]> = [
    [undefined, "Failed to tap: unknown error"],
    ["", "Failed to tap: unknown error"],
  ];
  test.each(emptyErrorCases)("a failure with error %p yields %p", async (error, expected) => {
    interactionDeps.tapOnElementFactory = () => ({ execute: async () => fakeResult({ error }) });

    const response = await tapOnHandler(fakeDevice, args, undefined, undefined, interactionDeps);
    expect(response.isError).toBe(true);
    expect(parseMessage(response)).toBe(expected);
  });

  test("a successful tap keeps the success message and no isError", async () => {
    interactionDeps.tapOnElementFactory = () => ({
      execute: async () =>
        fakeResult({
          success: true,
          selectedElement: selected({ text: "Internet" }),
          searchUntil: { durationMs: 300, requestCount: 5, changeCount: 2 },
        }),
    });

    const response = await tapOnHandler(fakeDevice, args, undefined, undefined, interactionDeps);
    expect(response.isError).toBeUndefined();
    expect(parseMessage(response)).toBe(
      'Tapped on element (matched text="Internet"; 1 match; 2 view hierarchy changes over 5 requests within 300ms)',
    );
    expect(getStructuredField(response, "success")).toBe(true);
  });

  test("an already-checked toggle reports a skipped tap and exposes it in the payload", async () => {
    interactionDeps.tapOnElementFactory = () => ({
      execute: async () =>
        fakeResult({
          success: true,
          skipped: "already-checked",
          selectedElement: selected({ text: "Wi-Fi" }),
        }),
    });

    const response = await tapOnHandler(
      fakeDevice,
      { ...args, ensureChecked: true },
      undefined,
      undefined,
      interactionDeps,
    );
    const message = parseMessage(response);
    expect(message).toContain("already");
    expect(message).toContain("no tap");
    expect(message).not.toContain("Tapped");
    expect(getStructuredField(response, "skipped")).toBe("already-checked");
    expect(tapOnResultSchema.parse({ success: true, skipped: "already-checked" }).skipped).toBe(
      "already-checked",
    );
  });

  test("a verified ensureChecked tap reports the checked-state transition", async () => {
    interactionDeps.tapOnElementFactory = () => ({
      execute: async () =>
        fakeResult({
          success: true,
          element: { checked: "false", bounds: { left: 0, top: 0, right: 0, bottom: 0 } },
          selectedElement: selected({ text: "Wi-Fi" }),
        }),
    });

    const response = await tapOnHandler(
      fakeDevice,
      { ...args, ensureChecked: true },
      undefined,
      undefined,
      interactionDeps,
    );
    const message = parseMessage(response);
    expect(message).toContain("was unchecked");
    expect(message).toContain("now checked");
    expect(message).toContain("(verified)");
  });

  // #11638: the match is promoted to the clickable row, so selectedElement.text is
  // empty; the label the caller searched for must still appear in the message.
  test("names the selector label when the promoted row carries no text (#11638)", async () => {
    interactionDeps.tapOnElementFactory = () => ({
      execute: async () => fakeResult({ success: true, selectedElement: selected({ text: "" }) }),
    });

    const response = await tapOnHandler(
      fakeDevice,
      {
        selector: { text: "Network & internet" },
        action: "tap",
        platform: "android",
      },
      undefined,
      undefined,
      interactionDeps,
    );

    expect(parseMessage(response)).toBe(
      'Tapped on element (matched text="Network & internet"; 1 match)',
    );
  });

  test("names the searched label, not a shared resource id, in the toggle transition (#11638)", async () => {
    interactionDeps.tapOnElementFactory = () => ({
      execute: async () =>
        fakeResult({
          success: true,
          element: { checked: "true", bounds: { left: 0, top: 0, right: 0, bottom: 0 } },
          selectedElement: selected({
            text: "",
            resourceId: "com.android.settings:id/switchWidget",
          }),
        }),
    });

    const response = await tapOnHandler(
      fakeDevice,
      {
        selector: { text: "Wi-Fi" },
        action: "tap",
        ensureChecked: false,
        platform: "android",
      },
      undefined,
      undefined,
      interactionDeps,
    );

    expect(parseMessage(response)).toStartWith(
      "Wi-Fi was checked, tapped, now unchecked (verified)",
    );
  });
});

describe("tapAtHandler (registered handler wiring)", () => {
  const fakeDevice: BootedDevice = { deviceId: "fake", name: "fake", platform: "android" };
  const args: TapAtArgs = { x: 12, y: 34, platform: "android" };

  afterEach(() => {
    delete interactionDeps.tapAtElementFactory;
    ToolRegistry.clearTools();
  });

  test("the registered tapAt handler behaves like the module-scope handler", async () => {
    registerInteractionTools(interactionDeps);
    interactionDeps.tapAtElementFactory = () => ({
      execute: async () => ({ success: true, x: 12, y: 34 }) as TapAtResult,
    });
    const registered = ToolRegistry.getTool("tapAt")?.deviceAwareHandler;
    expect(registered).toBeDefined();
    expect(await registered!(fakeDevice, args)).toEqual(
      await tapAtHandler(fakeDevice, args, undefined, undefined, interactionDeps),
    );
  });

  test("accepts coordinate gestures, response controls, and shared device targeting", () => {
    expect(
      tapAtSchema.safeParse({
        x: 12,
        y: 34,
        platform: "android",
        sessionUuid: "session-123",
        keepScreenAwake: true,
        device: "Pixel",
        deviceId: "emulator-5554",
        raw: true,
        project: "full",
      }).success,
    ).toBe(true);
    expect(tapAtSchema.safeParse({ x: 12, y: 34, selector: { text: "Nope" } }).success).toBe(false);
    expect(tapAtSchema.safeParse({ x: 12, y: 34, duration: 10 }).success).toBe(false);
    expect(tapAtSchema.safeParse({ x: 12, y: 34, snapshotId: "ref-1" }).success).toBe(true);
    expect(tapAtSchema.safeParse({ x: 12, y: 34, snapshotId: "" }).success).toBe(false);
    expect(
      tapAtSchema.safeParse({
        x: 1,
        y: 0.5,
        coordinateSpace: "normalized",
        action: "doubleTap",
        display: "cover",
      }).success,
    ).toBe(true);
    expect(
      tapAtSchema.safeParse({
        x: 100,
        y: 50,
        coordinateSpace: "percent",
        action: "longPress",
        durationMs: 750,
      }).success,
    ).toBe(true);
    expect(tapAtSchema.safeParse({ x: 101, y: 0, coordinateSpace: "percent" }).success).toBe(false);
    expect(tapAtSchema.safeParse({ x: 0, y: 0, durationMs: 750 }).success).toBe(false);
  });

  test("serializes a successful native-coordinate tap", async () => {
    interactionDeps.tapAtElementFactory = () => ({
      execute: async () => ({ success: true, x: 12, y: 34 }) as TapAtResult,
    });

    const response = await tapAtHandler(fakeDevice, args, undefined, undefined, interactionDeps);

    expect(response.isError).toBeUndefined();
    expect(getStructuredField(response, "message")).toBe("Tapped at (12, 34)");
    expect(getStructuredField(response, "deviceId")).toBe(fakeDevice.deviceId);
    expect(getStructuredField(response, "platform")).toBe(fakeDevice.platform);
    expect(getStructuredField(response, "x")).toBe(12);
    expect(getStructuredField(response, "y")).toBe(34);
  });

  test("passes snapshot and gesture options through to tapAt", async () => {
    let received: unknown;
    interactionDeps.tapAtElementFactory = () => ({
      execute: async (options) => {
        received = options;
        return { success: true, x: 30, y: 40, action: "doubleTap" };
      },
    });

    const response = await tapAtHandler(
      fakeDevice,
      {
        ...args,
        x: 0.3,
        y: 0.4,
        snapshotId: "ref-1",
        coordinateSpace: "normalized",
        action: "doubleTap",
      },
      undefined,
      undefined,
      interactionDeps,
    );

    expect(received).toMatchObject({
      x: 0.3,
      y: 0.4,
      snapshotId: "ref-1",
      coordinateSpace: "normalized",
      action: "doubleTap",
    });
    expect(getStructuredField(response, "message")).toBe("Double tapped at (30, 40)");
  });

  test("marks a coordinate-tap failure as an MCP error", async () => {
    interactionDeps.tapAtElementFactory = () => ({
      execute: async () =>
        ({ success: false, x: 10, y: 34, error: "outside screen bounds" }) as TapAtResult,
    });

    const response = await tapAtHandler(fakeDevice, args, undefined, undefined, interactionDeps);

    expect(response.isError).toBe(true);
    expect(getStructuredField(response, "message")).toBe(
      "Failed to tap at (10, 34): outside screen bounds",
    );
    expect(getStructuredField(response, "deviceId")).toBe(fakeDevice.deviceId);
    expect(getStructuredField(response, "platform")).toBe(fakeDevice.platform);
  });
});

describe("hitTestHandler", () => {
  afterEach(() => {
    delete interactionDeps.hitTestObservationFactory;
    ToolRegistry.clearTools();
  });

  test("registers an opt-in preview with the same strict coordinate inputs as tapAt", () => {
    registerInteractionTools(interactionDeps);
    const tool = ToolRegistry.getTool("hitTest");
    expect(tool?.deviceAwareHandler).toBeDefined();
    expect(tool?.defaultEnabled).toBe(false);
    const validInput = { x: 1, y: 2, snapshotId: "ref-1" };
    expect(hitTestSchema.safeParse(validInput).success).toBe(true);
    expect(tapAtSchema.safeParse(validInput).success).toBe(true);
    expect(hitTestSchema.safeParse({ ...validInput, unexpected: true }).success).toBe(false);
    expect(tapAtSchema.safeParse({ ...validInput, unexpected: true }).success).toBe(false);
    expect(hitTestSchema.safeParse({ x: 1, y: 2, selector: "wrong" }).success).toBe(false);
    expect(hitTestSchema.safeParse({ x: 0.5, y: 1, coordinateSpace: "normalized" }).success).toBe(
      true,
    );
    expect(hitTestSchema.safeParse({ x: 1.01, y: 0, coordinateSpace: "normalized" }).success).toBe(
      false,
    );
    expect(hitTestSchema.safeParse({ x: 0, y: 0, action: "doubleTap" }).success).toBe(false);
    const definitions = JSON.parse(readFileSync("schemas/tool-definitions.json", "utf8")) as Array<{
      name: string;
      inputSchema?: { description?: string };
    }>;
    const description = definitions.find((definition) => definition.name === "hitTest")?.inputSchema
      ?.description;
    expect(description).toBe(
      "Preview which hierarchy nodes sit beneath one absolute point without dispatching input.",
    );
    expect(description).not.toContain("Tap one absolute point");
  });

  test("registered hitTest schema rejects obsolete observation controls", () => {
    registerInteractionTools(interactionDeps);
    const schema = ToolRegistry.getTool("hitTest")!.schema;
    const validInput = {
      x: 0.5,
      y: 1,
      coordinateSpace: "normalized",
      display: "active",
      snapshotId: "ref-1",
    };
    expect(schema.parse(validInput)).toMatchObject(validInput);
    const json = z.toJSONSchema(hitTestSchema);
    expect(json.properties).not.toHaveProperty("raw");
    expect(json.properties).not.toHaveProperty("project");
    const parsed = schema.safeParse({ ...validInput, raw: true, project: "full" });
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues).toMatchObject([
        {
          code: "unrecognized_keys",
          keys: ["raw", "project"],
          message: 'Unrecognized keys: "raw", "project"',
        },
      ]);
    }
    expect(tapAtSchema.safeParse({ ...validInput, raw: true, project: "full" }).success).toBe(true);
  });

  test("observes without screenshot or input and returns an estimate", async () => {
    const device = { deviceId: "fake", platform: "android" } as BootedDevice;
    const calls: unknown[] = [];
    const observation = loadAndroidHomeObserve().observe;
    interactionDeps.hitTestObservationFactory = () => ({
      execute: async (options) => {
        calls.push(options);
        return observation;
      },
    });
    const response = await hitTestHandler(
      device,
      { x: 1, y: 2, display: "active" },
      undefined,
      undefined,
      interactionDeps,
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ display: "active", skipScreenshot: true });
    expect(getStructuredField(response, "method")).toBe("hierarchy-bounds");
    expect(getStructuredField(response, "dispatchGuaranteed")).toBe(false);
    expect(getStructuredField(response, "deviceId")).toBe("fake");
  });

  test("resolves normalized hitTest coordinates in the shared native space", async () => {
    const device = { deviceId: "fake", platform: "android" } as BootedDevice;
    const observation = loadAndroidHomeObserve().observe;
    interactionDeps.hitTestObservationFactory = () => ({ execute: async () => observation });

    const response = await hitTestHandler(
      device,
      {
        x: 0.5,
        y: 0.5,
        coordinateSpace: "normalized",
      },
      undefined,
      undefined,
      interactionDeps,
    );

    expect(getStructuredField(response, "point")).toEqual({
      x: Math.round(observation.screenSize!.width / 2),
      y: Math.round(observation.screenSize!.height / 2),
    });
  });

  test("rejects an unknown snapshot reference before producing a preview", async () => {
    const device = { deviceId: "fake-unknown-reference", platform: "android" } as BootedDevice;
    const observation = loadAndroidHomeObserve().observe;
    interactionDeps.hitTestObservationFactory = () => ({ execute: async () => observation });

    const result = await hitTestHandler(
      device,
      {
        x: -1,
        y: 2,
        snapshotId: "ref-unknown",
      },
      undefined,
      undefined,
      interactionDeps,
    ).then(
      (response) => response,
      (error: unknown) => error,
    );
    expect(result).toBeInstanceOf(ActionableError);
    expect(result).toMatchObject({
      message: "Snapshot reference is unknown or evicted; re-observe.",
    });
  });
});

describe("tapOn handler transport deadline", () => {
  afterEach(() => {
    delete interactionDeps.tapOnElementFactory;
  });
  test("over-budget longPress propagates the real tapOn ActionableError before device work", async () => {
    const device: BootedDevice = { name: "Test", deviceId: "budget-tap-on", platform: "android" };
    const timer = new FakeTimer();
    timer.advanceTime(1000);
    const adb = new FakeAdbExecutor();
    const action = new TapOnElement(device, adb, { timer });
    interactionDeps.tapOnElementFactory = () => action;

    const internalArgs = {
      selector: { text: "Target" },
      action: "longPress" as const,
      duration: 20000,
      __mcpRequestDeadlineMs: timer.now() + 5000,
    };
    const call = tapOnHandler(device, internalArgs, undefined, undefined, interactionDeps);
    await expect(call).rejects.toBeInstanceOf(ActionableError);
    await expect(call).rejects.toThrow(
      "longPress duration 20000 ms does not fit the remaining request budget (5000 ms; needs 22000 ms including dispatch headroom); the press was not started.",
    );
    expect(adb.getExecutedCommands()).toEqual([]);
  });

  test.each([undefined, 123456])(
    "forwards transport deadline %s through internal context",
    async (deadline) => {
      let received: number | undefined;
      let recoveryPolicy: { throwOnKeyboardOcclusion?: boolean } | undefined;
      interactionDeps.tapOnElementFactory = () => ({
        execute: async (_options, call) => {
          received = (call as TapOnCall | undefined)?.deadlineMs;
          recoveryPolicy = (call as TapOnCall | undefined)?.recovery;
          return {
            success: true,
            action: "longPress",
            element: { text: "Target", bounds: { left: 0, top: 0, right: 0, bottom: 0 } },
          };
        },
      });
      const args = {
        selector: { text: "Target" },
        action: "longPress" as const,
        __mcpRequestDeadlineMs: deadline,
      };
      await tapOnHandler(
        { deviceId: "handler-deadline", name: "Test", platform: "android" },
        args,
        undefined,
        undefined,
        interactionDeps,
      );
      expect(received).toBe(deadline);
      expect(recoveryPolicy).toBeUndefined();
    },
  );
});
