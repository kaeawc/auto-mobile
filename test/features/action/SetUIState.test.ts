import { getTextRequestDeadlineMs } from "../../../src/features/action/textTransportTimeout";
import { loggerCallsWithPrefix } from "../../helpers/loggerCallsWithPrefix";
import { beforeEach, describe, expect, spyOn, test } from "bun:test";
import { readFileSync } from "node:fs";
import { logger } from "../../../src/utils/logger";
import { SetUIState } from "../../../src/features/action/SetUIState";
import { resolveSwipeDirection } from "../../../src/features/action/swipeon/swipeOnUtils";
import type { SwipeDirection, SwipeOnOptions } from "../../../src/models/SwipeOnOptions";
import type { Keyboard } from "../../../src/features/action/Keyboard";
import { KeyboardOcclusionError } from "../../../src/models/KeyboardOcclusionError";
import { ElementResolver } from "../../../src/features/utility/ElementResolver";
import { SearchableHierarchy } from "../../../src/features/utility/SearchableNode";
import { nodeAttributes } from "../../../src/models/ViewHierarchyResult";
import { getHierarchyNodeSource } from "../../../src/features/observe/output/elementProvenance";
import { ResolverElementSelector } from "../../../src/features/utility/ResolverElementSelector";
import { BootedDevice, Element, ObserveResult, ViewHierarchyResult } from "../../../src/models";
import { FakeTimer } from "../../fakes/FakeTimer";
import iosFormsEmptyFields from "../../fixtures/observe/ios-forms-empty-fields";
import { iosFormsSwitch } from "../../fixtures/observe/ios-forms-switch";
import {
  MIN_SET_UI_STATE_MCP_TIMEOUT_MS,
  ProgressExtendableDeadline,
} from "../../../src/daemon/mcpRequestTimeout";
import {
  FakeTapOnElement,
  FakeInputText,
  FakeClearText,
  FakeSwipeOn,
  FakeObserveScreenForSetUIState,
  FakeFieldTypeDetector,
} from "../../fakes/FakeSetUIStateDependencies";

