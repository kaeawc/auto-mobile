import { describe, expect, spyOn, test } from "bun:test";
import {
  DefaultSendKeysCommandExecutor,
  SendKeys,
  type SendKeysObserver,
  type SendKeysOperation,
  type SendKeysTextClient,
} from "../../../src/features/action/SendKeys";
import {
  readIosFocusedField,
  describeIosTypedTextMismatch,
} from "../../../src/features/action/IosTextReadBack";
import {
  runWithTextRequestContext,
  TextIndeterminateError,
} from "../../../src/features/action/textTransportTimeout";
import { DefaultElementParser } from "../../../src/features/utility/ElementParser";
import { nodeAttributes } from "../../../src/models/ViewHierarchyResult";
import type { BootedDevice, ObserveResult, ViewHierarchyNode } from "../../../src/models";
import { logger } from "../../../src/utils/logger";
import { FakeAdbClientFactory } from "../../fakes/FakeAdbClientFactory";
import { FakeFocusedTextField, FakeIOSCtrlProxy } from "../../fakes/FakeIOSCtrlProxy";
import { FakeTimer } from "../../fakes/FakeTimer";
import iosFormsEmptyFields from "../../fixtures/observe/ios-forms-empty-fields";
import { iosKeyboardVisibleHierarchy } from "../../fixtures/observe/iosKeyboardStates";

const iosDevice: BootedDevice = { deviceId: "ios-sim", name: "iPhone", platform: "ios" };

/**
 * The real iOS capture with a focused UITextField (value "mt8@example.com", hint "Email"), whose
 * focused node is rewritten to what the runner would report for the fake's modelled field. The
 * rest of the capture is untouched; only the focused field's value attributes vary.
 */
function observationFor(fake: FakeIOSCtrlProxy): ObserveResult {
  const hierarchy = structuredClone(iosKeyboardVisibleHierarchy);
  const parser = new DefaultElementParser();
  const attributes = fake.getFocusedTextFieldAttributes();
  for (const root of parser.extractRootNodes(hierarchy)) {
    parser.traverseNode(root, (node: ViewHierarchyNode) => {
      const properties = parser.extractNodeProperties(node);
      if (properties.focused !== "true" || properties["hint-text"] !== "Email" || !attributes) {
        return;
      }
      const target = nodeAttributes(node);
      delete target.value;
      delete target["hint-text"];
      Object.assign(target, attributes);
    });
  }
  return { timestamp: 1, viewHierarchy: hierarchy } as ObserveResult;
}

function iosTextClient(
  fake: FakeIOSCtrlProxy,
  insert: SendKeysTextClient["insert"] = async (text, options) =>
    fake.requestAppendText(text, options?.timeoutMs),
): SendKeysTextClient & { inserts: string[] } {
  const inserts: string[] = [];
  return {
    inserts,
    replace: async (text) => {
      const cleared = await fake.requestClearText();
      return cleared.success ? fake.requestAppendText(text) : cleared;
    },
    insert: async (text, options) => {
      inserts.push(text);
      return insert(text, options);
    },
    clear: async () => fake.requestClearText(),
    ime: async () => ({ success: true }),
    supportsImeCommit: async () => false,
    supportsImeKeyEvents: async () => false,
    supportsKeyboardProfiles: async () => false,
    setKeyboardProfile: async () => ({
      success: false,
      error: "Keyboard profiles are Android-only",
    }),
    commitViaIme: async () => ({ success: false, error: "IME commit is Android-only" }),
  };
}

type ObserveOptions = Parameters<SendKeysObserver["execute"]>[0];

function setup(
  field: FakeFocusedTextField | null,
  options: {
    observe?: (fake: FakeIOSCtrlProxy, options: ObserveOptions) => Promise<ObserveResult>;
    insert?: SendKeysTextClient["insert"];
  } = {},
) {
  const fake = new FakeIOSCtrlProxy();
  if (field) {
    fake.setFocusedTextField(field);
  }
  const timer = new FakeTimer();
  const reads: ObserveOptions[] = [];
  const observer: SendKeysObserver = {
    execute: async (readOptions) => {
      reads.push(readOptions);
      return options.observe ? options.observe(fake, readOptions) : observationFor(fake);
    },
  };
  const textClient = iosTextClient(fake, options.insert);
  const executor = new DefaultSendKeysCommandExecutor(
    iosDevice,
    new FakeAdbClientFactory(),
    observer,
    { textClient, timer },
  );
  return { fake, timer, reads, observer, textClient, executor };
}

function type(
  h: ReturnType<typeof setup>,
  text: string,
  operation: SendKeysOperation = "insert",
  signal?: AbortSignal,
) {
  return h.executor.type({ action: "type", text, operation }, signal);
}

describe("sendKeys iOS typed-text read-back (#10167)", () => {
  test("a field that kept the typed text is verified, with two screenshot-free fresh reads", async () => {
    const h = setup({ value: "ab" });

    const result = await type(h, "cd");

    expect(result).toMatchObject({ success: true, verified: true, resolvedMode: "xcuiTypeText" });
    expect(result.warning).toBeUndefined();
    // One read before typing (what an append is compared with) and one after.
    expect(h.reads).toHaveLength(2);
    for (const read of h.reads) {
      expect(read).toMatchObject({ freshness: "fresh", skipScreenshot: true });
    }
  });

  test("a replace needs only the read after typing", async () => {
    const h = setup({ value: "old" });

    const result = await type(h, "new", "replace");

    expect(result).toMatchObject({ success: true, verified: true });
    expect(h.fake.getFocusedTextFieldValue()).toBe("new");
    expect(h.reads).toHaveLength(1);
  });

  test("a maximum-length field that truncated the input warns that it is shorter", async () => {
    const h = setup({ accept: (current, typed) => (current + typed).slice(0, 5) });

    const result = await type(h, "abcdefgh");

    expect(result.success).toBe(true);
    expect(result.verified).toBe(false);
    expect(result.warning).toContain('holds "abcde"');
    expect(result.warning).toContain('expected "abcdefgh"');
    expect(result.warning).toContain("shorter than expected");
  });

  test("a phone-number field that reformatted the input warns that it is longer", async () => {
    const h = setup({
      accept: (_current, typed) => `(${typed.slice(0, 3)}) ${typed.slice(3, 6)}-${typed.slice(6)}`,
    });

    const result = await type(h, "5551234567");

    expect(result).toMatchObject({ success: true, verified: false });
    expect(result.warning).toContain('holds "(555) 123-4567"');
    expect(result.warning).toContain("longer than expected");
  });

  test("a field that autocorrected the input to the same length warns that it changed", async () => {
    const h = setup({ accept: (current, typed) => current + typed.toUpperCase() });

    const result = await type(h, "teh");

    expect(result).toMatchObject({ success: true, verified: false });
    expect(result.warning).toContain("different from what was typed");
  });

  test("a field that rejected the input warns that it is unchanged", async () => {
    const h = setup({ value: "ab", accept: (current) => current });

    const result = await type(h, "cd");

    expect(result).toMatchObject({ success: true, verified: false });
    expect(result.warning).toContain('holds "ab"');
    expect(result.warning).toContain("unchanged, so the field did not take the input");
  });

  test("a replace into a field that refused everything is unchanged from empty", async () => {
    const h = setup({ value: "old", accept: () => "" });

    const result = await type(h, "new", "replace");

    expect(result.warning).toContain('holds ""');
    expect(result.warning).toContain("unchanged");
  });

  test.each<SendKeysOperation>(["insert", "replace"])(
    "a secure field is never read back, compared or echoed (%s)",
    async (operation) => {
      const warn = spyOn(logger, "warn").mockImplementation(() => {});
      const info = spyOn(logger, "info").mockImplementation(() => {});
      try {
        const h = setup({ secure: true, accept: () => "wrong-length" });

        const result = await type(h, "hunter2", operation);

        expect(result).toMatchObject({ success: true, verified: false });
        // No content warning even though the modelled field kept something else.
        expect(result.warning).toBeUndefined();
        // An insert stops after the first read; a replace reads once after typing.
        expect(h.reads).toHaveLength(1);
        const logged = JSON.stringify([...warn.mock.calls, ...info.mock.calls]);
        expect(logged).not.toContain("hunter2");
        expect(logged).not.toContain("wrong-length");
        expect(logged).not.toContain("•");
      } finally {
        warn.mockRestore();
        info.mockRestore();
      }
    },
  );

  test("an empty field showing its placeholder is empty, so a good append verifies", async () => {
    const h = setup({ placeholder: "Email" });
    // The runner reports the placeholder as the value of an empty field.
    expect(readIosFocusedField(observationFor(h.fake))).toEqual({
      kind: "text",
      text: "Email",
      placeholder: "Email",
    });

    const result = await type(h, "a@b.c");

    expect(result).toMatchObject({ success: true, verified: true });
    expect(result.warning).toBeUndefined();
  });

  test("a field still showing its placeholder after typing is reported as empty, not as the placeholder", async () => {
    const h = setup({ placeholder: "Email", accept: () => "" });

    const result = await type(h, "a@b.c");

    expect(result.warning).toContain('holds ""');
    expect(result.warning).not.toContain("Email");
  });

  test("typed text that equals the placeholder is a match", async () => {
    const h = setup({ placeholder: "Email" });

    const result = await type(h, "Email");

    expect(result).toMatchObject({ success: true, verified: true });
  });

  test.each([
    ["no focused field", async () => ({ timestamp: 1 }) as ObserveResult],
    [
      "a hierarchy with no focused text input",
      async () => ({ timestamp: 1, viewHierarchy: iosFormsEmptyFields }) as ObserveResult,
    ],
    [
      "a stale observation",
      async (fake: FakeIOSCtrlProxy) =>
        ({ ...observationFor(fake), freshness: { isFresh: false } }) as ObserveResult,
    ],
    [
      "a failed read",
      async (): Promise<ObserveResult> => {
        throw new Error("hierarchy timed out");
      },
    ],
  ])(
    "an unreadable field (%s) is not verified, with no claim about its content",
    async (_name, observe) => {
      const warn = spyOn(logger, "warn").mockImplementation(() => {});
      const info = spyOn(logger, "info").mockImplementation(() => {});
      try {
        const h = setup({ value: "ab" }, { observe });

        const result = await type(h, "cd");

        expect(result).toMatchObject({ success: true, verified: false });
        expect(result.warning).toContain("was not read back");
        expect(result.warning).toContain("the result was not verified");
        expect(result.warning).not.toContain("holds");
        // The typed text was still sent once.
        expect(h.textClient.inserts).toEqual(["cd"]);
        // Without a baseline there is nothing to compare: no second read.
        expect(h.reads).toHaveLength(1);
      } finally {
        warn.mockRestore();
        info.mockRestore();
      }
    },
  );

  test.each<SendKeysOperation>(["insert", "replace"])(
    "an indeterminate dispatch is not followed by a read-back that claims success (%s)",
    async (operation) => {
      const h = setup(
        { value: "ab" },
        {
          // The keys may well have landed, but the reply never came.
          insert: async (text, options) => {
            await h.fake.requestAppendText(text, options?.timeoutMs);
            return {
              success: false,
              retryable: false,
              error: new TextIndeterminateError("no reply within 5000ms").message,
            };
          },
        },
      );

      const result = await type(h, "cd", operation);

      expect(result).toMatchObject({ success: false, retryable: false });
      expect(result.error).toContain("outcome is indeterminate");
      expect(result.verified).toBeUndefined();
      expect(result.warning).toBeUndefined();
      // Insert read the field once before dispatch; nothing is read after the unconfirmed reply.
      expect(h.reads).toHaveLength(operation === "insert" ? 1 : 0);
    },
  );

  test("the read-back is bounded by the request deadline and aborts the read it abandons", async () => {
    const h = setup(
      { value: "ab" },
      { observe: () => new Promise<ObserveResult>(() => undefined) },
    );
    const warn = spyOn(logger, "warn").mockImplementation(() => {});
    const info = spyOn(logger, "info").mockImplementation(() => {});
    try {
      // 1500ms left, less the 1000ms response margin: 500ms of text budget, half for the pre-read.
      const pending = runWithTextRequestContext({ getDeadlineMs: () => h.timer.now() + 1500 }, () =>
        type(h, "cd"),
      );
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(h.reads).toHaveLength(1);
      expect(h.reads[0]?.signal?.aborted).toBe(false);
      h.timer.advanceTime(250);

      const result = await pending;

      expect(result).toMatchObject({ success: true, verified: false });
      expect(result.warning).toContain("was not read back");
      expect(h.reads[0]?.signal?.aborted).toBe(true);
      expect(h.textClient.inserts).toEqual(["cd"]);
    } finally {
      warn.mockRestore();
      info.mockRestore();
    }
  });

  test("a request with no deadline left reads nothing and says so", async () => {
    const h = setup({ value: "ab" });
    const info = spyOn(logger, "info").mockImplementation(() => {});
    try {
      const result = await runWithTextRequestContext(
        { getDeadlineMs: () => h.timer.now() + 1000 },
        () => type(h, "cd"),
      );

      expect(result).toMatchObject({ success: true, verified: false });
      expect(result.warning).toContain("left no time");
      expect(h.reads).toHaveLength(0);
    } finally {
      info.mockRestore();
    }
  });

  test("cancelling during the read stops before anything is typed", async () => {
    const controller = new AbortController();
    const h = setup(
      { value: "ab" },
      {
        observe: async (fake) => {
          controller.abort();
          return observationFor(fake);
        },
      },
    );

    await expect(type(h, "cd", "insert", controller.signal)).rejects.toThrow();
    expect(h.textClient.inserts).toEqual([]);
  });

  test("empty text is not read back", async () => {
    const h = setup({ value: "ab" });

    const result = await type(h, "");

    expect(result).toMatchObject({ success: true });
    expect(result.verified).toBeUndefined();
    expect(h.reads).toHaveLength(0);
  });

  test("a line break in the typed text is an action key, not content", async () => {
    const h = setup({ accept: (current, typed) => current + typed.replace("\n", "") });

    const result = await type(h, "hello\n");

    expect(result).toMatchObject({ success: true, verified: true });
  });

  test("text typed at a caret inside the existing text still verifies", async () => {
    const h = setup({
      value: "ac",
      accept: (current, typed) => current.slice(0, 1) + typed + current.slice(1),
    });

    const result = await type(h, "b");

    expect(result).toMatchObject({ success: true, verified: true });
  });

  test("the warning reaches the sendKeys result and the command", async () => {
    const h = setup({ accept: (current, typed) => (current + typed).slice(0, 2) });
    const sendKeys = new SendKeys(iosDevice, new FakeAdbClientFactory(), {
      executor: h.executor,
      observer: h.observer,
      timer: h.timer,
      timestampProvider: { now: async () => 0 },
    });

    const result = await sendKeys.execute([{ action: "type", text: "abcd" }]);

    expect(result.success).toBe(true);
    expect(result.warning).toContain('holds "ab"');
    expect(result.commands[0]).toMatchObject({ success: true, verified: false });
  });
});

describe("iOS focused-field read", () => {
  test("reads the value and placeholder of the real captured focused field", () => {
    const observation = { timestamp: 1, viewHierarchy: iosKeyboardVisibleHierarchy };

    expect(readIosFocusedField(observation as ObserveResult)).toEqual({
      kind: "text",
      text: "mt8@example.com",
      placeholder: "Email",
    });
  });

  test("a capture with no focused text input is unreadable", () => {
    const observation = { timestamp: 1, viewHierarchy: iosFormsEmptyFields };

    expect(readIosFocusedField(observation as ObserveResult)).toMatchObject({
      kind: "unreadable",
    });
  });

  test("a mismatch is described against the baseline, and a match yields nothing", () => {
    const after = { text: "ab" };
    expect(
      describeIosTypedTextMismatch({ typed: "b", operation: "insert", before: "a", after }),
    ).toBeUndefined();
    // A replace starts from empty whatever the field held before.
    expect(
      describeIosTypedTextMismatch({ typed: "b", operation: "replace", before: "zzz", after }),
    ).toContain("longer than expected");
  });
});