describe("SetUIState", () => {
  const device: BootedDevice = {
    name: "test-device",
    platform: "android",
    deviceId: "device-1",
  };

  let fakeTap: FakeTapOnElement;
  let fakeInput: FakeInputText;
  let fakeClear: FakeClearText;
  let fakeSwipe: FakeSwipeOn;
  let fakeObserve: FakeObserveScreenForSetUIState;
  let fakeFieldTypeDetector: FakeFieldTypeDetector;
  let fakeTimer: FakeTimer;

  const createHierarchyWithElement = (element: Partial<Element>): ViewHierarchyResult => ({
    hierarchy: {
      node: [
        {
          $: {
            bounds: { left: 0, top: 0, right: 100, bottom: 50 },
            ...element,
          },
        },
      ],
    },
  });

  const createObserveResult = (hierarchy?: ViewHierarchyResult): ObserveResult => ({
    updatedAt: Date.now(),
    screenSize: { width: 1080, height: 1920 },
    systemInsets: { top: 0, right: 0, bottom: 0, left: 0 },
    viewHierarchy: hierarchy,
  });

  const createSetUIState = (keyboard?: Pick<Keyboard, "execute">, platform = device.platform) => {
    return new SetUIState({ ...device, platform }, null, {
      keyboard,
      tapOnElement: fakeTap,
      inputText: {
        execute: async (text: string, imeAction?: string) => {
          const result = await fakeInput.execute(text, imeAction);
          const calls = fakeTap.getCalls();
          const target = calls[calls.length - 1]?.options;
          const key = target?.elementId ?? target?.text;
          if (key && result.success) {
            fakeFieldTypeDetector.setTextValue(key, text);
          }
          return result;
        },
      },
      clearText: fakeClear,
      swipeOn: fakeSwipe,
      observeScreen: fakeObserve,
      fieldTypeDetector: fakeFieldTypeDetector,
      timer: fakeTimer,
    });
  };

  beforeEach(() => {
    fakeTap = new FakeTapOnElement();
    fakeInput = new FakeInputText();
    fakeClear = new FakeClearText();
    fakeSwipe = new FakeSwipeOn();
    fakeObserve = new FakeObserveScreenForSetUIState();
    fakeFieldTypeDetector = new FakeFieldTypeDetector();
    fakeTimer = new FakeTimer();
    fakeTimer.enableAutoAdvance();
  });

  test("warns and preserves a field failure when focus throws", async () => {
    const error = new Error("focus transport failed");
    const tap = spyOn(fakeTap, "execute").mockRejectedValue(error);
    const warning = spyOn(logger, "warn").mockImplementation(() => {});
    try {
      const result = await createSetUIState()["applyFieldValue"](
        { text: "Name" },
        { selector: { text: "Name" }, value: "Jane" },
        "text",
      );
      expect(result).toEqual({ success: false, error: error.message, stopRetrying: false });
      expect(
        loggerCallsWithPrefix(warning.mock.calls, "[SetUIState] Failed to apply field value:"),
      ).toEqual([
        [
          "[SetUIState] Failed to apply field value: focus transport failed",
          expect.objectContaining({ message: error.message, cause: error }),
        ],
      ]);
    } finally {
      tap.mockRestore();
      warning.mockRestore();
    }
  });

  describe("text field handling", () => {
    test("Android setUIState opts into hint fallback when primary field text misses", async () => {
      const hierarchy = createHierarchyWithElement({
        "resource-id": "phone",
        text: "5551234",
        "hint-text": "Phone",
        class: "android.widget.EditText",
        clickable: true,
        focusable: true,
      });
      fakeObserve.setResult(createObserveResult(hierarchy));
      fakeFieldTypeDetector.setFieldType("phone", "text");
      fakeFieldTypeDetector.setTextValue("phone", "5551234");
      const resolve = spyOn(ElementResolver.prototype, "resolve");
      try {
        const result = await createSetUIState().execute({
          fields: [{ selector: { text: "Phone" }, value: "5551234" }],
        });
        expect(result.success).toBe(true);
        expect(result.fields[0].fieldType).toBe("text");
        expect(
          resolve.mock.calls.some(
            ([, selector, intent]) =>
              selector.text === "Phone" &&
              intent.action === "focus-input" &&
              intent.allowHintFallback === true,
          ),
        ).toBe(true);
      } finally {
        resolve.mockRestore();
      }
    });

    const keyboardRecoveryScenario = ({
      platform = device.platform,
      initiallyOpen = false,
      stillOccluded = false,
      focusError = new KeyboardOcclusionError("Original IME refusal"),
      dismissFails = false,
      dismissThrows = false,
    } = {}) => {
      let keyboardOpen = initiallyOpen;
      let dismissCalls = 0;
      let focusedKey = "";
      const events: string[] = [];
      const hierarchy = (passwordId: string): ViewHierarchyResult => ({
        hierarchy: {
          node: [
            {
              $: {
                text: "Email",
                "resource-id": "email",
                class: "android.widget.EditText",
                bounds: { left: 0, top: 100, right: 100, bottom: 150 },
              },
            },
            {
              $: {
                text: "Password",
                "resource-id": passwordId,
                class: "android.widget.EditText",
                bounds: { left: 0, top: 200, right: 100, bottom: 250 },
              },
            },
          ],
        },
      });
      fakeObserve.setResultFactory(() => {
        events.push("observe");
        return createObserveResult(hierarchy(dismissCalls > 0 ? "password-fresh" : "password"));
      });
      const executeTap = fakeTap.execute.bind(fakeTap);
      spyOn(fakeTap, "execute").mockImplementation(async (options, progress, signal) => {
        events.push(`focus:${options.elementId}`);
        const result = await executeTap(options, progress, signal);
        if (options.elementId?.startsWith("password") && (keyboardOpen || stillOccluded)) {
          throw dismissCalls > 0
            ? new KeyboardOcclusionError("Still covered after dismissal")
            : focusError;
        }
        focusedKey = options.elementId ?? "";
        keyboardOpen = true;
        return result;
      });
      const executeInput = fakeInput.execute.bind(fakeInput);
      spyOn(fakeInput, "execute").mockImplementation(async (text, imeAction) => {
        const result = await executeInput(text, imeAction);
        if (result.success) {
          fakeFieldTypeDetector.setTextValue(focusedKey, text);
        }
        return result;
      });
      const keyboard: Pick<Keyboard, "execute"> = {
        execute: async (action) => {
          expect(action).toBe("close");
          events.push("dismiss");
          dismissCalls++;
          if (dismissThrows) {
            throw new Error("Dismiss transport failed");
          }
          keyboardOpen = dismissFails;
          return { success: !dismissFails, open: keyboardOpen };
        },
      };
      return {
        action: createSetUIState(keyboard, platform),
        dismissCalls: () => dismissCalls,
        events,
        focusError,
      };
    };

    test("dismisses once and re-resolves a later text field covered by the raised IME", async () => {
      const scenario = keyboardRecoveryScenario();
      const result = await scenario.action.execute({
        fields: [
          { selector: { text: "Email" }, value: "lbl@mail.io" },
          { selector: { text: "Password" }, value: "pw-label-2" },
        ],
      });
      expect(result.success).toBe(true);
      expect(scenario.dismissCalls()).toBe(1);
      expect(result.fields.map(({ attempts }) => attempts)).toEqual([1, 1]);
      expect(fakeInput.getCalls().map(({ text }) => text)).toEqual(["lbl@mail.io", "pw-label-2"]);
      const dismissIndex = scenario.events.indexOf("dismiss");
      expect(scenario.events.slice(dismissIndex, dismissIndex + 3)).toEqual([
        "dismiss",
        "observe",
        "focus:password-fresh",
      ]);
    });

    test("recovers when the first requested field is already covered by the IME", async () => {
      const scenario = keyboardRecoveryScenario({ initiallyOpen: true });
      const result = await scenario.action.execute({
        fields: [{ selector: { text: "Password" }, value: "pw-label-2" }],
      });
      expect(result.success).toBe(true);
      expect(scenario.dismissCalls()).toBe(1);
    });

    test("does not dismiss for a non-occlusion focus failure even with the same message", async () => {
      const scenario = keyboardRecoveryScenario({
        initiallyOpen: true,
        focusError: new Error(
          "Target is covered by the soft keyboard; dismiss the keyboard first.",
        ),
      });
      const result = await scenario.action.execute({
        fields: [{ selector: { text: "Password" }, value: "pw-label-2" }],
      });
      expect(result.success).toBe(false);
      expect(scenario.dismissCalls()).toBe(0);
      expect(fakeClear.getCallCount()).toBe(0);
      expect(result.fields[0].attempts).toBe(3);
      expect(result.fields[0].error).toBe(scenario.focusError.message);
    });

    test.each(["android", "ios"] as const)(
      "%s non-occlusion focus throw preserves the unprefixed field error",
      async (platform) => {
        const scenario = keyboardRecoveryScenario({
          platform,
          initiallyOpen: true,
          focusError: new Error("Focus transport failed"),
        });
        const result = await scenario.action.execute({
          fields: [{ selector: { text: "Password" }, value: "pw-label-2" }],
        });
        expect(result.fields[0].error).toBe("Focus transport failed");
        expect(scenario.dismissCalls()).toBe(0);
      },
    );

    test("successful IME recovery emits zero warnings", async () => {
      const warn = spyOn(logger, "warn").mockImplementation(() => {});
      try {
        const scenario = keyboardRecoveryScenario({ initiallyOpen: true });
        const result = await scenario.action.execute({
          fields: [{ selector: { text: "Password" }, value: "pw-label-2" }],
        });
        expect(result.success).toBe(true);
        expect(loggerCallsWithPrefix(warn.mock.calls, "[SetUIState]")).toHaveLength(0);
        expect(fakeTap.execute).toHaveBeenCalledWith(
          { elementId: "password", action: "focus" },
          undefined,
          undefined,
          { throwOnKeyboardOcclusion: true },
        );
      } finally {
        warn.mockRestore();
      }
    });

    test("later occlusion warns for recovery and field failure without dismissing again", async () => {
      const warn = spyOn(logger, "warn").mockImplementation(() => {});
      try {
        const scenario = keyboardRecoveryScenario({ initiallyOpen: true });
        fakeInput.setResult({ success: false, text: "pw-label-2", error: "Input failed" });
        const result = await scenario.action.execute({
          fields: [{ selector: { text: "Password" }, value: "pw-label-2" }],
        });
        expect(result.success).toBe(false);
        expect(result.fields[0].error).toBe(scenario.focusError.message);
        expect(scenario.dismissCalls()).toBe(1);
        const warnings = loggerCallsWithPrefix(warn.mock.calls, "[SetUIState]");
        expect(warnings).toHaveLength(2);
        expect(warnings[0][0]).toBe("[SetUIState] IME recovery failed");
        expect(warnings[1]).toEqual([
          `[SetUIState] Failed to apply field value: ${scenario.focusError.message}`,
          scenario.focusError,
        ]);
      } finally {
        warn.mockRestore();
      }
    });

    test.each(["stillOccluded", "dismissFails", "dismissThrows"] as const)(
      "failed IME recovery warns for recovery and field failure when %s",
      async (failure) => {
        const warn = spyOn(logger, "warn").mockImplementation(() => {});
        try {
          const scenario = keyboardRecoveryScenario({ initiallyOpen: true, [failure]: true });
          const result = await scenario.action.execute({
            fields: [{ selector: { text: "Password" }, value: "pw-label-2" }],
          });
          expect(result.success).toBe(false);
          const warnings = loggerCallsWithPrefix(warn.mock.calls, "[SetUIState]");
          expect(warnings).toHaveLength(2);
          expect(warnings[0][0]).toBe("[SetUIState] IME recovery failed");
          expect(warnings[1]).toEqual([
            `[SetUIState] Failed to apply field value: ${scenario.focusError.message}`,
            scenario.focusError,
          ]);
        } finally {
          warn.mockRestore();
        }
      },
    );

    test.each(["stillOccluded", "dismissFails", "dismissThrows"] as const)(
      "surfaces the original occlusion error without repeated recovery when %s",
      async (failure) => {
        const scenario = keyboardRecoveryScenario({ initiallyOpen: true, [failure]: true });
        const result = await scenario.action.execute({
          fields: [{ selector: { text: "Password" }, value: "pw-label-2" }],
        });
        expect(result.success).toBe(false);
        expect(scenario.dismissCalls()).toBe(1);
        expect(result.fields[0].error).toBe(scenario.focusError.message);
        expect(result.fields[0].attempts).toBe(1);
        expect(fakeClear.getCallCount()).toBe(0);
        expect(fakeInput.getCallCount()).toBe(0);
        expect(fakeTap.getCallCount()).toBe(failure === "stillOccluded" ? 2 : 1);
      },
    );

    test.each(["text", "elementId"] as const)(
      "fills the captured Compose input selected by %s across focus ID churn (#9094, #9095)",
      async (selectorKind) => {
        const loadCapture = (moment: "pre" | "post"): ViewHierarchyResult =>
          JSON.parse(
            readFileSync(
              new URL(
                `../../fixtures/android-focus/playground-text-field-${moment}-tap.json`,
                import.meta.url,
              ),
              "utf8",
            ),
          ).viewHierarchy;
        const pre = loadCapture("pre");
        const post = loadCapture("post");
        const target = new ResolverElementSelector().selectByText(pre, "Basic Text Field", {
          intentAction: "focus-input",
        }).element!;
        expect(target["view-id"]).toBe("s2-0a67f33121084cd4");
        const detect = spyOn(fakeFieldTypeDetector, "detect");
        fakeObserve.setResultFactory(() =>
          createObserveResult(fakeObserve.getCallCount() === 1 ? pre : post),
        );
        const action = new SetUIState(device, null, {
          tapOnElement: fakeTap,
          inputText: {
            execute: async (text) => {
              const result = await fakeInput.execute(text);
              fakeFieldTypeDetector.setTextValue("", text);
              return result;
            },
          },
          clearText: fakeClear,
          swipeOn: fakeSwipe,
          observeScreen: fakeObserve,
          fieldTypeDetector: fakeFieldTypeDetector,
          timer: fakeTimer,
        });
        const selector =
          selectorKind === "text" ? { text: "Basic Text Field" } : { elementId: target["view-id"] };
        const result = await action.execute({
          fields: [{ selector, value: "captured input" }],
        });
        expect(result.success).toBe(true);
        expect(result.fields[0]).toMatchObject({ success: true, fieldType: "text", attempts: 1 });
        expect(
          detect.mock.calls.some(([element]) => element.class === "android.widget.EditText"),
        ).toBe(true);
        expect(fakeTap.getCalls()[0].options).toEqual({ ...selector, action: "focus" });
        expect(fakeClear.getCallCount()).toBe(1);
        expect(fakeInput.getCalls().map((call) => call.text)).toEqual(["captured input"]);
      },
    );

    test.each([false, true])(
      "derived variant: label promotion preserves its source (shared resource ID: %s)",
      async (sharedId) => {
        const capture: { viewHierarchy: ViewHierarchyResult } = JSON.parse(
          readFileSync(
            new URL(
              "../../fixtures/android-focus/playground-text-field-pre-tap.json",
              import.meta.url,
            ),
            "utf8",
          ),
        );
        // Derived variant: retain the first two captured rows, with controlled label IDs.
        const fields = new SearchableHierarchy()
          .project(capture.viewHierarchy)
          .filter((node) => node.className === "android.widget.EditText" && node.rootGroup === 0)
          .slice(0, 2);
        const hierarchy: ViewHierarchyResult = {
          hierarchy: { node: fields.map((field) => field.source) },
        };
        const nodes = new SearchableHierarchy().project(hierarchy);
        fields.forEach((field, index) => {
          nodeAttributes(field.source)["resource-id"] =
            index === 0 ? "field-first" : "field-second";
          const label = nodes.find(
            (node) =>
              node.parentIndex === nodes.find((node) => node.source === field.source)!.index &&
              node.properties.text,
          )!;
          label.source.bounds = field.bounds;
          nodeAttributes(label.source).text = index === 0 ? "First" : "Second";
          nodeAttributes(label.source)["resource-id"] = sharedId
            ? "shared-label"
            : `label-${index}`;
        });
        const resolver = new ResolverElementSelector();
        const selected = resolver.selectByResourceId(
          hierarchy,
          sharedId ? "shared-label" : "label-1",
          { intentAction: "focus-input" },
        );
        expect(selected.element?.["resource-id"]).toBe(sharedId ? "field-first" : "field-second");
        expect(selected.matchedElement?.text).toBe(sharedId ? "First" : "Second");
        expect(getHierarchyNodeSource(selected.matchedElement!)).toBeDefined();
        fakeObserve.setResult(createObserveResult(hierarchy));
        const detect = spyOn(fakeFieldTypeDetector, "detect");
        const result = await createSetUIState().execute({
          fields: [{ selector: { text: "Second" }, value: "new value" }],
        });
        expect(
          detect.mock.calls.some(([element]) => element["resource-id"] === "field-first"),
        ).toBe(false);
        expect(result.success).toBe(!sharedId);
        expect(fakeInput.getCallCount()).toBe(sharedId ? 0 : 1);
        expect(fakeClear.getCallCount()).toBe(sharedId ? 0 : 1);
      },
    );

    test("rejects a captured label without an enclosing editable field (#9095)", async () => {
      const capture: { viewHierarchy: ViewHierarchyResult } = JSON.parse(
        readFileSync(
          new URL(
            "../../fixtures/android-focus/playground-text-field-pre-tap.json",
            import.meta.url,
          ),
          "utf8",
        ),
      );
      fakeObserve.setResult(createObserveResult(capture.viewHierarchy));
      const result = await createSetUIState().execute({
        fields: [{ selector: { text: "Text" }, value: "must not type" }],
      });
      expect(result.success).toBe(false);
      expect(result.fields[0].error).toContain("not an editable field");
      expect(result.fields[0].attempts).toBe(1);
      expect(fakeClear.getCallCount()).toBe(0);
      expect(fakeInput.getCallCount()).toBe(0);
    });

    const textField = (elementId: string, top: number): Element => ({
      "resource-id": elementId,
      text: "",
      class: "android.widget.EditText",
      bounds: { left: 0, top, right: 100, bottom: top + 50 },
    });

    const buildCancellableTextAction = (
      onClear: (signal?: AbortSignal) => void = () => {},
      onInput: (text: string, signal?: AbortSignal) => void = () => {},
    ) =>
      new SetUIState(device, null, {
        tapOnElement: fakeTap,
        clearText: {
          execute: async (progress, signal) => {
            onClear(signal);
            return fakeClear.execute(progress);
          },
        },
        inputText: {
          execute: async (text, _imeAction, _dismissKeyboard, _mode, signal) => {
            const result = await fakeInput.execute(text);
            onInput(text, signal);
            return result;
          },
        },
        swipeOn: fakeSwipe,
        observeScreen: fakeObserve,
        fieldTypeDetector: fakeFieldTypeDetector,
        timer: fakeTimer,
      });

    test.each([
      { site: "initial observation", abortAt: 1, taps: 0 },
      { site: "off-screen search observation", abortAt: 2, taps: 0 },
      { site: "post-success observation", abortAt: 2, taps: 1 },
      { site: "field verification observation", abortAt: 2, taps: 1 },
      { site: "retry element refresh", abortAt: 3, taps: 1 },
    ])("forwards fresh-wait options and cancellation to $site", async ({ site, abortAt, taps }) => {
      const controller = new AbortController();
      const reason = new Error(`stop at ${site}`);
      const hierarchy: ViewHierarchyResult = {
        hierarchy: {
          node: [textField("first", 0), textField("second", 60)].map((element) => ({
            $: element,
          })),
        },
      };
      fakeFieldTypeDetector.setFieldType("first", "text");
      fakeFieldTypeDetector.setFieldType("second", "text");
      if (site === "post-success observation") {
        fakeFieldTypeDetector.setSkipVerification("first", true);
      }
      fakeObserve.setResultFactory((options) => {
        if (fakeObserve.getCallCount() === abortAt && options?.signal) {
          controller.abort(reason);
        }
        return createObserveResult(
          site === "off-screen search observation" ? { hierarchy: {} } : hierarchy,
        );
      });

      await expect(
        buildCancellableTextAction().execute(
          {
            fields: [
              { selector: { elementId: "first" }, value: "one" },
              { selector: { elementId: "second" }, value: "two" },
            ],
          },
          undefined,
          controller.signal,
        ),
      ).rejects.toBe(reason);
      expect(fakeObserve.getCallCount()).toBe(abortAt);
      for (const options of fakeObserve.getExecuteOptions()) {
        expect(options.signal).toBe(controller.signal);
        expect(options.skipWaitForFresh).toBe(false);
        expect(options.minTimestamp).toBe(0);
      }
      expect(fakeTap.getCallCount()).toBe(taps);
      expect(fakeClear.getCallCount()).toBe(taps);
      expect(fakeInput.getCalls().map((call) => call.text)).toEqual(taps ? ["one"] : []);
      expect(fakeSwipe.getCallCount()).toBe(site === "off-screen search observation" ? 1 : 0);
    });

    test("pre-aborted signal rejects before touching a field", async () => {
      const controller = new AbortController();
      const reason = new Error("stop before first field");
      controller.abort(reason);
      fakeObserve.setResult(createObserveResult(createHierarchyWithElement(textField("first", 0))));

      await expect(
        buildCancellableTextAction().execute(
          { fields: [{ selector: { elementId: "first" }, value: "one" }] },
          undefined,
          controller.signal,
        ),
      ).rejects.toBe(reason);
      expect(fakeObserve.getCallCount()).toBe(0);
      expect(fakeTap.getCallCount()).toBe(0);
      expect(fakeClear.getCallCount()).toBe(0);
      expect(fakeInput.getCallCount()).toBe(0);
    });

    test("abort during the first field preserves its input and never touches the second", async () => {
      const controller = new AbortController();
      const reason = new Error("stop after first input");
      fakeObserve.setResult(
        createObserveResult({
          hierarchy: {
            node: [textField("first", 0), textField("second", 60)].map((element) => ({
              $: element,
            })),
          },
        }),
      );
      fakeFieldTypeDetector.setFieldType("first", "text");
      fakeFieldTypeDetector.setFieldType("second", "text");
      let firstFieldValue = "";
      const action = buildCancellableTextAction(undefined, (text) => {
        firstFieldValue = text;
        controller.abort(reason);
      });

      await expect(
        action.execute(
          {
            fields: [
              { selector: { elementId: "first" }, value: "one" },
              { selector: { elementId: "second" }, value: "two" },
            ],
          },
          undefined,
          controller.signal,
        ),
      ).rejects.toBe(reason);
      expect(firstFieldValue).toBe("one");
      expect(fakeTap.getCallCount()).toBe(1);
      expect(fakeClear.getCallCount()).toBe(1);
      expect(fakeInput.getCalls().map((call) => call.text)).toEqual(["one"]);
    });

    test("forwards the actual form deadline to clear and input", async () => {
      fakeObserve.setResult(createObserveResult(createHierarchyWithElement(textField("first", 0))));
      fakeFieldTypeDetector.setFieldType("first", "text");
      fakeFieldTypeDetector.setSkipVerification("first", true);
      const deadlines: Array<number | undefined> = [];
      const deadline = fakeTimer.now() + 122_000;
      const action = buildCancellableTextAction(
        () => deadlines.push(getTextRequestDeadlineMs()),
        () => deadlines.push(getTextRequestDeadlineMs()),
      );
      const result = await action.execute(
        { fields: [{ selector: { elementId: "first" }, value: "a".repeat(1000) }] },
        undefined,
        undefined,
        deadline,
      );
      expect(result.success).toBe(true);
      expect(deadlines).toEqual([deadline - 4000, deadline - 4000]);
    });

    test("forwards the same signal to clear and input", async () => {
      const controller = new AbortController();
      const clearSignals: Array<AbortSignal | undefined> = [];
      const inputSignals: Array<AbortSignal | undefined> = [];
      fakeObserve.setResult(createObserveResult(createHierarchyWithElement(textField("first", 0))));
      fakeFieldTypeDetector.setFieldType("first", "text");
      fakeFieldTypeDetector.setSkipVerification("first", true);
      const action = buildCancellableTextAction(
        (signal) => clearSignals.push(signal),
        (_text, signal) => inputSignals.push(signal),
      );

      const result = await action.execute(
        { fields: [{ selector: { elementId: "first" }, value: "one" }] },
        undefined,
        controller.signal,
      );
      expect(result.success).toBe(true);
      expect(clearSignals).toEqual([controller.signal]);
      expect(inputSignals).toEqual([controller.signal]);
    });

    test("abort from clear prevents the input step", async () => {
      const controller = new AbortController();
      const reason = new Error("stop after clear");
      fakeObserve.setResult(createObserveResult(createHierarchyWithElement(textField("first", 0))));
      fakeFieldTypeDetector.setFieldType("first", "text");
      const action = buildCancellableTextAction(() => controller.abort(reason));

      await expect(
        action.execute(
          { fields: [{ selector: { elementId: "first" }, value: "one" }] },
          undefined,
          controller.signal,
        ),
      ).rejects.toBe(reason);
      expect(fakeClear.getCallCount()).toBe(1);
      expect(fakeInput.getCallCount()).toBe(0);
    });

    test("sets text field value with tap, clear, and input", async () => {
      const initialHierarchy = createHierarchyWithElement({
        "resource-id": "username",
        text: "",
        class: "android.widget.EditText",
      });
      const updatedHierarchy = createHierarchyWithElement({
        "resource-id": "username",
        text: "john@example.com",
        class: "android.widget.EditText",
      });

      let observeCallCount = 0;
      fakeObserve.setResultFactory(() => {
        observeCallCount++;
        if (observeCallCount <= 1) {
          return createObserveResult(initialHierarchy);
        }
        return createObserveResult(updatedHierarchy);
      });
      fakeFieldTypeDetector.setFieldType("username", "text");

      const setUIState = createSetUIState();
      const result = await setUIState.execute({
        fields: [{ selector: { elementId: "username" }, value: "john@example.com" }],
      });

      expect(result.success).toBe(true);
      expect(result.fields).toHaveLength(1);
      expect(result.fields[0].success).toBe(true);
      expect(result.fields[0].fieldType).toBe("text");

      // Verify the target field's focus was confirmed before clearing.
      expect(fakeTap.getCallCount()).toBeGreaterThanOrEqual(1);
      expect(fakeTap.getCalls()[0].options.action).toBe("focus");

      // Verify clear was called
      expect(fakeClear.getCallCount()).toBe(1);

      // Verify input was called
      expect(fakeInput.getCallCount()).toBe(1);
      expect(fakeInput.getCalls()[0].text).toBe("john@example.com");
    });

    test("skips text field when already has correct value", async () => {
      const hierarchy = createHierarchyWithElement({
        "resource-id": "username",
        text: "john@example.com",
        class: "android.widget.EditText",
      });
      fakeObserve.setResult(createObserveResult(hierarchy));
      fakeFieldTypeDetector.setFieldType("username", "text");
      fakeFieldTypeDetector.setTextValue("username", "john@example.com");

      const setUIState = createSetUIState();
      const result = await setUIState.execute({
        fields: [{ selector: { elementId: "username" }, value: "john@example.com" }],
      });

      expect(result.success).toBe(true);
      expect(result.fields[0].success).toBe(true);
      expect(result.fields[0].skipped).toBe(true);

      // No tap, clear, or input should be called
      expect(fakeTap.getCallCount()).toBe(0);
      expect(fakeClear.getCallCount()).toBe(0);
      expect(fakeInput.getCallCount()).toBe(0);
    });
  });

  describe("checkbox handling", () => {
    test.each(["elementId", "text"])(
      "taps checkbox when state needs to change selected by %s",
      async (kind) => {
        const initialHierarchy = createHierarchyWithElement({
          "resource-id": "remember_me",
          text: "Remember Me",
          class: "android.widget.CheckBox",
          checkable: "true" as any,
          checked: "false" as any,
        });
        const updatedHierarchy = createHierarchyWithElement({
          "resource-id": "remember_me",
          text: "Remember Me",
          class: "android.widget.CheckBox",
          checkable: "true" as any,
          checked: "true" as any,
        });

        let observeCallCount = 0;
        fakeObserve.setResultFactory(() => {
          observeCallCount++;
          if (observeCallCount <= 1) {
            return createObserveResult(initialHierarchy);
          }
          return createObserveResult(updatedHierarchy);
        });
        fakeFieldTypeDetector.setFieldType("remember_me", "checkbox");

        const setUIState = createSetUIState();
        const selector = kind === "text" ? { text: "remember" } : { elementId: "remember_me" };
        const result = await setUIState.execute({
          fields: [{ selector, selected: true }],
        });

        expect(result.success).toBe(true);
        expect(result.fields[0].success).toBe(true);
        expect(result.fields[0].fieldType).toBe("checkbox");

        // Verify tap was called to toggle
        expect(fakeTap.getCallCount()).toBe(1);
      },
    );

    test("skips checkbox when already has correct state", async () => {
      const hierarchy = createHierarchyWithElement({
        "resource-id": "remember_me",
        class: "android.widget.CheckBox",
        checkable: "true" as any,
        checked: "true" as any,
      });
      fakeObserve.setResult(createObserveResult(hierarchy));
      fakeFieldTypeDetector.setFieldType("remember_me", "checkbox");
      fakeFieldTypeDetector.setChecked("remember_me", true);

      const setUIState = createSetUIState();
      const result = await setUIState.execute({
        fields: [{ selector: { elementId: "remember_me" }, selected: true }],
      });

      expect(result.success).toBe(true);
      expect(result.fields[0].success).toBe(true);
      expect(result.fields[0].skipped).toBe(true);

      // No tap should be called
      expect(fakeTap.getCallCount()).toBe(0);
    });
  });

  describe("toggle handling", () => {
    test.each(["elementId", "text"])(
      "taps toggle when state needs to change selected by %s",
      async (kind) => {
        const initialHierarchy = createHierarchyWithElement({
          "resource-id": "dark_mode",
          text: "Dark Mode",
          class: "android.widget.Switch",
          checkable: "true" as any,
          checked: "true" as any,
        });
        const updatedHierarchy = createHierarchyWithElement({
          "resource-id": "dark_mode",
          text: "Dark Mode",
          class: "android.widget.Switch",
          checkable: "true" as any,
          checked: "false" as any,
        });

        let observeCallCount = 0;
        fakeObserve.setResultFactory(() => {
          observeCallCount++;
          if (observeCallCount <= 1) {
            return createObserveResult(initialHierarchy);
          }
          return createObserveResult(updatedHierarchy);
        });
        fakeFieldTypeDetector.setFieldType("dark_mode", "toggle");

        const setUIState = createSetUIState();
        const selector = kind === "text" ? { text: "dark" } : { elementId: "dark_mode" };
        const result = await setUIState.execute({
          fields: [{ selector, selected: false }],
        });

        expect(result.success).toBe(true);
        expect(result.fields[0].success).toBe(true);
        expect(result.fields[0].fieldType).toBe("toggle");

        // Verify tap was called to toggle off
        expect(fakeTap.getCallCount()).toBe(1);
      },
    );
  });

  describe("dropdown handling", () => {
    test.each(["elementId", "text"])(
      "opens dropdown and selects value selected by %s",
      async (kind) => {
        const initialHierarchy = createHierarchyWithElement({
          "resource-id": "country",
          text: "Select Country",
          class: "android.widget.Spinner",
        });
        const updatedHierarchy = createHierarchyWithElement({
          "resource-id": "country",
          text: "United States",
          class: "android.widget.Spinner",
        });

        let observeCallCount = 0;
        fakeObserve.setResultFactory(() => {
          observeCallCount++;
          if (observeCallCount <= 1) {
            return createObserveResult(initialHierarchy);
          }
          return createObserveResult(updatedHierarchy);
        });
        fakeFieldTypeDetector.setFieldType("country", "dropdown");

        const setUIState = createSetUIState();
        const selector = kind === "text" ? { text: "select" } : { elementId: "country" };
        const result = await setUIState.execute({
          fields: [{ selector, value: "United States" }],
        });

        expect(result.success).toBe(true);
        expect(result.fields[0].success).toBe(true);
        expect(result.fields[0].fieldType).toBe("dropdown");

        // Verify first tap to open dropdown
        expect(fakeTap.getCallCount()).toBe(2);
        expect(fakeTap.getCalls()[0].options).toEqual({ ...selector, action: "tap" });
        // Second tap selects the value
        expect(fakeTap.getCalls()[1].options.text).toBe("United States");
      },
    );
  });

  describe("scroll to find", () => {
    const modelSearch = (revealOn: "up" | "down" | "visible") => {
      let visible = revealOn === "visible";
      const fingerDirections: SwipeDirection[] = [];
      const executeSwipe = fakeSwipe.execute.bind(fakeSwipe);
      spyOn(fakeSwipe, "execute").mockImplementation(
        async (
          options: Parameters<FakeSwipeOn["execute"]>[0] & Pick<SwipeOnOptions, "gestureType">,
        ) => {
          const { direction } = options;
          if (direction !== "up" && direction !== "down") {
            throw new Error(`Unexpected search direction: ${direction}`);
          }
          const finger = resolveSwipeDirection({ ...options, direction }).direction;
          if (!finger) {
            throw new Error("Search swipe did not resolve a finger direction");
          }
          fingerDirections.push(finger);
          visible ||= finger === revealOn;
          return executeSwipe(options);
        },
      );
      fakeObserve.setResultFactory(() =>
        createObserveResult(
          visible
            ? createHierarchyWithElement({
                "resource-id": "field",
                text: "found!",
                class: "android.widget.EditText",
              })
            : { hierarchy: { node: [] } },
        ),
      );
      fakeFieldTypeDetector.setFieldType("field", "text");
      fakeFieldTypeDetector.setTextValue("field", "found!");
      return fingerDirections;
    };

    test("default search reveals a field below the fold after one finger-up swipe", async () => {
      const fingerDirections = modelSearch("up");
      const result = await createSetUIState().execute({
        fields: [{ selector: { elementId: "field" }, value: "found!" }],
      });

      expect(result.success).toBe(true);
      expect(result.fields[0].success).toBe(true);
      expect(fingerDirections).toEqual(["up"]);
      expect(fakeSwipe.getCallCount()).toBe(1);
    });

    test("reverse search reveals a field above the fold after three futile swipes", async () => {
      // Start scrolled down: only a finger-down swipe reveals the field above.
      const fingerDirections = modelSearch("down");
      const result = await createSetUIState().execute({
        fields: [{ selector: { elementId: "field" }, value: "found!" }],
      });

      expect(result.success).toBe(true);
      expect(result.fields[0].success).toBe(true);
      expect(fingerDirections).toEqual(["up", "up", "up", "down"]);
    });

    test("does not swipe when the field is already on screen", async () => {
      const fingerDirections = modelSearch("visible");
      const result = await createSetUIState().execute({
        fields: [{ selector: { elementId: "field" }, value: "found!" }],
      });

      expect(result.success).toBe(true);
      expect(fingerDirections).toEqual([]);
      expect(fakeSwipe.getCallCount()).toBe(0);
    });

    test.each([
      { scrollDirection: "up", fingerDirection: "down" },
      { scrollDirection: "down", fingerDirection: "up" },
    ] as const)(
      "respects scrollDirection option $scrollDirection with finger movement $fingerDirection",
      async ({ scrollDirection, fingerDirection }) => {
        const fingerDirections = modelSearch(fingerDirection);
        const result = await createSetUIState().execute({
          fields: [{ selector: { elementId: "field" }, value: "found!" }],
          scrollDirection,
        });

        expect(result.success).toBe(true);
        expect(fingerDirections).toEqual([fingerDirection]);
        expect(fakeSwipe.getCallCount()).toBe(1);
      },
    );
  });

  describe("retry logic", () => {
    test.each(["input", "clear"])("does not retry indeterminate iOS %s", async (operation) => {
      fakeObserve.setResult(
        createObserveResult(
          createHierarchyWithElement({
            "resource-id": "field",
            text: "",
            class: "android.widget.EditText",
          }),
        ),
      );
      fakeFieldTypeDetector.setFieldType("field", "text");
      const error = "Unconfirmed device mutation";
      if (operation === "input") {
        fakeInput.setResult({ success: false, text: "", error, ...{ retryable: false } });
      } else {
        fakeClear.setResult({ success: false, error, ...{ retryable: false } });
      }

      const result = await createSetUIState(undefined, "ios").execute({
        fields: [{ selector: { elementId: "field" }, value: "test" }],
      });

      expect(result.success).toBe(false);
      expect(result.fields[0].attempts).toBe(1);
      expect(result.fields[0].error).toContain(error);
      expect(fakeClear.getCallCount()).toBe(1);
      expect(fakeInput.getCallCount()).toBe(operation === "input" ? 1 : 0);
    });

    test.each(["ios", "android"] as const)(
      "%s retries wording without a structured marker",
      async (platform) => {
        fakeObserve.setResult(
          createObserveResult(
            createHierarchyWithElement({
              "resource-id": "field",
              text: "",
              class: "android.widget.EditText",
            }),
          ),
        );
        fakeFieldTypeDetector.setFieldType("field", "text");
        fakeInput.setResult({ success: false, text: "", error: "Do not retry automatically." });
        const result = await createSetUIState(undefined, platform).execute({
          fields: [{ selector: { elementId: "field" }, value: "test" }],
        });
        expect(result.fields[0].attempts).toBe(3);
        expect(fakeInput.getCallCount()).toBe(3);
      },
    );

    test("retries up to maxRetries on failure", async () => {
      const hierarchy = createHierarchyWithElement({
        "resource-id": "field",
        text: "",
        class: "android.widget.EditText",
      });
      fakeObserve.setResult(createObserveResult(hierarchy));
      fakeFieldTypeDetector.setFieldType("field", "text");

      // Configure tap to fail
      fakeTap.setDefaultResult({
        success: false,
        action: "tap",
        element: { bounds: { left: 0, top: 0, right: 100, bottom: 50 } },
        error: "Element not clickable",
      });

      const setUIState = createSetUIState();
      const result = await setUIState.execute({
        fields: [{ selector: { elementId: "field" }, value: "test" }],
      });

      expect(result.success).toBe(false);
      expect(result.fields[0].attempts).toBe(3);
      expect(result.fields[0].error).toContain("Failed to tap");
    });

    test("refreshes view hierarchy between retries when element not found", async () => {
      // Element appears after first call (simulating async load)
      let observeCallCount = 0;
      fakeObserve.setResultFactory(() => {
        observeCallCount++;
        if (observeCallCount <= 1) {
          // First call: element not present
          return createObserveResult({ hierarchy: { node: [] } });
        }
        // Subsequent calls: element appears
        return createObserveResult(
          createHierarchyWithElement({
            "resource-id": "async_field",
            text: "loaded!",
            class: "android.widget.EditText",
          }),
        );
      });

      fakeFieldTypeDetector.setFieldType("async_field", "text");
      fakeFieldTypeDetector.setTextValue("async_field", "loaded!");

      const setUIState = createSetUIState();
      const result = await setUIState.execute({
        fields: [{ selector: { elementId: "async_field" }, value: "loaded!" }],
      });

      expect(result.success).toBe(true);
      expect(result.fields[0].success).toBe(true);
      // Observe should have been called multiple times to refresh hierarchy
      expect(observeCallCount).toBeGreaterThan(1);
    });
  });

  describe("fail fast", () => {
    test("marks fields after a failed input as not attempted", async () => {
      const hierarchy: ViewHierarchyResult = {
        hierarchy: {
          node: [
            {
              $: {},
              node: [1, 2, 3, 4].map((index) => ({
                $: {
                  "resource-id": `field${index}`,
                  text: "",
                  class: "android.widget.EditText",
                  bounds: { left: 0, top: index * 60, right: 100, bottom: index * 60 + 50 },
                },
              })),
            },
          ],
        },
      };
      const verifiedFirstField: ViewHierarchyResult = {
        hierarchy: {
          node: [
            {
              $: {},
              node: [1, 2, 3, 4].map((index) => ({
                $: {
                  "resource-id": `field${index}`,
                  text: index === 1 ? "first" : "",
                  class: "android.widget.EditText",
                  bounds: { left: 0, top: index * 60, right: 100, bottom: index * 60 + 50 },
                },
              })),
            },
          ],
        },
      };
      let observeCalls = 0;
      fakeObserve.setResultFactory(() => {
        observeCalls++;
        return createObserveResult(observeCalls === 1 ? hierarchy : verifiedFirstField);
      });
      for (let index = 1; index <= 4; index++) {
        fakeFieldTypeDetector.setFieldType(`field${index}`, "text");
      }
      fakeInput.setResultForText("second", { success: false, text: "", error: "Input rejected" });

      const result = await createSetUIState().execute({
        fields: [
          { selector: { elementId: "field1" }, value: "first" },
          { selector: { elementId: "field2" }, value: "second" },
          { selector: { elementId: "field3" }, value: "third" },
          { selector: { elementId: "field4" }, value: "fourth" },
        ],
      });

      expect(result.fields[0].success).toBe(true);
      expect(result.fields[0].notAttempted).toBeFalsy();
      expect(result.fields[1].success).toBe(false);
      expect(result.fields[1].notAttempted).toBeFalsy();
      expect(result.fields[1].error).toContain("Input rejected");
      for (const field of result.fields.slice(2)) {
        expect(field.notAttempted).toBe(true);
        expect(field.error).toContain("setUIState stopped after field");
        expect(field.error).not.toContain("Element not found");
      }
    });

    test("stops processing fields on first failure", async () => {
      const hierarchy = createHierarchyWithElement({
        "resource-id": "field1",
        text: "",
        class: "android.widget.EditText",
      });
      fakeObserve.setResult(createObserveResult(hierarchy));
      fakeFieldTypeDetector.setFieldType("field1", "text");

      // Configure tap to fail
      fakeTap.setDefaultResult({
        success: false,
        action: "tap",
        element: { bounds: { left: 0, top: 0, right: 100, bottom: 50 } },
        error: "Element not clickable",
      });

      const setUIState = createSetUIState();
      const result = await setUIState.execute({
        fields: [
          { selector: { elementId: "field1" }, value: "test1" },
          { selector: { elementId: "field2" }, value: "test2" },
        ],
      });

      expect(result.success).toBe(false);
      // field1 processed (failed after 3 retries)
      expect(result.fields[0].success).toBe(false);
      expect(result.fields[0].attempts).toBe(3);
      expect(result.error).toContain("Failed to tap");
    });
  });

  describe("password fields", () => {
    test("auto-detects password text fields and skips masked value verification", async () => {
      fakeObserve.setResult(
        createObserveResult(
          createHierarchyWithElement({
            "resource-id": "password",
            text: "",
            value: "••••••••",
            class: "android.widget.EditText",
            password: "true",
          }),
        ),
      );

      fakeFieldTypeDetector.setFieldType("password", "text");
      fakeFieldTypeDetector.setIsPasswordField("password", true);

      const setUIState = createSetUIState();
      const result = await setUIState.execute({
        fields: [{ selector: { elementId: "password" }, value: "secret123" }],
      });

      expect(result.success).toBe(true);
      expect(result.fields[0].attempts).toBe(1);
      expect(result.fields[0].verified).toBeUndefined();
      expect(fakeInput.getCallCount()).toBe(1);
    });
  });

  describe("multiple fields", () => {
    test("processes fields in screen order", async () => {
      const initialHierarchy: ViewHierarchyResult = {
        hierarchy: {
          node: [
            {
              $: {
                bounds: { left: 0, top: 0, right: 100, bottom: 50 },
                "resource-id": "username",
                text: "",
                class: "android.widget.EditText",
              },
            },
            {
              $: {
                bounds: { left: 0, top: 60, right: 100, bottom: 110 },
                "resource-id": "password",
                text: "",
                class: "android.widget.EditText",
                password: "true",
              },
            },
            {
              $: {
                bounds: { left: 0, top: 120, right: 100, bottom: 170 },
                "resource-id": "remember",
                class: "android.widget.CheckBox",
                checkable: "true",
                checked: "false",
              },
            },
          ],
        },
      };
      const updatedHierarchy: ViewHierarchyResult = {
        hierarchy: {
          node: [
            {
              $: {
                bounds: { left: 0, top: 0, right: 100, bottom: 50 },
                "resource-id": "username",
                text: "user@test.com",
                class: "android.widget.EditText",
              },
            },
            {
              $: {
                bounds: { left: 0, top: 60, right: 100, bottom: 110 },
                "resource-id": "password",
                text: "",
                class: "android.widget.EditText",
                password: "true",
              },
            },
            {
              $: {
                bounds: { left: 0, top: 120, right: 100, bottom: 170 },
                "resource-id": "remember",
                class: "android.widget.CheckBox",
                checkable: "true",
                checked: "true",
              },
            },
          ],
        },
      };

      let observeCallCount = 0;
      fakeObserve.setResultFactory(() => {
        observeCallCount++;
        if (observeCallCount <= 1) {
          return createObserveResult(initialHierarchy);
        }
        return createObserveResult(updatedHierarchy);
      });

      fakeFieldTypeDetector.setFieldType("username", "text");
      fakeFieldTypeDetector.setFieldType("password", "text");
      fakeFieldTypeDetector.setFieldType("remember", "checkbox");
      fakeFieldTypeDetector.setIsPasswordField("password", true);

      const setUIState = createSetUIState();
      const result = await setUIState.execute({
        fields: [
          { selector: { elementId: "username" }, value: "user@test.com" },
          { selector: { elementId: "password" }, value: "pass123" },
          { selector: { elementId: "remember" }, selected: true },
        ],
      });

      expect(result.success).toBe(true);
      expect(result.fields).toHaveLength(3);
      expect(result.fields.every((f) => f.success)).toBe(true);

      // Verify input texts were in order
      const inputCalls = fakeInput.getCalls();
      expect(inputCalls[0].text).toBe("user@test.com");
      expect(inputCalls[1].text).toBe("pass123");
    });

    test("processes fields in screen order regardless of provided order", async () => {
      const initialHierarchy: ViewHierarchyResult = {
        hierarchy: {
          node: [
            {
              $: {
                bounds: { left: 0, top: 0, right: 100, bottom: 50 },
                "resource-id": "top_field",
                text: "",
                class: "android.widget.EditText",
              },
            },
            {
              $: {
                bounds: { left: 0, top: 200, right: 100, bottom: 250 },
                "resource-id": "bottom_field",
                text: "",
                class: "android.widget.EditText",
              },
            },
          ],
        },
      };
      const afterTopFieldEdit: ViewHierarchyResult = {
        hierarchy: {
          node: [
            {
              $: {
                bounds: { left: 0, top: 0, right: 100, bottom: 50 },
                "resource-id": "top_field",
                text: "first",
                class: "android.widget.EditText",
              },
            },
            {
              $: {
                bounds: { left: 0, top: 200, right: 100, bottom: 250 },
                "resource-id": "bottom_field",
                text: "",
                class: "android.widget.EditText",
              },
            },
          ],
        },
      };
      const afterBothEdits: ViewHierarchyResult = {
        hierarchy: {
          node: [
            {
              $: {
                bounds: { left: 0, top: 0, right: 100, bottom: 50 },
                "resource-id": "top_field",
                text: "first",
                class: "android.widget.EditText",
              },
            },
            {
              $: {
                bounds: { left: 0, top: 200, right: 100, bottom: 250 },
                "resource-id": "bottom_field",
                text: "second",
                class: "android.widget.EditText",
              },
            },
          ],
        },
      };

      let observeCallCount = 0;
      fakeObserve.setResultFactory(() => {
        observeCallCount++;
        if (observeCallCount <= 1) {
          return createObserveResult(initialHierarchy);
        }
        // After first edit (verification + refresh): top_field filled, bottom_field still empty
        if (observeCallCount <= 3) {
          return createObserveResult(afterTopFieldEdit);
        }
        // After second edit
        return createObserveResult(afterBothEdits);
      });

      fakeFieldTypeDetector.setFieldType("top_field", "text");
      fakeFieldTypeDetector.setFieldType("bottom_field", "text");

      const setUIState = createSetUIState();
      const result = await setUIState.execute({
        fields: [
          // Provided in reverse screen order
          { selector: { elementId: "bottom_field" }, value: "second" },
          { selector: { elementId: "top_field" }, value: "first" },
        ],
      });

      expect(result.success).toBe(true);
      expect(result.fields).toHaveLength(2);

      // Even though bottom_field was listed first, top_field (bounds.top=0) should be filled first
      const inputCalls = fakeInput.getCalls();
      expect(inputCalls[0].text).toBe("first"); // top_field processed first
      expect(inputCalls[1].text).toBe("second"); // bottom_field processed second
    });
  });

  describe("text selector", () => {
    test("verifies text fields selected by a stable text label", async () => {
      const initialHierarchy = createHierarchyWithElement({
        text: "Username",
        value: "",
        class: "android.widget.EditText",
      });
      const updatedHierarchy = createHierarchyWithElement({
        text: "Username",
        value: "john",
        class: "android.widget.EditText",
      });
      let observeCallCount = 0;
      fakeObserve.setResultFactory(() => {
        observeCallCount++;
        return createObserveResult(observeCallCount === 1 ? initialHierarchy : updatedHierarchy);
      });
      fakeFieldTypeDetector.setFieldType("Username", "text");

      const setUIState = createSetUIState();
      const result = await setUIState.execute({
        fields: [{ selector: { text: "Username" }, value: "john" }],
      });

      expect(result.success).toBe(true);
      expect(result.fields[0].success).toBe(true);
      expect(result.fields[0].verified).toBe(true);
    });

    test("retries once and reports the observed value when clear only removes one character", async () => {
      let currentValue = "Duo Tester";
      let focusConfirmed = false;
      const calls: string[] = [];
      const hierarchy = (): ViewHierarchyResult => ({
        hierarchy: {
          node: [
            {
              $: {
                bounds: { left: 0, top: 0, right: 100, bottom: 50 },
                text: "Name",
                value: currentValue,
                class: "UITextField",
              },
            },
          ],
        },
      });
      fakeObserve.setResultFactory(() => createObserveResult(hierarchy()));
      fakeFieldTypeDetector.setFieldType("Name", "text");

      const setUIState = new SetUIState(device, null, {
        observeScreen: fakeObserve,
        fieldTypeDetector: fakeFieldTypeDetector,
        timer: fakeTimer,
        tapOnElement: {
          execute: async (options) => {
            calls.push(`focus:${options.action}`);
            focusConfirmed = options.action === "focus";
            return { success: true, focusVerified: focusConfirmed };
          },
        },
        clearText: {
          execute: async () => {
            calls.push("clear");
            if (focusConfirmed) {
              // The clear action consistently leaves the stale prefix behind.
              currentValue = "Duo Teste";
            }
            return { success: true };
          },
        },
        inputText: {
          execute: async (text: string) => {
            calls.push("input");
            currentValue += text;
            return { success: true, text };
          },
        },
      });

      const result = await setUIState.execute({
        fields: [{ selector: { text: "Name" }, value: "Fold Test" }],
      });

      expect(result.success).toBe(false);
      expect(result.fields[0].success).toBe(false);
      expect(result.fields[0].attempts).toBe(2);
      expect(result.fields[0].error).toContain('expected "Fold Test"');
      expect(result.fields[0].error).toContain('observed "Duo TesteFold Test"');
      expect(calls).toEqual(["focus:focus", "clear", "input", "focus:focus", "clear", "input"]);
    });

    test("skips verification for an iOS text field without a value attribute", async () => {
      fakeObserve.setResult(
        createObserveResult(
          createHierarchyWithElement({
            "resource-id": "ios-email",
            text: "Email address",
            class: "UITextField",
          }),
        ),
      );
      fakeFieldTypeDetector.setFieldType("ios-email", "text");

      const setUIState = createSetUIState();
      const result = await setUIState.execute({
        fields: [{ selector: { elementId: "ios-email" }, value: "jane@example.com" }],
      });

      expect(result.success).toBe(true);
      expect(result.fields[0].success).toBe(true);
      expect(result.fields[0].attempts).toBe(1);
      expect(result.fields[0].verified).toBeUndefined();
      expect(fakeInput.getCallCount()).toBe(1);
    });

    test("succeeds as unverified when a text selector no longer finds the field", async () => {
      const initialHierarchy = createHierarchyWithElement({
        text: "Name",
        value: "",
        class: "android.widget.EditText",
      });
      let observeCallCount = 0;
      fakeObserve.setResultFactory(() => {
        observeCallCount++;
        return createObserveResult(
          observeCallCount === 1 ? initialHierarchy : { hierarchy: { node: [] } },
        );
      });
      fakeFieldTypeDetector.setFieldType("Name", "text");

      const setUIState = createSetUIState();
      const result = await setUIState.execute({
        fields: [{ selector: { text: "Name" }, value: "Jane" }],
      });

      expect(result.success).toBe(true);
      expect(result.fields[0].success).toBe(true);
      expect(result.fields[0].attempts).toBe(1);
      expect(result.fields[0].verified).toBeUndefined();
      expect(fakeInput.getCallCount()).toBe(1);
    });

    test("does not clear a text field when focus was not confirmed", async () => {
      fakeObserve.setResult(
        createObserveResult(
          createHierarchyWithElement({
            text: "Name",
            value: "Duo Tester",
            class: "UITextField",
          }),
        ),
      );
      fakeFieldTypeDetector.setFieldType("Name", "text");
      let clearCalls = 0;
      const setUIState = new SetUIState(device, null, {
        observeScreen: fakeObserve,
        fieldTypeDetector: fakeFieldTypeDetector,
        timer: fakeTimer,
        tapOnElement: { execute: async () => ({ success: true, focusVerified: false }) },
        clearText: {
          execute: async () => {
            clearCalls++;
            return { success: true };
          },
        },
        inputText: { execute: async (text: string) => ({ success: true, text }) },
      });

      const result = await setUIState.execute({
        fields: [{ selector: { text: "Name" }, value: "Fold Test" }],
      });

      expect(result.success).toBe(false);
      expect(result.fields[0].success).toBe(false);
      expect(clearCalls).toBe(0);
    });
  });

  describe("re-evaluation after layout change", () => {
    test("re-finds fields from fresh hierarchy after each edit", async () => {
      // Simulate layout reflow: after editing the first field, the second field
      // moves to a different position (e.g., keyboard appears, fields shift)
      const initialHierarchy: ViewHierarchyResult = {
        hierarchy: {
          node: [
            {
              $: {
                bounds: { left: 0, top: 100, right: 100, bottom: 150 },
                "resource-id": "field_a",
                text: "",
                class: "android.widget.EditText",
              },
            },
            {
              $: {
                bounds: { left: 0, top: 200, right: 100, bottom: 250 },
                "resource-id": "field_b",
                text: "",
                class: "android.widget.EditText",
              },
            },
          ],
        },
      };
      // After editing field_a, field_b shifts up (keyboard pushes layout)
      const afterFirstEdit: ViewHierarchyResult = {
        hierarchy: {
          node: [
            {
              $: {
                bounds: { left: 0, top: 100, right: 100, bottom: 150 },
                "resource-id": "field_a",
                text: "aaa",
                class: "android.widget.EditText",
              },
            },
            {
              $: {
                bounds: { left: 0, top: 160, right: 100, bottom: 210 },
                "resource-id": "field_b",
                text: "",
                class: "android.widget.EditText",
              },
            },
          ],
        },
      };
      const afterSecondEdit: ViewHierarchyResult = {
        hierarchy: {
          node: [
            {
              $: {
                bounds: { left: 0, top: 100, right: 100, bottom: 150 },
                "resource-id": "field_a",
                text: "aaa",
                class: "android.widget.EditText",
              },
            },
            {
              $: {
                bounds: { left: 0, top: 160, right: 100, bottom: 210 },
                "resource-id": "field_b",
                text: "bbb",
                class: "android.widget.EditText",
              },
            },
          ],
        },
      };

      let observeCallCount = 0;
      fakeObserve.setResultFactory(() => {
        observeCallCount++;
        if (observeCallCount <= 1) {
          return createObserveResult(initialHierarchy);
        }
        if (observeCallCount <= 3) {
          return createObserveResult(afterFirstEdit);
        }
        return createObserveResult(afterSecondEdit);
      });

      fakeFieldTypeDetector.setFieldType("field_a", "text");
      fakeFieldTypeDetector.setFieldType("field_b", "text");

      const setUIState = createSetUIState();
      const result = await setUIState.execute({
        fields: [
          { selector: { elementId: "field_a" }, value: "aaa" },
          { selector: { elementId: "field_b" }, value: "bbb" },
        ],
      });

      expect(result.success).toBe(true);
      expect(result.fields).toHaveLength(2);
      expect(result.fields.every((f) => f.success)).toBe(true);

      // Both fields should have been filled
      const inputCalls = fakeInput.getCalls();
      expect(inputCalls[0].text).toBe("aaa");
      expect(inputCalls[1].text).toBe("bbb");

      // Multiple observations should have occurred (re-evaluation after each edit)
      expect(observeCallCount).toBeGreaterThan(2);
    });
  });

  describe("unprocessed fields", () => {
    test("reports unprocessed fields when not found after scrolling", async () => {
      // Element never appears
      fakeObserve.setResult(createObserveResult({ hierarchy: { node: [] } }));

      const setUIState = createSetUIState();
      const result = await setUIState.execute({
        fields: [{ selector: { elementId: "nonexistent" }, value: "test" }],
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain("Fields not found after scrolling");
      expect(result.error).toContain("nonexistent");
    });
  });
});

describe("SetUIState iOS Forms nodes", () => {
  const device: BootedDevice = { name: "iPhone", platform: "ios", deviceId: "ios-sim" };

  test("sets a UITextField found by its hint-text placeholder", async () => {
    const hierarchy = structuredClone(iosFormsEmptyFields);
    for (const field of hierarchy.hierarchy.node?.node ?? []) {
      field.node = [];
    }
    const tap = new FakeTapOnElement();
    const input = new FakeInputText();
    const clear = new FakeClearText();
    const observe = new FakeObserveScreenForSetUIState();
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    observe.setResultFactory(() => ({
      updatedAt: timer.now(),
      screenSize: { width: 393, height: 852 },
      systemInsets: { top: 0, right: 0, bottom: 0, left: 0 },
      viewHierarchy: hierarchy,
    }));
    const action = new SetUIState(device, null, {
      tapOnElement: tap,
      inputText: input,
      clearText: clear,
      swipeOn: new FakeSwipeOn(),
      observeScreen: observe,
      timer,
    });

    const result = await action.execute({
      fields: [{ selector: { text: "Name" }, value: "Fold Test" }],
    });

    expect(result.fields[0]).toMatchObject({ success: true, fieldType: "text" });
    expect(tap.getCalls()[0].options).toMatchObject({ elementId: "name-field", action: "focus" });
    expect(clear.getCallCount()).toBe(1);
    expect(input.getCalls()[0].text).toBe("Fold Test");
  });

  test("reads the control's checked state and taps to set it false", async () => {
    const tap = new FakeTapOnElement();
    let tappedBounds: Element["bounds"] | undefined;
    let tapPoint: { x: number; y: number } | undefined;
    const tapOnElement = {
      execute: async (...args: Parameters<FakeTapOnElement["execute"]>) => {
        const [options] = args;
        const selected = new ResolverElementSelector().selectByText(
          iosFormsSwitch("true"),
          options.text!,
          { intentAction: "tap" },
        );
        tappedBounds = selected.element?.bounds;
        if (tappedBounds) {
          tapPoint = {
            x: (tappedBounds.left + tappedBounds.right) / 2,
            y: (tappedBounds.top + tappedBounds.bottom) / 2,
          };
        }
        return tap.execute(...args);
      },
    };
    const observe = new FakeObserveScreenForSetUIState();
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    observe.setResultFactory(() => ({
      updatedAt: timer.now(),
      screenSize: { width: 402, height: 874 },
      systemInsets: { top: 0, right: 0, bottom: 0, left: 0 },
      viewHierarchy: iosFormsSwitch(tap.getCallCount() === 0 ? "true" : "false"),
    }));
    const action = new SetUIState(device, null, {
      tapOnElement,
      inputText: new FakeInputText(),
      clearText: new FakeClearText(),
      swipeOn: new FakeSwipeOn(),
      observeScreen: observe,
      timer,
    });

    const result = await action.execute({
      fields: [{ selector: { text: "Enable Notifications" }, selected: false }],
    });

    expect(result.fields[0]).toMatchObject({ success: true, verified: true, fieldType: "toggle" });
    expect(tap.getCalls().map((call) => call.options)).toEqual([
      { text: "Enable Notifications", action: "tap" },
    ]);
    expect(tappedBounds).toEqual({ left: 301, top: 296, right: 364, bottom: 324 });
    expect(tapPoint?.x).toBeGreaterThanOrEqual(301);
    expect(tapPoint?.x).toBeLessThan(364);
    expect(tapPoint?.y).toBeGreaterThanOrEqual(296);
    expect(tapPoint?.y).toBeLessThan(324);
  });
});

describe("SetUIState search budget and unclassifiable fields (#4242)", () => {
  const device: BootedDevice = { name: "test-device", platform: "android", deviceId: "device-1" };

  let fakeTap: FakeTapOnElement;
  let fakeInput: FakeInputText;
  let fakeClear: FakeClearText;
  let fakeSwipe: FakeSwipeOn;
  let fakeObserve: FakeObserveScreenForSetUIState;
  let fakeFieldTypeDetector: FakeFieldTypeDetector;
  let fakeTimer: FakeTimer;

  beforeEach(() => {
    fakeTap = new FakeTapOnElement();
    fakeInput = new FakeInputText();
    fakeClear = new FakeClearText();
    fakeSwipe = new FakeSwipeOn();
    fakeObserve = new FakeObserveScreenForSetUIState();
    fakeFieldTypeDetector = new FakeFieldTypeDetector();
    fakeTimer = new FakeTimer();
  });

  const build = () =>
    new SetUIState(device, null, {
      tapOnElement: fakeTap,
      inputText: {
        execute: async (text: string, imeAction?: string) => {
          const result = await fakeInput.execute(text, imeAction);
          const calls = fakeTap.getCalls();
          const target = calls[calls.length - 1]?.options;
          const key = target?.elementId ?? target?.text;
          if (key && result.success) {
            fakeFieldTypeDetector.setTextValue(key, text);
          }
          return result;
        },
      },
      clearText: fakeClear,
      swipeOn: fakeSwipe,
      observeScreen: fakeObserve,
      fieldTypeDetector: fakeFieldTypeDetector,
      timer: fakeTimer,
    });

  test("an unmatched selector returns the tool's own error rather than searching forever", async () => {
    // The screen never contains the field, so the scroll search exhausts both
    // directions. The caller must get "Fields not found", not a transport timeout.
    const result = await build().execute({
      fields: [{ selector: { text: "NeverPresent" }, value: "x" }],
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("not found");
    expect(result.error).toContain("NeverPresent");
  });

  test("the search is bounded — it does not scroll indefinitely", async () => {
    await build().execute({
      fields: [{ selector: { text: "NeverPresent" }, value: "x" }],
    });

    // Both directions tried, then it stops. Without a bound this would not settle.
    expect(fakeSwipe.getCallCount()).toBeGreaterThan(0);
    expect(fakeSwipe.getCallCount()).toBeLessThanOrEqual(10);
  });

  test("the search stops once its time budget is spent, before the request times out", async () => {
    // Each observe costs real wall-clock on a device (~3s of swipe + observe per
    // futile scroll). Fakes are instant, so the cost is simulated here: without a
    // deadline the loop only stops after exhausting both directions, which is
    // what pushed a real call past the caller's request timeout (#4242).
    let observeCalls = 0;
    fakeObserve.setResultFactory(() => {
      observeCalls++;
      fakeTimer.advanceTime(5_000);
      return {
        updatedAt: fakeTimer.now(),
        screenSize: { width: 1080, height: 1920 },
        systemInsets: { top: 0, right: 0, bottom: 0, left: 0 },
      };
    });

    const result = await build().execute({
      fields: [{ selector: { text: "NeverPresent" }, value: "x" }],
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("not found");
    // The budget must cut the search short rather than running every futile scroll.
    expect(observeCalls).toBeLessThan(8);
  });

  test("a matched but unclassifiable node reports what it matched, not 'unknown'", async () => {
    const hierarchy: ViewHierarchyResult = {
      hierarchy: {
        node: [
          {
            $: { bounds: { left: 0, top: 0, right: 100, bottom: 50 }, text: "Email" },
          },
        ],
      },
    } as ViewHierarchyResult;
    fakeObserve.setResult({
      updatedAt: Date.now(),
      screenSize: { width: 1080, height: 1920 },
      systemInsets: { top: 0, right: 0, bottom: 0, left: 0 },
      viewHierarchy: hierarchy,
    });
    fakeFieldTypeDetector.setFieldType("Email", "unknown" as any);

    const result = await build().execute({
      fields: [{ selector: { text: "Email" }, value: "a@b.c" }],
    });

    expect(result.success).toBe(false);
    expect(result.error).not.toBe("Unknown field type: unknown");
    expect(result.error).toContain("Email");
  });

  test("an unclassifiable node is not retried", async () => {
    const hierarchy: ViewHierarchyResult = {
      hierarchy: {
        node: [
          {
            $: { bounds: { left: 0, top: 0, right: 100, bottom: 50 }, text: "Email" },
          },
        ],
      },
    } as ViewHierarchyResult;
    fakeObserve.setResult({
      updatedAt: Date.now(),
      screenSize: { width: 1080, height: 1920 },
      systemInsets: { top: 0, right: 0, bottom: 0, left: 0 },
      viewHierarchy: hierarchy,
    });
    fakeFieldTypeDetector.setFieldType("Email", "unknown" as any);

    const result = await build().execute({
      fields: [{ selector: { text: "Email" }, value: "a@b.c" }],
    });

    expect(result.totalAttempts).toBeLessThanOrEqual(1);
  });
});

describe("SetUIState budget bounds searching, not successful work (#4252 review)", () => {
  const device: BootedDevice = { name: "test-device", platform: "android", deviceId: "device-1" };

  let fakeTap: FakeTapOnElement;
  let fakeInput: FakeInputText;
  let fakeClear: FakeClearText;
  let fakeSwipe: FakeSwipeOn;
  let fakeObserve: FakeObserveScreenForSetUIState;
  let fakeFieldTypeDetector: FakeFieldTypeDetector;
  let fakeTimer: FakeTimer;

  beforeEach(() => {
    fakeTap = new FakeTapOnElement();
    fakeInput = new FakeInputText();
    fakeClear = new FakeClearText();
    fakeSwipe = new FakeSwipeOn();
    fakeObserve = new FakeObserveScreenForSetUIState();
    fakeFieldTypeDetector = new FakeFieldTypeDetector();
    fakeTimer = new FakeTimer();
  });

  const build = () =>
    new SetUIState(device, null, {
      tapOnElement: fakeTap,
      inputText: {
        execute: async (text: string, imeAction?: string) => {
          const result = await fakeInput.execute(text, imeAction);
          const calls = fakeTap.getCalls();
          const target = calls[calls.length - 1]?.options;
          const key = target?.elementId ?? target?.text;
          if (key && result.success) {
            fakeFieldTypeDetector.setTextValue(key, text);
          }
          return result;
        },
      },
      clearText: fakeClear,
      swipeOn: fakeSwipe,
      observeScreen: fakeObserve,
      fieldTypeDetector: fakeFieldTypeDetector,
      timer: fakeTimer,
    });

  test("a visible field is still set even after earlier fields consumed the budget", async () => {
    // Both fields are on screen the whole time. Setting the first is slow, which
    // must not make the second -- still visible -- be reported as not found.
    const twoFields = {
      hierarchy: {
        node: [
          {
            $: {
              bounds: { left: 0, top: 0, right: 100, bottom: 50 },
              "resource-id": "first",
              class: "android.widget.EditText",
            },
          },
          {
            $: {
              bounds: { left: 0, top: 60, right: 100, bottom: 110 },
              "resource-id": "second",
              class: "android.widget.EditText",
            },
          },
        ],
      },
    } as unknown as ViewHierarchyResult;

    // Verification would need the fake hierarchy to echo the typed value; that is
    // orthogonal to what this test pins, so skip it for both fields.
    fakeFieldTypeDetector.setSkipVerification("first", true);
    fakeFieldTypeDetector.setSkipVerification("second", true);

    fakeObserve.setResultFactory(() => {
      fakeTimer.advanceTime(9_000);
      return {
        updatedAt: fakeTimer.now(),
        screenSize: { width: 1080, height: 1920 },
        systemInsets: { top: 0, right: 0, bottom: 0, left: 0 },
        viewHierarchy: twoFields,
      };
    });

    const result = await build().execute({
      fields: [
        { selector: { elementId: "first" }, value: "a" },
        { selector: { elementId: "second" }, value: "b" },
      ],
    });

    expect(result.error ?? "").not.toContain("not found");
    expect(result.success).toBe(true);
  });
});

describe("SetUIState progress reporting and observe reuse (#6222)", () => {
  const device: BootedDevice = { name: "test-device", platform: "android", deviceId: "device-1" };

  let fakeTap: FakeTapOnElement;
  let fakeInput: FakeInputText;
  let fakeClear: FakeClearText;
  let fakeSwipe: FakeSwipeOn;
  let fakeObserve: FakeObserveScreenForSetUIState;
  let fakeFieldTypeDetector: FakeFieldTypeDetector;
  let fakeTimer: FakeTimer;

  beforeEach(() => {
    fakeTap = new FakeTapOnElement();
    fakeInput = new FakeInputText();
    fakeClear = new FakeClearText();
    fakeSwipe = new FakeSwipeOn();
    fakeObserve = new FakeObserveScreenForSetUIState();
    fakeFieldTypeDetector = new FakeFieldTypeDetector();
    fakeTimer = new FakeTimer();
    fakeTimer.enableAutoAdvance();
  });

  const build = () =>
    new SetUIState(device, null, {
      tapOnElement: fakeTap,
      inputText: {
        execute: async (text: string, imeAction?: string) => {
          const result = await fakeInput.execute(text, imeAction);
          const calls = fakeTap.getCalls();
          const target = calls[calls.length - 1]?.options;
          const key = target?.elementId ?? target?.text;
          if (key) {
            fakeFieldTypeDetector.setTextValue(key, text);
          }
          return result;
        },
      },
      clearText: fakeClear,
      swipeOn: fakeSwipe,
      observeScreen: fakeObserve,
      fieldTypeDetector: fakeFieldTypeDetector,
      timer: fakeTimer,
    });

  const threeFieldHierarchy = (values: [string, string, string]): ViewHierarchyResult => ({
    hierarchy: {
      node: [
        {
          $: {
            bounds: { left: 0, top: 0, right: 100, bottom: 50 },
            "resource-id": "first",
            text: values[0],
            class: "android.widget.EditText",
          },
        },
        {
          $: {
            bounds: { left: 0, top: 60, right: 100, bottom: 110 },
            "resource-id": "second",
            text: values[1],
            class: "android.widget.EditText",
          },
        },
        {
          $: {
            bounds: { left: 0, top: 120, right: 100, bottom: 170 },
            "resource-id": "third",
            text: values[2],
            class: "android.widget.EditText",
          },
        },
      ],
    },
  });

  test("reports strictly increasing progress as a multi-field call advances", async () => {
    // No textValue overrides: the real FieldTypeDetector.getTextValue reads
    // whichever hierarchy findElement actually resolved against, so each
    // field's own isFieldAlreadyCorrect check genuinely fails on the
    // not-yet-edited value and the real apply+verify path runs for all
    // three fields -- exercising FakeTapOnElement/FakeClearText's own
    // 0,10 / 0,10 child-progress pattern (not just the boundary ticks).
    let observeCallCount = 0;
    const targets: [string, string, string] = ["a", "b", "c"];
    fakeObserve.setResultFactory(() => {
      observeCallCount++;
      // Exactly one observe happens per successfully-verified field after the
      // initial one (the verify observe is reused as the post-success
      // refresh), so call N reflects the first (N-1) fields already landed.
      const doneCount = Math.min(3, observeCallCount - 1);
      const values: [string, string, string] = ["", "", ""];
      for (let i = 0; i < doneCount; i++) {
        values[i] = targets[i];
      }
      return createObserveResultFor(threeFieldHierarchy(values));
    });
    fakeFieldTypeDetector.setFieldType("first", "text");
    fakeFieldTypeDetector.setFieldType("second", "text");
    fakeFieldTypeDetector.setFieldType("third", "text");

    const progressCalls: Array<{ progress: number; total?: number; message?: string }> = [];
    const progress = async (progressValue: number, total?: number, message?: string) => {
      progressCalls.push({ progress: progressValue, total, message });
    };

    const result = await build().execute(
      {
        fields: [
          { selector: { elementId: "first" }, value: "a" },
          { selector: { elementId: "second" }, value: "b" },
          { selector: { elementId: "third" }, value: "c" },
        ],
      },
      progress,
    );

    expect(result.success).toBe(true);
    // Each field's tap AND clear child steps report the same local 0,10
    // pattern. Ties are suppressed rather than bumped (so a repeat can never
    // be pushed into the reserved boundary endpoint or the next field's
    // slice) -- so only the first genuinely-advancing child tick per field
    // (tap's "10") survives, plus that field's boundary tick: 2 per field.
    expect(progressCalls.length).toBe(6);
    // Every notification shares ONE consistent total across the whole call
    // (fieldCount * 100) -- not the per-field child steps' own local total,
    // and not a bare field-count total that would collide with those.
    expect(progressCalls.every((c) => c.total === 300)).toBe(true);
    // The whole sequence -- tap's 0,10, then clear's own 0,10 reset, repeated
    // per field, plus the per-field boundary ticks -- must be STRICTLY
    // increasing. MCP clients that enforce monotonicity reject or ignore a
    // repeated value, not just a decrease, so a tie is as unacceptable as a
    // regression here.
    for (let i = 1; i < progressCalls.length; i++) {
      expect(progressCalls[i].progress).toBeGreaterThan(progressCalls[i - 1].progress);
    }
    // Never exceeds the declared total.
    expect(progressCalls.every((c) => c.progress <= 300)).toBe(true);
    // The three field-boundary ticks land at the top of each field's slice.
    expect(progressCalls.map((c) => c.progress)).toEqual(
      expect.arrayContaining([100, 200, 300]) as unknown as number[],
    );
    expect(progressCalls[progressCalls.length - 1].message).toContain("3/3");
  });

  test("reserves the field-slice endpoint for the boundary tick when a child reports its own 100%", async () => {
    // A child step can legitimately report (100, 100) -- its own completion.
    // That must be capped strictly below this field's slice endpoint (not
    // mapped onto it), so it can never tie or collide with the boundary tick
    // that follows, and never gets bumped across into the next field's slice.
    const twoCheckboxes: ViewHierarchyResult = {
      hierarchy: {
        node: [
          {
            $: {
              bounds: { left: 0, top: 0, right: 100, bottom: 50 },
              "resource-id": "first",
              class: "android.widget.CheckBox",
              checkable: "true" as any,
              checked: "false" as any,
            },
          },
          {
            $: {
              bounds: { left: 0, top: 60, right: 100, bottom: 110 },
              "resource-id": "second",
              class: "android.widget.CheckBox",
              checkable: "true" as any,
              checked: "false" as any,
            },
          },
        ],
      },
    };
    fakeObserve.setResult(createObserveResultFor(twoCheckboxes));
    fakeFieldTypeDetector.setFieldType("first", "checkbox");
    fakeFieldTypeDetector.setFieldType("second", "checkbox");
    fakeFieldTypeDetector.setSkipVerification("first", true);
    fakeFieldTypeDetector.setSkipVerification("second", true);

    // A tap fake whose "first" field reports its own 100% completion; its
    // "second" field uses the ordinary 0,10 pattern real tools use.
    const tapReportingFullCompletion = {
      calls: [] as Array<{ elementId?: string }>,
      async execute(
        options: { elementId?: string },
        childProgress?: (p: number, t?: number, m?: string) => Promise<void>,
      ) {
        this.calls.push({ elementId: options.elementId });
        if (options.elementId === "first") {
          await childProgress?.(0, 100, "start");
          await childProgress?.(100, 100, "done");
        } else {
          await childProgress?.(0, 100, "Preparing to execute action...");
          await childProgress?.(10, 100, "Getting previous view hierarchy...");
        }
        return {
          success: true,
          focusVerified: true,
          action: "tap",
          element: { bounds: { left: 0, top: 0, right: 100, bottom: 50 } },
        };
      },
    };

    const progressCalls: Array<{ progress: number; message?: string }> = [];
    const progress = async (progressValue: number, _total?: number, message?: string) => {
      progressCalls.push({ progress: progressValue, message });
    };

    const setUIState = new SetUIState(device, null, {
      tapOnElement: tapReportingFullCompletion as any,
      inputText: {
        execute: async (text: string, imeAction?: string) => {
          const result = await fakeInput.execute(text, imeAction);
          const calls = fakeTap.getCalls();
          const target = calls[calls.length - 1]?.options;
          const key = target?.elementId ?? target?.text;
          if (key && result.success) {
            fakeFieldTypeDetector.setTextValue(key, text);
          }
          return result;
        },
      },
      clearText: fakeClear,
      swipeOn: fakeSwipe,
      observeScreen: fakeObserve,
      fieldTypeDetector: fakeFieldTypeDetector,
      timer: fakeTimer,
    });

    const result = await setUIState.execute(
      {
        fields: [
          { selector: { elementId: "first" }, selected: true },
          { selector: { elementId: "second" }, selected: true },
        ],
      },
      progress,
    );

    expect(result.success).toBe(true);
    // Strictly increasing throughout, including across the field boundary.
    for (let i = 1; i < progressCalls.length; i++) {
      expect(progressCalls[i].progress).toBeGreaterThan(progressCalls[i - 1].progress);
    }
    // Identify the two field-boundary ticks by their message (only
    // execute()'s own per-field boundary emission uses this wording; the
    // child fake's messages are "start"/"done"/"Preparing..."/"Getting...").
    // The boundary ticks must land EXACTLY at each field's slice endpoint --
    // not endpoint+1, which is what a bump-on-tie (instead of reservation)
    // would produce here, since field 1's own child already reports 100%.
    const boundaryIndices = progressCalls
      .map((c, i) => ({ c, i }))
      .filter(({ c }) => c.message?.includes("Set field"))
      .map(({ i }) => i);
    expect(boundaryIndices.length).toBe(2);
    expect(progressCalls[boundaryIndices[0]].progress).toBe(100);
    expect(progressCalls[boundaryIndices[1]].progress).toBe(200);
    // Field 1's child ticks (everything before its boundary tick) all stay
    // STRICTLY below 100 -- the (100, 100) report must not have been mapped
    // onto the reserved endpoint.
    const field1ChildTicks = progressCalls.slice(0, boundaryIndices[0]);
    expect(field1ChildTicks.length).toBeGreaterThan(0);
    expect(field1ChildTicks.every((c) => c.progress < 100)).toBe(true);
    // Field 2's child ticks (between the two boundary ticks) stay within its
    // own [100, 200) band.
    const field2ChildTicks = progressCalls.slice(boundaryIndices[0] + 1, boundaryIndices[1]);
    expect(field2ChildTicks.every((c) => c.progress > 100 && c.progress < 200)).toBe(true);
    // No two emissions share the same value (no duplicate at the endpoint).
    const values = progressCalls.map((c) => c.progress);
    expect(new Set(values).size).toBe(values.length);
    // Never exceeds the declared total (fieldCount * 100 = 200).
    expect(progressCalls.every((c) => c.progress <= 200)).toBe(true);
  });

  test("reports progress up to the point of a mid-loop failure, not silence", async () => {
    fakeObserve.setResult(createObserveResultFor(threeFieldHierarchy(["", "", ""])));
    fakeFieldTypeDetector.setFieldType("first", "text");
    fakeFieldTypeDetector.setFieldType("second", "text");
    fakeFieldTypeDetector.setSkipVerification("first", true);

    // Second field's tap fails every attempt.
    fakeTap.setResult("second", {
      success: false,
      action: "tap",
      element: { bounds: { left: 0, top: 60, right: 100, bottom: 110 } },
      error: "Element not clickable",
    });

    const progressCalls: Array<{ progress: number; message?: string }> = [];
    const progress = async (progressValue: number, _total?: number, message?: string) => {
      progressCalls.push({ progress: progressValue, message });
    };

    const result = await build().execute(
      {
        fields: [
          { selector: { elementId: "first" }, value: "a" },
          { selector: { elementId: "second" }, value: "b" },
        ],
      },
      progress,
    );

    expect(result.success).toBe(false);
    // A client watching progress must see field 1 succeed before field 2 fails
    // -- it must not look like nothing happened. Field 1's tap/clear child
    // steps and field 2's three failed-tap retries all report their own
    // progress too, so isolate the two per-field boundary ticks by message.
    const boundaryTicks = progressCalls.filter(
      (c) => c.message?.includes("Set field") || c.message?.includes("Failed field"),
    );
    expect(boundaryTicks.length).toBe(2);
    expect(boundaryTicks[0].message).toContain("Set field");
    expect(boundaryTicks[1].message).toContain("Failed field");
    // The whole trace -- child ticks from both fields' retries included --
    // must be STRICTLY increasing, even though field 2's tap fails and
    // retries three times inside the same 100-wide slice (each retry's tap
    // re-emits the same local 0,10 pattern, which would otherwise tie).
    for (let i = 1; i < progressCalls.length; i++) {
      expect(progressCalls[i].progress).toBeGreaterThan(progressCalls[i - 1].progress);
    }
  });

  test("does not re-observe after a verified success -- reuses verification's own observation", async () => {
    // Single field, starting value differs from the target so the apply+verify
    // path actually runs (isFieldAlreadyCorrect must be false, or verification
    // -- and this whole test -- never happens). No textValue override is set:
    // the real FieldTypeDetector.getTextValue reads the element's own `text`
    // straight off whichever hierarchy findElement resolved against, so the
    // pre-edit observe genuinely reports "" and the post-edit one genuinely
    // reports "a".
    //
    // Only two observes should occur total: the initial observe, and the one
    // verifyFieldValue performs. Without the fix, a third, separate "refresh"
    // observe follows verification's -- this test fails against that
    // (pre-fix) behavior with callCount === 3 and passes at 2.
    let observeCallCount = 0;
    fakeObserve.setResultFactory(() => {
      observeCallCount++;
      const value = observeCallCount === 1 ? "" : "a";
      return createObserveResultFor(threeFieldHierarchy([value, "", ""]));
    });
    fakeFieldTypeDetector.setFieldType("first", "text");

    const result = await build().execute({
      fields: [{ selector: { elementId: "first" }, value: "a" }],
    });

    expect(result.success).toBe(true);
    expect(result.fields[0].verified).toBe(true);
    expect(result.fields[0].skipped).toBeUndefined();
    expect(fakeObserve.getCallCount()).toBe(2);
  });

  function createObserveResultFor(hierarchy: ViewHierarchyResult): ObserveResult {
    return {
      updatedAt: fakeTimer.now(),
      screenSize: { width: 1080, height: 1920 },
      systemInsets: { top: 0, right: 0, bottom: 0, left: 0 },
      viewHierarchy: hierarchy,
    };
  }
});

describe("SetUIState budget is unaffected by slow work before the search (#4252 review 2)", () => {
  const device: BootedDevice = { name: "test-device", platform: "android", deviceId: "device-1" };
  let fakeTap: FakeTapOnElement;
  let fakeInput: FakeInputText;
  let fakeClear: FakeClearText;
  let fakeSwipe: FakeSwipeOn;
  let fakeObserve: FakeObserveScreenForSetUIState;
  let fakeFieldTypeDetector: FakeFieldTypeDetector;
  let fakeTimer: FakeTimer;

  beforeEach(() => {
    fakeTap = new FakeTapOnElement();
    fakeInput = new FakeInputText();
    fakeClear = new FakeClearText();
    fakeSwipe = new FakeSwipeOn();
    fakeObserve = new FakeObserveScreenForSetUIState();
    fakeFieldTypeDetector = new FakeFieldTypeDetector();
    fakeTimer = new FakeTimer();
  });

  const build = () =>
    new SetUIState(device, null, {
      tapOnElement: fakeTap,
      inputText: {
        execute: async (text: string, imeAction?: string) => {
          const result = await fakeInput.execute(text, imeAction);
          const calls = fakeTap.getCalls();
          const target = calls[calls.length - 1]?.options;
          const key = target?.elementId ?? target?.text;
          if (key) {
            fakeFieldTypeDetector.setTextValue(key, text);
          }
          return result;
        },
      },
      clearText: fakeClear,
      swipeOn: fakeSwipe,
      observeScreen: fakeObserve,
      fieldTypeDetector: fakeFieldTypeDetector,
      timer: fakeTimer,
    });

  test("an off-screen field still gets scroll attempts after a slow post-success observe", async () => {
    // First field is visible and succeeds; the refresh observe that follows is
    // slow. The second field is off-screen, so the search must still be given its
    // full budget rather than inheriting time already spent.
    const onlyFirst = {
      hierarchy: {
        node: [
          {
            $: {
              bounds: { left: 0, top: 0, right: 100, bottom: 50 },
              "resource-id": "first",
              class: "android.widget.EditText",
            },
          },
        ],
      },
    } as unknown as ViewHierarchyResult;

    fakeFieldTypeDetector.setSkipVerification("first", true);

    let observeCalls = 0;
    fakeObserve.setResultFactory(() => {
      observeCalls++;
      // Only the post-success refresh observe (the 2nd call) needs to EXCEED
      // the 20s search budget to regression-proof #4252 — at 19s the old
      // rolling deadline, re-armed to now+20s just before this observe,
      // still had a second left, so a scroll attempt happened either way and
      // the test could not fail. The initial pre-loop observe stays cheap so
      // the total stays comfortably under the whole-call
      // RESULT_DEADLINE_BUDGET_MS safety net added for issue #6222's
      // reopen — that budget is a different, larger concern this test does
      // not exercise.
      fakeTimer.advanceTime(observeCalls === 1 ? 1_000 : 25_000);
      return {
        updatedAt: fakeTimer.now(),
        screenSize: { width: 1080, height: 1920 },
        systemInsets: { top: 0, right: 0, bottom: 0, left: 0 },
        viewHierarchy: onlyFirst,
      };
    });

    await build().execute({
      fields: [
        { selector: { elementId: "first" }, value: "a" },
        { selector: { elementId: "offscreen" }, value: "b" },
      ],
    });

    // The off-screen field must have been searched for, not skipped because
    // earlier work had already aged the deadline.
    expect(fakeSwipe.getCallCount()).toBeGreaterThan(0);
  });
});

describe("SetUIState whole-call result deadline (issue #6222 reopen)", () => {
  const device: BootedDevice = { name: "test-device", platform: "android", deviceId: "device-1" };
  let fakeSwipe: FakeSwipeOn;
  let fakeObserve: FakeObserveScreenForSetUIState;
  let fakeFieldTypeDetector: FakeFieldTypeDetector;
  let fakeTimer: FakeTimer;

  beforeEach(() => {
    fakeSwipe = new FakeSwipeOn();
    fakeObserve = new FakeObserveScreenForSetUIState();
    fakeFieldTypeDetector = new FakeFieldTypeDetector();
    fakeTimer = new FakeTimer();
  });

  /** All three fields are visible on screen from the very first observation. */
  const threeFieldHierarchy: ViewHierarchyResult = {
    hierarchy: {
      node: [
        {
          $: {
            bounds: { left: 0, top: 0, right: 100, bottom: 50 },
            "resource-id": "firstName",
            class: "android.widget.EditText",
          },
        },
        {
          $: {
            bounds: { left: 0, top: 60, right: 100, bottom: 110 },
            "resource-id": "lastName",
            class: "android.widget.EditText",
          },
        },
        {
          $: {
            bounds: { left: 0, top: 120, right: 100, bottom: 170 },
            "resource-id": "phone",
            class: "android.widget.EditText",
          },
        },
      ],
    },
  } as unknown as ViewHierarchyResult;

  /**
   * A tap/clear/input trio that costs `perFieldMs` of simulated device time
   * per field, modeling the real per-field apply work (tap + clear + type)
   * that on real hardware takes several seconds each -- the same layers
   * (SetUIState's field loop) the CLI->daemon path drives in production.
   */
  function buildSlowFieldDependencies(perFieldMs: number) {
    let focusedKey: string | undefined;
    const tapOnElement = {
      execute: async (options: { text?: string; elementId?: string }) => {
        fakeTimer.advanceTime(Math.round(perFieldMs * 0.6));
        focusedKey = options.elementId ?? options.text;
        return { success: true, focusVerified: true };
      },
    };
    const clearText = {
      execute: async () => {
        fakeTimer.advanceTime(Math.round(perFieldMs * 0.2));
        return { success: true };
      },
    };
    const inputText = {
      execute: async (text: string) => {
        fakeTimer.advanceTime(Math.round(perFieldMs * 0.2));
        if (focusedKey) {
          fakeFieldTypeDetector.setTextValue(focusedKey, text);
        }
        return { success: true, text };
      },
    };
    return { tapOnElement, clearText, inputText };
  }

  const build = (perFieldMs: number) => {
    const { tapOnElement, clearText, inputText } = buildSlowFieldDependencies(perFieldMs);
    fakeFieldTypeDetector.setSkipVerification("firstName", true);
    fakeFieldTypeDetector.setSkipVerification("lastName", true);
    fakeFieldTypeDetector.setSkipVerification("phone", true);
    fakeObserve.setResult({
      updatedAt: 0,
      screenSize: { width: 1080, height: 1920 },
      systemInsets: { top: 0, right: 0, bottom: 0, left: 0 },
      viewHierarchy: threeFieldHierarchy,
    });
    return new SetUIState(device, null, {
      tapOnElement,
      clearText,
      inputText,
      swipeOn: fakeSwipe,
      observeScreen: fakeObserve,
      fieldTypeDetector: fakeFieldTypeDetector,
      timer: fakeTimer,
    });
  };

  test("reproduces the reopen: realistic per-field cost applies one field then must return a structured partial result, never nothing", async () => {
    // ~23s per field: two fields (46s) alone exceeds the whole-call budget,
    // reproducing "applies fields, then the transport would time out and
    // discard everything" from the dogfood report on a real CtrlProxy/adb
    // round trip -- except here execute() must stop itself and hand back
    // what it already did, instead of relying on the caller's transport to
    // ever return anything at all.
    //
    // The second field is admitted (field 1 finished well inside the 45s
    // budget), but its own cost (23s) does not fit in what remains of that
    // budget (22s) -- the per-field safety net (issue #6222 review,
    // coderabbit fuTtO) now cuts it off mid-flight at the 45s deadline
    // instead of letting it run to completion 1s past that deadline, which is
    // exactly the overrun this whole feature exists to prevent.
    const result = await build(23_000).execute({
      fields: [
        { selector: { elementId: "firstName" }, value: "Grace" },
        { selector: { elementId: "lastName" }, value: "Hopper" },
        { selector: { elementId: "phone" }, value: "5125550199" },
      ],
    });

    // A real result -- never a thrown timeout -- and it must not lie about
    // overall success once a field was left unattempted.
    expect(result.success).toBe(false);
    expect(result.fields).toHaveLength(3);

    const [first, last, phone] = result.fields;
    expect(first.success).toBe(true);
    expect(first.notAttempted).toBeFalsy();
    // Admitted, started, but cut off by the per-field safety net before it
    // could settle -- distinct from both "not attempted" and "attempted and
    // failed".
    expect(last.success).toBe(false);
    expect(last.notAttempted).toBeFalsy();
    expect(last.timedOut).toBe(true);

    // The third field was never reached -- marked distinctly from "attempted
    // and failed" so a client knows it is safe to retry just this one field
    // without re-sending (and duplicating) the one that already landed.
    expect(phone.success).toBe(false);
    expect(phone.notAttempted).toBe(true);
    expect(result.error).toContain("result deadline");
  });

  test("stays within the setUIState transport floor even in the worst case", async () => {
    const result = await build(23_000).execute({
      fields: [
        { selector: { elementId: "firstName" }, value: "Grace" },
        { selector: { elementId: "lastName" }, value: "Hopper" },
        { selector: { elementId: "phone" }, value: "5125550199" },
      ],
    });

    expect(result.success).toBe(false);
    // The whole call must return well inside MIN_SET_UI_STATE_MCP_TIMEOUT_MS
    // (the transport floor added alongside this fix) -- this is the property
    // that keeps a real client from ever seeing a bare -32001 after work was
    // applied, on the direct CLI->daemon path where progress relay never
    // extends anything.
    expect(fakeTimer.now()).toBeLessThan(MIN_SET_UI_STATE_MCP_TIMEOUT_MS);
  });

  test("bounds field admission by the ACTUAL transport deadline, not just the internal 45s budget (issue #6222 P1)", async () => {
    // Models the exact overshoot the P1 review flagged: a daemon-forwarded
    // call whose 60s transport budget already had queue time deducted by the
    // time it reached execute() -- represented here directly as the absolute
    // deadline `transportDeadlineMs`, since that is all `execute()` ever
    // sees. Field 1 costs 44s, landing close to that deadline with only 6s
    // of transport budget left -- far short of the reserved per-field
    // headroom -- so field 2 must NOT be admitted.
    const callStartMs = fakeTimer.now();
    const transportDeadlineMs = callStartMs + 50_000;

    const result = await build(44_000).execute(
      {
        fields: [
          { selector: { elementId: "firstName" }, value: "Grace" },
          { selector: { elementId: "lastName" }, value: "Hopper" },
          { selector: { elementId: "phone" }, value: "5125550199" },
        ],
      },
      undefined,
      undefined,
      transportDeadlineMs,
    );

    // A real, structured result -- never a bare discard.
    expect(result.success).toBe(false);
    expect(result.fields).toHaveLength(3);

    const [first, last, phone] = result.fields;
    expect(first.success).toBe(true);
    expect(first.notAttempted).toBeFalsy();
    // Neither remaining field was admitted -- there wasn't enough of the
    // ACTUAL transport budget left to safely start another.
    expect(last.notAttempted).toBe(true);
    expect(phone.notAttempted).toBe(true);

    // The structured result comes back with real time to spare before the
    // transport's own deadline -- never at or past it.
    expect(fakeTimer.now()).toBeLessThan(transportDeadlineMs);
    // And it also stays comfortably inside the setUIState transport floor,
    // measured from when this call actually started.
    expect(fakeTimer.now() - callStartMs).toBeLessThan(MIN_SET_UI_STATE_MCP_TIMEOUT_MS);
  });

  test("a fast multi-field call still returns full, unmarked results (no false positives from the new budget)", async () => {
    const result = await build(500).execute({
      fields: [
        { selector: { elementId: "firstName" }, value: "Grace" },
        { selector: { elementId: "lastName" }, value: "Hopper" },
        { selector: { elementId: "phone" }, value: "5125550199" },
      ],
    });

    expect(result.success).toBe(true);
    expect(result.fields).toHaveLength(3);
    expect(result.fields.every((f) => f.success)).toBe(true);
    expect(result.fields.every((f) => !f.notAttempted)).toBe(true);
  });

  test("single-field fast-fail is unaffected by the new budget", async () => {
    // Matches the issue's "Phone" case: an unclassifiable single field fails
    // instantly with its own diagnosis, well under any budget.
    const hierarchyWithLabel: ViewHierarchyResult = {
      hierarchy: {
        node: [
          {
            $: { bounds: { left: 0, top: 0, right: 100, bottom: 50 }, text: "Phone" },
          },
        ],
      },
    } as unknown as ViewHierarchyResult;
    fakeObserve.setResult({
      updatedAt: 0,
      screenSize: { width: 1080, height: 1920 },
      systemInsets: { top: 0, right: 0, bottom: 0, left: 0 },
      viewHierarchy: hierarchyWithLabel,
    });
    fakeFieldTypeDetector.setFieldType("Phone", "unknown" as any);

    const result = await new SetUIState(device, null, {
      tapOnElement: { execute: async () => ({ success: true }) },
      clearText: { execute: async () => ({ success: true }) },
      inputText: { execute: async (text: string) => ({ success: true, text }) },
      swipeOn: fakeSwipe,
      observeScreen: fakeObserve,
      fieldTypeDetector: fakeFieldTypeDetector,
      timer: fakeTimer,
    }).execute({
      fields: [{ selector: { text: "Phone" }, value: "5125550199" }],
    });

    expect(result.success).toBe(false);
    expect(result.fields).toHaveLength(1);
    expect(result.fields[0].notAttempted).toBeFalsy();
    expect(result.error).toContain("Phone");
    expect(fakeTimer.now()).toBeLessThan(1_000);
  });

  test("a progress-extended transport deadline (200s) is respected, NOT capped at the internal 45s budget (issue #6222 P1)", async () => {
    // Models a progress-aware caller (executePlan, or a daemon call with a
    // progressToken) whose ProgressExtendableDeadline has extended the
    // transport deadline well past the fixed internal RESULT_DEADLINE_BUDGET_MS
    // fallback -- e.g. toward the 300s ceiling. Three fields at 50s each (150s
    // total) would have been truncated at ~45s by the old `Math.min` against
    // the fixed internal budget; with a known, larger transport deadline all
    // three must be admitted and none marked `notAttempted`.
    const callStartMs = fakeTimer.now();
    const transportDeadlineMs = callStartMs + 200_000;

    const result = await build(50_000).execute(
      {
        fields: [
          { selector: { elementId: "firstName" }, value: "Grace" },
          { selector: { elementId: "lastName" }, value: "Hopper" },
          { selector: { elementId: "phone" }, value: "5125550199" },
        ],
      },
      undefined,
      undefined,
      transportDeadlineMs,
    );

    expect(result.success).toBe(true);
    expect(result.fields).toHaveLength(3);
    expect(result.fields.every((f) => f.success)).toBe(true);
    expect(result.fields.every((f) => !f.notAttempted)).toBe(true);

    // The whole call ran well past the fixed 45s internal budget (the
    // fallback used only when no transport deadline is known) -- proof the
    // extended transport deadline was actually honored rather than clamped.
    const INTERNAL_RESULT_DEADLINE_BUDGET_MS = 45_000;
    expect(fakeTimer.now() - callStartMs).toBeGreaterThan(INTERNAL_RESULT_DEADLINE_BUDGET_MS);
    // And it still lands safely under the ACTUAL (extended) transport deadline.
    expect(fakeTimer.now()).toBeLessThan(transportDeadlineMs);
  });

  test("checks the budget BEFORE the initial observation: an already-expired admission deadline returns all-notAttempted without observing (issue #6222 P1)", async () => {
    // Models queueing having already consumed more than 40s of a 60s socket
    // budget before execute() is even invoked: the transport deadline handed
    // in has only 20s left, which is entirely eaten by
    // PER_FIELD_ADMISSION_HEADROOM_MS, so there is no budget left for even one
    // field. The initial observation must never be awaited in this case -- a
    // cold/stalled observe could otherwise blow the transport deadline before
    // any field is attempted, discarding everything.
    const callStartMs = fakeTimer.now();
    const transportDeadlineMs = callStartMs + 20_000;

    // If the initial observe were ever called, this would burn 30s of
    // simulated time -- proving (via the call count and elapsed time
    // assertions below) that execute() never reached it.
    fakeObserve.setResultFactory(() => {
      fakeTimer.advanceTime(30_000);
      return {
        updatedAt: fakeTimer.now(),
        screenSize: { width: 1080, height: 1920 },
        systemInsets: { top: 0, right: 0, bottom: 0, left: 0 },
        viewHierarchy: threeFieldHierarchy,
      };
    });

    const result = await build(500).execute(
      {
        fields: [
          { selector: { elementId: "firstName" }, value: "Grace" },
          { selector: { elementId: "lastName" }, value: "Hopper" },
          { selector: { elementId: "phone" }, value: "5125550199" },
        ],
      },
      undefined,
      undefined,
      transportDeadlineMs,
    );

    expect(result.success).toBe(false);
    expect(result.totalAttempts).toBe(0);
    expect(result.fields).toHaveLength(3);
    expect(result.fields.every((f) => f.notAttempted)).toBe(true);
    expect(result.fields.every((f) => !f.success)).toBe(true);
    expect(result.error).toContain("before the initial observation");

    // The initial observe was never awaited -- no simulated time was burned
    // and the fake was never invoked.
    expect(fakeObserve.getCallCount()).toBe(0);
    expect(fakeTimer.now()).toBe(callStartMs);
  });

  test("reads the LIVE (progress-extended) transport deadline via getLiveTransportDeadlineMs, not the frozen snapshot (issue #6222 P1 reopen, fuQ88 review)", async () => {
    // A daemon call with a progress token keeps pushing its REAL transport
    // deadline forward via `ProgressExtendableDeadline` as THIS call emits
    // its own per-field progress notifications -- but the frozen
    // `transportDeadlineMs` snapshot captured before `execute()` even started
    // can never reflect that extension. `getLiveTransportDeadlineMs` models
    // the caller (`setUIStateHandler`) reading that live object's CURRENT
    // value at every check instead.
    const callStartMs = fakeTimer.now();
    const frozenTransportDeadlineMs = callStartMs + 50_000;
    const liveTransportDeadlineMs = callStartMs + 300_000;

    const result = await build(44_000).execute(
      {
        fields: [
          { selector: { elementId: "firstName" }, value: "Grace" },
          { selector: { elementId: "lastName" }, value: "Hopper" },
          { selector: { elementId: "phone" }, value: "5125550199" },
        ],
      },
      undefined,
      undefined,
      frozenTransportDeadlineMs,
      () => liveTransportDeadlineMs,
    );

    // All three fields admitted and completed -- the frozen 50s snapshot
    // alone would only have admitted the first (as the dedicated "ACTUAL
    // transport deadline" test above proves).
    expect(result.success).toBe(true);
    expect(result.fields).toHaveLength(3);
    expect(result.fields.every((f) => f.success)).toBe(true);
    expect(result.fields.every((f) => !f.notAttempted)).toBe(true);
    expect(result.fields.every((f) => !f.timedOut)).toBe(true);

    // Proof the LIVE value won, not the smaller frozen snapshot.
    expect(fakeTimer.now() - callStartMs).toBeGreaterThan(50_000);
    expect(fakeTimer.now()).toBeLessThan(liveTransportDeadlineMs);
  });

  test("a single admitted field that stalls past its budget returns a structured partial result before the transport deadline, never a bare discard (issue #6222 review, coderabbit fuTtO)", async () => {
    // Models a field that is correctly ADMITTED (plenty of budget at the
    // time) but then stalls indefinitely mid-flight -- e.g. a UI mutation
    // that never settles. `ClearTextLike`/`InputTextLike` cannot currently be
    // cancelled, so without the per-field safety net this would block
    // `execute()` past the transport deadline and rediscover the exact
    // silent-discard this whole feature exists to prevent.
    const callStartMs = fakeTimer.now();
    const transportDeadlineMs = callStartMs + 60_000;

    let tapCalls = 0;
    const stallingDependencies = {
      tapOnElement: {
        execute: async () => {
          tapCalls++;
          // Never resolves -- the only way this field's own promise can ever
          // settle from here is if the abandoned call happens to finish in
          // the background sometime after the race has already timed out.
          return new Promise<{ success: boolean }>(() => {});
        },
      },
      clearText: { execute: async () => ({ success: true }) },
      inputText: { execute: async (text: string) => ({ success: true, text }) },
    };

    fakeFieldTypeDetector.setSkipVerification("firstName", true);
    fakeObserve.setResult({
      updatedAt: 0,
      screenSize: { width: 1080, height: 1920 },
      systemInsets: { top: 0, right: 0, bottom: 0, left: 0 },
      viewHierarchy: threeFieldHierarchy,
    });

    const setUIState = new SetUIState(device, null, {
      ...stallingDependencies,
      swipeOn: fakeSwipe,
      observeScreen: fakeObserve,
      fieldTypeDetector: fakeFieldTypeDetector,
      timer: fakeTimer,
    });

    const resultPromise = setUIState.execute(
      { fields: [{ selector: { elementId: "firstName" }, value: "Grace" }] },
      undefined,
      undefined,
      transportDeadlineMs,
    );

    // Flush microtasks until the field's own admission/tap path has run and
    // its race's timeout is armed against `fakeTimer` -- `advanceTime()`
    // before that point would have nothing due to fire. Waiting on `tapCalls`
    // rather than merely "a pending timeout exists" matters now that the
    // initial observation is ALSO raced (issue #6222 P1, fujun): that race
    // arms (and quickly clears) its own timeout first, so a bare
    // `pendingTimeoutCount() > 0` check could observe that earlier timer
    // instead of the field's.
    for (let i = 0; i < 50 && tapCalls === 0; i++) {
      await Promise.resolve();
    }
    expect(tapCalls).toBe(1);
    expect(fakeTimer.getPendingTimeoutCount()).toBeGreaterThan(0);

    // Advance past the field's entire budget (the full transport deadline
    // minus RESPONSE_HEADROOM_MS, per issue #6222 P1 -- headroom only bounds
    // admission of the NEXT field, not this one's own hard deadline, but the
    // race must still finish strictly before the outer transport abort).
    fakeTimer.advanceTime(60_000);
    const result = await resultPromise;

    expect(result.success).toBe(false);
    expect(result.fields).toHaveLength(1);
    expect(result.fields[0].success).toBe(false);
    expect(result.fields[0].timedOut).toBe(true);
    expect(result.fields[0].notAttempted).toBeFalsy();

    // The structured result comes back with time to spare before the
    // transport's own deadline -- never at or past it -- even though the
    // stalled tap call is still pending in the background.
    expect(fakeTimer.now()).toBeLessThanOrEqual(transportDeadlineMs);
  });

  test("a stalled field's race is armed to end at liveDeadline - RESPONSE_HEADROOM_MS, strictly before the daemon's outer abort (issue #6222 P1, fujug)", async () => {
    // The daemon's own outer abort (`controller.abort()` in
    // `handleIdeRequest`, `src/daemon/socketServer.ts`) fires EXACTLY at the
    // live deadline, with no headroom of its own. If this field's race were
    // armed for the SAME instant, the two timers would be a coin flip
    // against response serialization instead of a guarantee that the
    // structured partial result wins. Assert the armed duration directly,
    // rather than only the final (forced-to-target) fake-clock reading a
    // single big `advanceTime()` call would otherwise leave observable.
    const RESPONSE_HEADROOM_MS = 3_000; // mirrors SetUIState's internal constant
    const callStartMs = fakeTimer.now();
    const transportDeadlineMs = callStartMs + 60_000;

    let tapCalls = 0;
    const stallingDependencies = {
      tapOnElement: {
        execute: async () => {
          tapCalls++;
          // Never resolves.
          return new Promise<{ success: boolean }>(() => {});
        },
      },
      clearText: { execute: async () => ({ success: true }) },
      inputText: { execute: async (text: string) => ({ success: true, text }) },
    };

    fakeFieldTypeDetector.setSkipVerification("firstName", true);
    fakeObserve.setResult({
      updatedAt: 0,
      screenSize: { width: 1080, height: 1920 },
      systemInsets: { top: 0, right: 0, bottom: 0, left: 0 },
      viewHierarchy: threeFieldHierarchy,
    });

    const setUIState = new SetUIState(device, null, {
      ...stallingDependencies,
      swipeOn: fakeSwipe,
      observeScreen: fakeObserve,
      fieldTypeDetector: fakeFieldTypeDetector,
      timer: fakeTimer,
    });

    const resultPromise = setUIState.execute(
      { fields: [{ selector: { elementId: "firstName" }, value: "Grace" }] },
      undefined,
      undefined,
      transportDeadlineMs,
    );

    for (let i = 0; i < 50 && tapCalls === 0; i++) {
      await Promise.resolve();
    }
    expect(tapCalls).toBe(1);

    // Exactly one pending timeout at this point -- the initial observation's
    // own race already resolved and cleared its timer. Its duration must be
    // the deadline minus the response headroom, not the full transport
    // deadline.
    const pending = fakeTimer.getPendingTimeouts();
    expect(pending).toHaveLength(1);
    expect(pending[0]).toBe(transportDeadlineMs - RESPONSE_HEADROOM_MS - fakeTimer.now());

    fakeTimer.advanceTime(60_000);
    const result = await resultPromise;

    expect(result.fields[0].timedOut).toBe(true);
    expect(fakeTimer.now()).toBeLessThanOrEqual(transportDeadlineMs);
  });

  test("a mid-field progress notification that extends the live deadline re-arms THAT field's own race, not just fields admitted afterward (issue #6222 P1, fujuk)", async () => {
    // Models a field whose total device cost (50s) exceeds the ORIGINAL 30s
    // transport deadline's own cutoff (27s, after RESPONSE_HEADROOM_MS), but
    // whose own tap step reports progress partway through -- the trigger
    // that extends a real `ProgressExtendableDeadline` on the daemon side.
    // Without re-arming against the LIVE deadline on that tick, this field
    // would incorrectly time out at the stale 27s snapshot despite the
    // transport itself remaining valid far longer.
    const callStartMs = fakeTimer.now();
    const frozenTransportDeadlineMs = callStartMs + 30_000;
    let liveDeadlineMs = frozenTransportDeadlineMs;

    const stallingDependencies = {
      tapOnElement: {
        execute: async (
          _opts: unknown,
          progress?: (p: number, t?: number, m?: string) => Promise<void>,
        ) => {
          fakeTimer.advanceTime(10_000);
          await progress?.(1, 2, "tap done");
          return { success: true, focusVerified: true };
        },
      },
      clearText: {
        execute: async () => {
          fakeTimer.advanceTime(20_000);
          return { success: true };
        },
      },
      inputText: {
        execute: async (text: string) => {
          fakeTimer.advanceTime(20_000);
          fakeFieldTypeDetector.setTextValue("firstName", text);
          return { success: true, text };
        },
      },
    };

    fakeFieldTypeDetector.setSkipVerification("firstName", true);
    fakeObserve.setResult({
      updatedAt: 0,
      screenSize: { width: 1080, height: 1920 },
      systemInsets: { top: 0, right: 0, bottom: 0, left: 0 },
      viewHierarchy: threeFieldHierarchy,
    });

    const setUIState = new SetUIState(device, null, {
      ...stallingDependencies,
      swipeOn: fakeSwipe,
      observeScreen: fakeObserve,
      fieldTypeDetector: fakeFieldTypeDetector,
      timer: fakeTimer,
    });

    const result = await setUIState.execute(
      { fields: [{ selector: { elementId: "firstName" }, value: "Grace" }] },
      // Stands in for the daemon's onprogress handler: extends the shared
      // `ProgressExtendableDeadline` SYNCHRONOUSLY as part of handling this
      // call's own progress notification, exactly as `extendOnProgress`
      // (`src/daemon/socketServer.ts`) does before the notification's own
      // round trip completes -- not merely sometime after.
      async () => {
        liveDeadlineMs = callStartMs + 120_000;
      },
      undefined,
      frozenTransportDeadlineMs,
      () => liveDeadlineMs,
    );

    // The field ran for 50s total -- well past the ORIGINAL 30s deadline's
    // own cutoff -- and still succeeded, because the mid-field progress
    // extension re-armed its race against the NEW, larger live deadline
    // instead of leaving it bound by the stale snapshot captured at
    // admission.
    expect(result.success).toBe(true);
    expect(result.fields[0].success).toBe(true);
    expect(result.fields[0].timedOut).toBeFalsy();
    expect(fakeTimer.now() - callStartMs).toBeGreaterThan(30_000);
    expect(fakeTimer.now()).toBeLessThan(liveDeadlineMs);
  });

  test("an extension landing AFTER the field's last progress tick but before the old cutoff still re-arms the in-flight race (issue #6283)", async () => {
    // The daemon extends the live deadline in its own `onprogress` handler,
    // which can run after this call's progress callback -- and so after the
    // `onTick` re-read -- has already returned. Here the tick re-reads the
    // OLD 30s deadline (cutoff 27s); the extension only lands at 26s, from a
    // separate timer, while the field's clear step is still running until
    // 40s. Only a subscription to the extension keeps the field alive.
    const callStartMs = fakeTimer.now();
    const deadline = new ProgressExtendableDeadline(callStartMs, 30_000);
    fakeTimer.setTimeout(() => deadline.extendOnProgress(fakeTimer.now(), 60_000), 26_000);
    let clearStarted = false;

    const setUIState = new SetUIState(device, null, {
      tapOnElement: {
        execute: async (
          _opts: unknown,
          progress?: (p: number, t?: number, m?: string) => Promise<void>,
        ) => {
          fakeTimer.advanceTime(10_000);
          await progress?.(1, 2, "tap done");
          return { success: true, focusVerified: true };
        },
      },
      clearText: {
        execute: () =>
          new Promise<{ success: boolean }>((resolve) => {
            clearStarted = true;
            fakeTimer.setTimeout(() => resolve({ success: true }), 30_000);
          }),
      },
      inputText: {
        execute: async (text: string) => {
          fakeFieldTypeDetector.setTextValue("firstName", text);
          return { success: true, text };
        },
      },
      swipeOn: fakeSwipe,
      observeScreen: fakeObserve,
      fieldTypeDetector: fakeFieldTypeDetector,
      timer: fakeTimer,
    });
    fakeFieldTypeDetector.setSkipVerification("firstName", true);
    fakeObserve.setResult({
      updatedAt: 0,
      screenSize: { width: 1080, height: 1920 },
      systemInsets: { top: 0, right: 0, bottom: 0, left: 0 },
      viewHierarchy: threeFieldHierarchy,
    });

    const resultPromise = setUIState.execute(
      { fields: [{ selector: { elementId: "firstName" }, value: "Grace" }] },
      // Models `extra.sendNotification()` resolving WITHOUT the receiver
      // having extended the deadline yet.
      async () => {},
      undefined,
      callStartMs + 30_000,
      () => deadline.value,
      (listener) => deadline.onExtended(listener),
    );

    // Let the field reach its (fake-timer-driven) clear step before moving
    // the clock; advancing earlier would drain every due event before the
    // clear step's own timer exists.
    for (let i = 0; i < 20 && !clearStarted; i++) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    expect(clearStarted).toBe(true);
    // Still before the extension (26s) and the old cutoff (27s).
    expect(fakeTimer.now() - callStartMs).toBeLessThan(26_000);

    await fakeTimer.advanceTimeAsync(callStartMs + 40_000 - fakeTimer.now());
    const result = await resultPromise;

    expect(result.fields[0].timedOut).toBeFalsy();
    expect(result.fields[0].success).toBe(true);
    expect(result.success).toBe(true);
    expect(fakeTimer.now() - callStartMs).toBeGreaterThan(27_000);

    // The race unsubscribed once it settled: a later extension arms nothing.
    deadline.extendOnProgress(fakeTimer.now(), 60_000);
    expect(fakeTimer.getPendingTimeoutCount()).toBe(0);
  });

  test("a stalled initial observation with a tight post-queue budget returns bounded all-notAttempted results, never awaited unbounded (issue #6222 P1, fujun)", async () => {
    // Queueing leaves just over the 20s admission headroom (21s), so the
    // coarse pre-check passes -- but the initial observation itself then
    // stalls indefinitely. Only racing the observation itself (not merely
    // preceding it with the pre-check) keeps this bounded.
    const callStartMs = fakeTimer.now();
    const transportDeadlineMs = callStartMs + 21_000;

    const stallingObserve = {
      execute: () => new Promise<never>(() => {}),
    };

    const setUIState = new SetUIState(device, null, {
      tapOnElement: { execute: async () => ({ success: true }) },
      clearText: { execute: async () => ({ success: true }) },
      inputText: { execute: async (text: string) => ({ success: true, text }) },
      swipeOn: fakeSwipe,
      observeScreen: stallingObserve as unknown as FakeObserveScreenForSetUIState,
      fieldTypeDetector: fakeFieldTypeDetector,
      timer: fakeTimer,
    });

    const resultPromise = setUIState.execute(
      { fields: [{ selector: { elementId: "firstName" }, value: "Grace" }] },
      undefined,
      undefined,
      transportDeadlineMs,
    );

    for (let i = 0; i < 50 && fakeTimer.getPendingTimeoutCount() === 0; i++) {
      await Promise.resolve();
    }
    expect(fakeTimer.getPendingTimeoutCount()).toBeGreaterThan(0);

    fakeTimer.advanceTime(21_000);
    const result = await resultPromise;

    expect(result.success).toBe(false);
    expect(result.totalAttempts).toBe(0);
    expect(result.fields).toHaveLength(1);
    expect(result.fields[0].notAttempted).toBe(true);
    expect(result.error).toContain("initial observation");

    // Returned strictly before the outer transport deadline, never at or
    // past it.
    expect(fakeTimer.now()).toBeLessThanOrEqual(transportDeadlineMs);
  });
});

describe("SetUIState off-screen search device I/O is bounded by the result deadline (issue #6222 review, PRRT_kwDOP-GF5M6fuyts)", () => {
  const device: BootedDevice = { name: "test-device", platform: "android", deviceId: "device-1" };
  let fakeFieldTypeDetector: FakeFieldTypeDetector;
  let fakeTimer: FakeTimer;

  /** The requested field is absent from every observation -- the search loop runs. */
  const emptyHierarchy: ViewHierarchyResult = {
    hierarchy: { node: [] },
  } as unknown as ViewHierarchyResult;

  beforeEach(() => {
    fakeFieldTypeDetector = new FakeFieldTypeDetector();
    fakeTimer = new FakeTimer();
  });

  test("a stalled SwipeOn.execute during off-screen search returns the accumulated result instead of letting the outer abort discard it", async () => {
    // When a requested field is absent from the current hierarchy, the last
    // deadline check runs BEFORE the unbounded swipe + re-observe pair. If
    // the swipe stalls, that award must still be bounded by the same live
    // cutoff every other device call in this method already respects.
    const callStartMs = fakeTimer.now();
    const transportDeadlineMs = callStartMs + 30_000;

    let swipeCalls = 0;
    const stallingSwipe = {
      execute: async () => {
        swipeCalls++;
        // Never resolves.
        return new Promise<{ success: boolean }>(() => {});
      },
    };

    const observeScreen = {
      execute: async () => ({
        updatedAt: fakeTimer.now(),
        screenSize: { width: 1080, height: 1920 },
        systemInsets: { top: 0, right: 0, bottom: 0, left: 0 },
        viewHierarchy: emptyHierarchy,
      }),
    };

    const setUIState = new SetUIState(device, null, {
      tapOnElement: { execute: async () => ({ success: true }) },
      clearText: { execute: async () => ({ success: true }) },
      inputText: { execute: async (text: string) => ({ success: true, text }) },
      swipeOn: stallingSwipe as unknown as FakeSwipeOn,
      observeScreen: observeScreen as unknown as FakeObserveScreenForSetUIState,
      fieldTypeDetector: fakeFieldTypeDetector,
      timer: fakeTimer,
    });

    const resultPromise = setUIState.execute(
      { fields: [{ selector: { elementId: "firstName" }, value: "Grace" }] },
      undefined,
      undefined,
      transportDeadlineMs,
    );

    for (let i = 0; i < 50 && swipeCalls === 0; i++) {
      await Promise.resolve();
    }
    expect(swipeCalls).toBe(1);
    expect(fakeTimer.getPendingTimeoutCount()).toBeGreaterThan(0);

    fakeTimer.advanceTime(30_000);
    const result = await resultPromise;

    // A real, structured result -- never a hang past the deadline -- with the
    // never-found field marked not-attempted rather than silently discarded.
    expect(result.success).toBe(false);
    expect(result.fields).toHaveLength(1);
    expect(result.fields[0].notAttempted).toBe(true);
    expect(result.error).toContain("result deadline");
    expect(fakeTimer.now()).toBeLessThanOrEqual(transportDeadlineMs);
  });

  test("a stalled follow-up ObserveScreen.execute during off-screen search returns the accumulated result instead of letting the outer abort discard it", async () => {
    // Same hazard as above, but the swipe itself completes and it is the
    // follow-up re-observe (the second call into ObserveScreen -- the first
    // is the initial observation) that stalls.
    const callStartMs = fakeTimer.now();
    const transportDeadlineMs = callStartMs + 30_000;

    const swipeOn = {
      execute: async () => ({ success: true }),
    };

    let observeCalls = 0;
    const observeScreen = {
      execute: async () => {
        observeCalls++;
        if (observeCalls === 1) {
          return {
            updatedAt: fakeTimer.now(),
            screenSize: { width: 1080, height: 1920 },
            systemInsets: { top: 0, right: 0, bottom: 0, left: 0 },
            viewHierarchy: emptyHierarchy,
          };
        }
        // The follow-up re-observe after the swipe -- never resolves.
        return new Promise<never>(() => {});
      },
    };

    const setUIState = new SetUIState(device, null, {
      tapOnElement: { execute: async () => ({ success: true }) },
      clearText: { execute: async () => ({ success: true }) },
      inputText: { execute: async (text: string) => ({ success: true, text }) },
      swipeOn: swipeOn as unknown as FakeSwipeOn,
      observeScreen: observeScreen as unknown as FakeObserveScreenForSetUIState,
      fieldTypeDetector: fakeFieldTypeDetector,
      timer: fakeTimer,
    });

    const resultPromise = setUIState.execute(
      { fields: [{ selector: { elementId: "firstName" }, value: "Grace" }] },
      undefined,
      undefined,
      transportDeadlineMs,
    );

    for (let i = 0; i < 50 && observeCalls < 2; i++) {
      await Promise.resolve();
    }
    expect(observeCalls).toBe(2);
    expect(fakeTimer.getPendingTimeoutCount()).toBeGreaterThan(0);

    fakeTimer.advanceTime(30_000);
    const result = await resultPromise;

    expect(result.success).toBe(false);
    expect(result.fields).toHaveLength(1);
    expect(result.fields[0].notAttempted).toBe(true);
    expect(result.error).toContain("result deadline");
    expect(fakeTimer.now()).toBeLessThanOrEqual(transportDeadlineMs);
  });
});

describe("SetUIState post-success observation refresh is bounded by the result deadline (issue #6222 review, PRRT_kwDOP-GF5M6fu4ev)", () => {
  const device: BootedDevice = { name: "test-device", platform: "android", deviceId: "device-1" };
  let fakeFieldTypeDetector: FakeFieldTypeDetector;
  let fakeTimer: FakeTimer;

  beforeEach(() => {
    fakeFieldTypeDetector = new FakeFieldTypeDetector();
    fakeTimer = new FakeTimer();
  });

  test("a stalled post-success observation refresh returns the accumulated result instead of letting the outer abort discard it", async () => {
    // Checkboxes do not need a value-verification observe, so
    // `observationAfterSuccess()`'s fallback issues an unbounded
    // `ObserveScreen.execute()`. If THAT stalls, it must still be bounded by
    // the same live cutoff every other device call in this method respects.
    const callStartMs = fakeTimer.now();
    const transportDeadlineMs = callStartMs + 30_000;

    const checkboxHierarchy: ViewHierarchyResult = {
      hierarchy: {
        node: [
          {
            $: {
              bounds: { left: 0, top: 0, right: 100, bottom: 50 },
              "resource-id": "checkbox",
              text: "",
              class: "android.widget.CheckBox",
              checkable: "true",
              checked: "false",
            },
          },
        ],
      },
    };

    fakeFieldTypeDetector.setFieldType("checkbox", "checkbox");
    fakeFieldTypeDetector.setSkipVerification("checkbox", true);

    let observeCalls = 0;
    const observeScreen = {
      execute: async () => {
        observeCalls++;
        if (observeCalls === 1) {
          return {
            updatedAt: fakeTimer.now(),
            screenSize: { width: 1080, height: 1920 },
            systemInsets: { top: 0, right: 0, bottom: 0, left: 0 },
            viewHierarchy: checkboxHierarchy,
          };
        }
        // The post-success observation refresh -- never resolves.
        return new Promise<never>(() => {});
      },
    };

    const setUIState = new SetUIState(device, null, {
      tapOnElement: { execute: async () => ({ success: true }) },
      clearText: { execute: async () => ({ success: true }) },
      inputText: { execute: async (text: string) => ({ success: true, text }) },
      swipeOn: { execute: async () => ({ success: true }) } as unknown as FakeSwipeOn,
      observeScreen: observeScreen as unknown as FakeObserveScreenForSetUIState,
      fieldTypeDetector: fakeFieldTypeDetector,
      timer: fakeTimer,
    });

    const resultPromise = setUIState.execute(
      { fields: [{ selector: { elementId: "checkbox" }, selected: true }] },
      undefined,
      undefined,
      transportDeadlineMs,
    );

    for (let i = 0; i < 50 && observeCalls < 2; i++) {
      await Promise.resolve();
    }
    expect(observeCalls).toBe(2);
    expect(fakeTimer.getPendingTimeoutCount()).toBeGreaterThan(0);

    fakeTimer.advanceTime(30_000);
    const result = await resultPromise;

    // The field itself succeeded and must be reported as such -- only the
    // follow-up observation stalled -- and the call must return a real,
    // structured result rather than hang past the deadline.
    expect(result.fields).toHaveLength(1);
    expect(result.fields[0].success).toBe(true);
    expect(result.error).toContain("post-success observation refresh");
    expect(fakeTimer.now()).toBeLessThanOrEqual(transportDeadlineMs);
  });
});
