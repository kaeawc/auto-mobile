import { expect, describe, test, beforeEach } from "bun:test";
import { IOSCtrlProxyClient } from "../../../src/features/observe/ios";
import { ViewHierarchy } from "../../../src/features/observe/ViewHierarchy";
import { Clipboard } from "../../../src/features/action/Clipboard";
import { BootedDevice, ViewHierarchyNode, ViewHierarchyResult } from "../../../src/models";
import { nodeAttributes } from "../../../src/models/ViewHierarchyResult";
import { FakeIOSCtrlProxy } from "../../fakes/FakeIOSCtrlProxy";
import { FakeAdbExecutor } from "../../fakes/FakeAdbExecutor";
import { FakeAdbClientFactory } from "../../fakes/FakeAdbClientFactory";

import { FakeKeyboardHierarchyProvider } from "../../fakes/FakeKeyboardHierarchyProvider";
import { FakeTimer } from "../../fakes/FakeTimer";
import iosFormsEmptyFields from "../../fixtures/observe/ios-forms-empty-fields";
import {
  iosKeyboardVisibleHierarchy,
  iosKeyboardMinimizedHierarchy,
} from "../../fixtures/observe/iosKeyboardStates";
import { DefaultElementParser } from "../../../src/features/utility/ElementParser";
import { getFocusedTextField, getFocusedTextValue } from "../../../src/features/action/ClearText";
import { logger } from "../../../src/utils/logger";
import { spyOn } from "bun:test";
import { createExecResult } from "../../../src/utils/execResult";
import { wrapCommandError } from "../../../src/utils/CommandError";
import { errorMessage } from "../../../src/utils/describeUnknownError";
import {
  IosRunnerBusyError,
  IosRunnerStalledError,
} from "../../../src/features/observe/ios/runnerErrorCodes";

// Synthetic focused-value variants of the representative iOS forms fixture, not captures.
function focusedIOSForm(value?: string): ViewHierarchyResult {
  const hierarchy = structuredClone(iosFormsEmptyFields);
  const parser = new DefaultElementParser();
  for (const root of parser.extractRootNodes(hierarchy)) {
    parser.traverseNode(root, (node: ViewHierarchyNode) => {
      if (node.$?.["resource-id"] === "name-field") {
        node.$ = { ...node.$, focused: "true", value };
      }
    });
  }
  return hierarchy;
}

describe("Clipboard iOS", () => {
  let clipboard: Clipboard;
  let mockDevice: BootedDevice;
  let fakeIOSCtrlProxy: FakeIOSCtrlProxy;
  let hierarchy: FakeKeyboardHierarchyProvider;
  let timer: FakeTimer;

  beforeEach(() => {
    mockDevice = {
      name: "Test iPhone",
      platform: "ios",
      deviceId: "test-iphone",
    };

    fakeIOSCtrlProxy = new FakeIOSCtrlProxy();

    hierarchy = new FakeKeyboardHierarchyProvider();
    timer = new FakeTimer();
    timer.enableAutoAdvance();
    clipboard = new Clipboard(
      mockDevice,
      new FakeAdbClientFactory(),
      () => fakeIOSCtrlProxy,
      hierarchy,
      timer,
    );
  });

  test("get returns clipboard text", async () => {
    fakeIOSCtrlProxy.setClipboardResult({
      success: true,
      action: "get",
      text: "hello world",
      totalTimeMs: 10,
    });

    const result = await clipboard.execute("get");

    expect(result.success).toBe(true);
    expect(result.action).toBe("get");
    expect(result.text).toBe("hello world");
    expect(result.method).toBe("a11y");
  });

  test("copy sends text to clipboard", async () => {
    fakeIOSCtrlProxy.setClipboardResult({
      success: true,
      action: "copy",
      totalTimeMs: 10,
    });

    const result = await clipboard.execute("copy", "test text");

    expect(result.success).toBe(true);
    expect(result.action).toBe("copy");

    const history = fakeIOSCtrlProxy.getClipboardHistory();
    expect(history).toHaveLength(1);
    expect(history[0].action).toBe("copy");
    expect(history[0].text).toBe("test text");
  });

  test("copy without text returns error", async () => {
    const result = await clipboard.execute("copy");

    expect(result.success).toBe(false);
    expect(result.error).toContain("Text is required");
  });

  test("clear clipboard succeeds", async () => {
    fakeIOSCtrlProxy.setClipboardResult({
      success: true,
      action: "clear",
      totalTimeMs: 10,
    });

    const result = await clipboard.execute("clear");

    expect(result.success).toBe(true);
    expect(result.action).toBe("clear");
  });

  test("empty clipboard paste succeeds as today without verification", async () => {
    fakeIOSCtrlProxy.setClipboardResult({
      success: true,
      action: "paste",
      text: "",
      totalTimeMs: 10,
    });

    const result = await clipboard.execute("paste");

    expect(result.success).toBe(true);
    expect(result.action).toBe("paste");
  });

  function readableClipboard(): void {
    fakeIOSCtrlProxy.setClipboardResults([
      { success: true, action: "get", text: "Z1", totalTimeMs: 1 },
      { success: true, action: "paste", totalTimeMs: 1 },
    ]);
  }

  test("synthetic non-empty clipboard with unchanged focused value reports unconfirmed paste", async () => {
    readableClipboard();
    hierarchy.setDefaultResult(focusedIOSForm("AB"));
    const result = await clipboard.execute("paste");
    expect(result.success).toBe(false);
    expect(result.method).toBe("a11y");
    expect(result.error).toContain("nothing appears to have been pasted");
    expect(result.error).toContain("outcome unconfirmed");
    expect(result.error).toContain("hardware keyboard");
    expect(result.error).toContain("Try pasting again");
    expect(timer.now()).toBe(1500);
    expect(hierarchy.getCallCount()).toBe(7); // Before, immediate after, then five 250ms polls.
    expect(fakeIOSCtrlProxy.getClipboardHistory().map((entry) => entry.action)).toEqual([
      "get",
      "paste",
    ]);
  });

  test("real visible capture with unchanged focused value reports unconfirmed paste", async () => {
    readableClipboard();
    hierarchy.setDefaultResult(iosKeyboardVisibleHierarchy);
    const result = await clipboard.execute("paste");
    expect(result.success).toBe(false);
    expect(result.method).toBe("a11y");
    expect(result.error).toContain("nothing appears to have been pasted");
    expect(result.error).toContain("outcome unconfirmed");
    expect(timer.now()).toBe(1500);
    expect(hierarchy.getCallCount()).toBe(7);
    expect(hierarchy.getReadOptions()).toEqual(
      [1500, 1500, 1250, 1000, 750, 500, 250].map((timeoutMs) => ({ timeoutMs })),
    );
    expect(getFocusedTextValue(iosKeyboardVisibleHierarchy)).toBe("mt8@example.com");
  });

  test("derived real visible capture with changed focused value confirms paste", async () => {
    readableClipboard();
    // Derived variant: only the focused field's value changes; the shared capture stays intact.
    const after = structuredClone(iosKeyboardVisibleHierarchy);
    const parser = new DefaultElementParser();
    for (const root of parser.extractRootNodes(after)) {
      parser.traverseNode(root, (node: ViewHierarchyNode) => {
        const properties = parser.extractNodeProperties(node);
        if (properties.focused === "true" && properties["hint-text"] === "Email") {
          nodeAttributes(node).value = "mt8@example.com Z1";
        }
      });
    }
    expect(getFocusedTextValue(after)).toBe("mt8@example.com Z1");
    hierarchy.setResults([iosKeyboardVisibleHierarchy, after]);
    expect(await clipboard.execute("paste")).toEqual({
      success: true,
      action: "paste",
      text: undefined,
      method: "a11y",
    });
    expect(hierarchy.getCallCount()).toBe(2);
    expect(timer.getSleepCallCount()).toBe(0);
    expect(getFocusedTextValue(iosKeyboardVisibleHierarchy)).toBe("mt8@example.com");
  });

  test.each([
    ["pre-paste only", true, false, 1],
    ["verification only", false, true, 2],
    ["both samples", true, true, 1],
  ] as const)(
    "secure field in %s skips unchanged-value verification",
    async (_name, beforeSecure, afterSecure, reads) => {
      readableClipboard();
      // No iOS capture contains a secure field. Add only the runner's documented password attribute.
      const secure = structuredClone(iosKeyboardVisibleHierarchy);
      const parser = new DefaultElementParser();
      for (const root of parser.extractRootNodes(secure)) {
        parser.traverseNode(root, (node: ViewHierarchyNode) => {
          const properties = parser.extractNodeProperties(node);
          if (properties.focused === "true" && properties["hint-text"] === "Email") {
            nodeAttributes(node).password = "true";
          }
        });
      }
      expect(getFocusedTextField(secure)).toEqual({ value: "mt8@example.com", secure: true });
      expect(getFocusedTextField(iosKeyboardVisibleHierarchy)?.secure).toBe(false);
      hierarchy.setResults([
        beforeSecure ? secure : iosKeyboardVisibleHierarchy,
        afterSecure ? secure : iosKeyboardVisibleHierarchy,
      ]);
      const info = spyOn(logger, "info").mockImplementation(() => {});
      try {
        expect((await clipboard.execute("paste")).success).toBe(true);
        expect(info).toHaveBeenCalledWith(
          "[Clipboard] iOS paste verification skipped for a secure field",
        );
        expect(hierarchy.getCallCount()).toBe(reads);
        expect(timer.now()).toBe(0);
        expect(timer.getSleepCallCount()).toBe(0);
        expect(fakeIOSCtrlProxy.getClipboardHistory().map((entry) => entry.action)).toEqual([
          "get",
          "paste",
        ]);
      } finally {
        info.mockRestore();
      }
    },
  );

  test.each([
    ["boolean password", { password: true }],
    ["secure class", { class: "UISecureTextField" }],
    ["secure className", { class: undefined, className: "XCUIElementTypeSecureTextField" }],
    ["unreadable secure value", { password: "true", value: undefined }],
  ] as const)("focused field metadata recognizes %s", (_name, attributes) => {
    const secure = structuredClone(iosKeyboardVisibleHierarchy);
    const parser = new DefaultElementParser();
    for (const root of parser.extractRootNodes(secure)) {
      parser.traverseNode(root, (node: ViewHierarchyNode) => {
        const properties = parser.extractNodeProperties(node);
        if (properties.focused === "true" && properties["hint-text"] === "Email") {
          Object.assign(nodeAttributes(node), attributes);
        }
      });
    }
    expect(getFocusedTextField(secure)?.secure).toBe(true);
    expect(getFocusedTextField(secure)?.value).toBe(
      _name === "unreadable secure value" ? undefined : "mt8@example.com",
    );
  });

  test.each(["AB Z1", "Z1"])(
    "synthetic changed focused value %s succeeds with the original result shape",
    async (after) => {
      readableClipboard();
      hierarchy.setResults([focusedIOSForm("AB"), focusedIOSForm(after)]);
      expect(await clipboard.execute("paste")).toEqual({
        success: true,
        action: "paste",
        text: undefined,
        method: "a11y",
      });
      expect(timer.getSleepCallCount()).toBe(0);
    },
  );

  test("synthetic value changes only on a later fake-time poll", async () => {
    readableClipboard();
    hierarchy.setResults([
      focusedIOSForm("AB"),
      focusedIOSForm("AB"),
      focusedIOSForm("AB"),
      focusedIOSForm("AB Z1"),
    ]);
    const result = await clipboard.execute("paste");
    expect(result.success).toBe(true);
    expect(timer.now()).toBe(500);
    expect(timer.getSleepHistory()).toEqual([250, 250]);
  });

  test.each(["", undefined])(
    "empty or undefined clipboard %j requires no hierarchy read",
    async (text) => {
      fakeIOSCtrlProxy.setClipboardResults([
        { success: true, action: "get", text, totalTimeMs: 1 },
        { success: true, action: "paste", totalTimeMs: 1 },
      ]);
      expect((await clipboard.execute("paste")).success).toBe(true);
      expect(hierarchy.getCallCount()).toBe(0);
    },
  );

  describe("paste through an unreadable pasteboard (#10083)", () => {
    function unreadableClipboard(): void {
      fakeIOSCtrlProxy.setClipboardResults([
        { success: false, action: "get", error: "read denied", totalTimeMs: 1 },
        { success: true, action: "paste", totalTimeMs: 1 },
      ]);
    }
    const phases = () => fakeIOSCtrlProxy.getClipboardHistory().map((entry) => entry.action);

    test("a changed focused field is a success", async () => {
      unreadableClipboard();
      hierarchy.setResults([focusedIOSForm("AB"), focusedIOSForm("AB Z1")]);
      expect(await clipboard.execute("paste")).toEqual({
        success: true,
        action: "paste",
        text: undefined,
        method: "a11y",
      });
      expect(phases()).toEqual(["get", "paste"]);
    });

    test("an unchanged focused field reports that nothing was pasted", async () => {
      unreadableClipboard();
      hierarchy.setDefaultResult(focusedIOSForm("AB"));
      const result = await clipboard.execute("paste");
      expect(result.success).toBe(false);
      expect(result.error).toContain("nothing appears to have been pasted");
      expect(timer.now()).toBe(1500);
    });

    test.each([
      ["no hierarchy before the paste", null],
      ["no readable focused value before the paste", focusedIOSForm(undefined)],
    ] as const)("%s never claims success", async (_name, value) => {
      unreadableClipboard();
      hierarchy.setDefaultResult(value);
      const result = await clipboard.execute("paste");
      expect(result.success).toBe(false);
      expect(result.error).toContain("Paste outcome is indeterminate");
      expect(result.error).toContain("could not be compared");
      expect(phases()).toEqual(["get", "paste"]);
    });

    test("a field that becomes unreadable after the paste never claims success", async () => {
      unreadableClipboard();
      hierarchy.setResults([focusedIOSForm("AB"), null]);
      const result = await clipboard.execute("paste");
      expect(result.success).toBe(false);
      expect(result.error).toContain("Paste outcome is indeterminate");
    });

    test("a secure field is not read or echoed, and success is not claimed", async () => {
      unreadableClipboard();
      const secure = focusedIOSForm("hunter2");
      new DefaultElementParser().traverseNode(
        new DefaultElementParser().extractRootNodes(secure)[0],
        (node: ViewHierarchyNode) => {
          if (node.$?.["resource-id"] === "name-field") {
            nodeAttributes(node).password = "true";
          }
        },
      );
      hierarchy.setDefaultResult(secure);
      const result = await clipboard.execute("paste");
      expect(result.success).toBe(false);
      expect(result.error).toContain("Paste outcome is indeterminate");
      expect(JSON.stringify(result)).not.toContain("hunter2");
      expect(hierarchy.getCallCount()).toBe(1);
    });

    test("a pasteboard known to be empty still skips the field read", async () => {
      fakeIOSCtrlProxy.setClipboardResults([
        { success: true, action: "get", text: "", totalTimeMs: 1 },
        { success: true, action: "paste", totalTimeMs: 1 },
      ]);
      expect((await clipboard.execute("paste")).success).toBe(true);
      expect(hierarchy.getCallCount()).toBe(0);
    });
  });

  test.each([
    ["unavailable", null],
    ["no focused field", iosFormsEmptyFields],
    ["synthetic no readable value", focusedIOSForm(undefined)],
    ["hierarchy error", { hierarchy: { error: "read failed" } }],
  ] as const)(
    "%s hierarchy keeps success because verification is impossible",
    async (_name, value) => {
      readableClipboard();
      hierarchy.setDefaultResult(value);
      expect((await clipboard.execute("paste")).success).toBe(true);
      expect(hierarchy.getCallCount()).toBe(1);
    },
  );

  test("synthetic hierarchy disappearing after paste keeps an indeterminate success", async () => {
    readableClipboard();
    hierarchy.setResults([focusedIOSForm("AB"), null]);
    expect((await clipboard.execute("paste")).success).toBe(true);
  });

  test("throwing hierarchy logs a warning and preserves paste success", async () => {
    readableClipboard();
    const warning = spyOn(logger, "warn").mockImplementation(() => {});
    try {
      const reader = {
        getViewHierarchy: async () => {
          throw new Error("read failed");
        },
      };
      const action = new Clipboard(
        mockDevice,
        new FakeAdbClientFactory(),
        () => fakeIOSCtrlProxy,
        reader,
        timer,
      );
      expect((await action.execute("paste")).success).toBe(true);
      expect(warning).toHaveBeenCalled();
    } finally {
      warning.mockRestore();
    }
  });

  test("synthetic hanging post-paste hierarchy is bounded and cannot prove a dropped paste", async () => {
    readableClipboard();
    let reads = 0;
    const reader = {
      getViewHierarchy: async () => {
        if (reads++ === 0) {
          return focusedIOSForm("AB");
        }
        return new Promise<ViewHierarchyResult>(() => {});
      },
    };
    const action = new Clipboard(
      mockDevice,
      new FakeAdbClientFactory(),
      () => fakeIOSCtrlProxy,
      reader,
      timer,
    );
    expect((await action.execute("paste")).success).toBe(true);
    expect(timer.now()).toBe(1500);
  });

  test("synthetic default hierarchy reader invalidates the iOS cache for every sample", async () => {
    readableClipboard();
    const invalidations: number[] = [];
    const client = {
      invalidateCache: () => {
        invalidations.push(timer.now());
      },
    } as IOSCtrlProxyClient;
    const ios = spyOn(IOSCtrlProxyClient, "getInstance").mockReturnValue(client);
    const read = spyOn(ViewHierarchy.prototype, "getViewHierarchy")
      .mockResolvedValueOnce(focusedIOSForm("AB"))
      .mockResolvedValueOnce(focusedIOSForm("Z1"));
    try {
      const action = new Clipboard(
        mockDevice,
        new FakeAdbClientFactory(),
        () => fakeIOSCtrlProxy,
        undefined,
        timer,
      );
      expect((await action.execute("paste")).success).toBe(true);
      expect(invalidations).toHaveLength(2);
      expect(read).toHaveBeenCalledTimes(2);
      expect(read.mock.calls[0]?.slice(2)).toEqual([false, 0, undefined, 1500]);
    } finally {
      ios.mockRestore();
      read.mockRestore();
    }
  });

  test("clipboard get exception warns, still sends paste once, and verifies through the field", async () => {
    hierarchy.setResults([focusedIOSForm("AB"), focusedIOSForm("AB Z1")]);
    const warning = spyOn(logger, "warn").mockImplementation(() => {});
    const requests: string[] = [];
    const client = {
      requestClipboard: async (action: string) => {
        requests.push(action);
        if (action === "get") {
          throw new Error("get failed");
        }
        return { success: true, totalTimeMs: 1 };
      },
    };
    try {
      const action = new Clipboard(
        mockDevice,
        new FakeAdbClientFactory(),
        () => client,
        hierarchy,
        timer,
      );
      expect((await action.execute("paste")).success).toBe(true);
      expect(requests).toEqual(["get", "paste"]);
      expect(hierarchy.getCallCount()).toBe(2);
      expect(warning).toHaveBeenCalled();
    } finally {
      warning.mockRestore();
    }
  });

  test("synthetic runner paste failure preserves its error and skips post-paste reads", async () => {
    fakeIOSCtrlProxy.setClipboardResults([
      { success: true, action: "get", text: "Z1", totalTimeMs: 1 },
      { success: false, action: "paste", error: "paste rejected", totalTimeMs: 1 },
    ]);
    hierarchy.setDefaultResult(focusedIOSForm("AB"));
    expect(await clipboard.execute("paste")).toEqual({
      success: false,
      action: "paste",
      error: "paste rejected",
    });
    expect(hierarchy.getCallCount()).toBe(1);
    expect(timer.getSleepCallCount()).toBe(0);
  });

  test.each([
    ["visible", iosKeyboardVisibleHierarchy, "mt8@example.com", "Email"],
    ["minimized", iosKeyboardMinimizedHierarchy, "AB Z1 K1 EN9 EN9", "Display Name"],
  ] as const)("focused value helper reads the real %s capture", (_name, capture, value, hint) => {
    const parser = new DefaultElementParser();
    const focused: Record<string, unknown>[] = [];
    for (const root of parser.extractRootNodes(capture)) {
      parser.traverseNode(root, (node: ViewHierarchyNode) => {
        const properties = parser.extractNodeProperties(node);
        if (properties.focused === "true") {
          focused.push(properties);
        }
      });
    }
    expect(focused).toHaveLength(1);
    expect(focused[0]).toMatchObject({
      className: "UITextField",
      focused: "true",
      role: "textfield",
      value,
      "hint-text": hint,
    });
    expect(focused[0]).not.toHaveProperty("text");
    expect(getFocusedTextValue(capture)).toBe(value);
  });

  test("synthetic focused value helper retains empty strings and whitespace and skips placeholders", () => {
    expect(getFocusedTextValue(focusedIOSForm(""))).toBe("");
    expect(getFocusedTextValue(focusedIOSForm("  "))).toBe("  ");
    expect(getFocusedTextValue(focusedIOSForm(undefined))).toBeUndefined();
    expect(getFocusedTextValue(iosFormsEmptyFields)).toBeUndefined();
  });

  test("returns error when CtrlProxy fails", async () => {
    fakeIOSCtrlProxy.setClipboardResult({
      success: false,
      action: "get",
      totalTimeMs: 10,
      error: "Clipboard access denied",
    });

    const result = await clipboard.execute("get");

    expect(result.success).toBe(false);
    expect(result.error).toBe("Clipboard access denied");
  });

  test("get returns success with undefined text when clipboard empty", async () => {
    fakeIOSCtrlProxy.setClipboardResult({
      success: true,
      action: "get",
      text: undefined,
      totalTimeMs: 10,
    });

    const result = await clipboard.execute("get");

    expect(result.success).toBe(true);
    expect(result.text).toBeUndefined();
  });
});

describe("Clipboard Android", () => {
  const androidDevice: BootedDevice = {
    name: "Test Android",
    platform: "android",
    deviceId: "test-android",
  };

  test.each([
    "timeout",
    "socket closed",
    "thrown after send",
    "WebSocket not connected",
    "send failed",
    "device refused",
    "unsupported",
    "success",
  ])("paste delivery: %s", async (reason) => {
    const adb = new FakeAdbExecutor();
    const factory = new FakeAdbClientFactory(adb);
    adb.setCommandResponse("shell cmd clipboard get", { stdout: "hello", stderr: "" });
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const undelivered = reason === "WebSocket not connected" || reason === "send failed";
    const acknowledged =
      reason === "device refused" || reason === "unsupported" || reason === "success";
    const action = new Clipboard(
      androidDevice,
      factory,
      () => ({
        requestClipboard: async (
          _action,
          _text,
          _timeout,
          _perf,
          _signal,
          onDispatch?: () => void,
        ) => {
          if (!undelivered) {
            onDispatch?.();
          }
          if (reason === "thrown after send") {
            throw new Error(reason);
          }
          return { success: reason === "success", totalTimeMs: 5000, error: reason, acknowledged };
        },
      }),
      undefined,
      timer,
    );
    const result = await action.execute("paste");
    const indeterminate = !undelivered && !acknowledged;
    expect(result.success).toBe(undelivered || reason === "success");
    if (indeterminate) {
      expect(result).toEqual({
        success: false,
        action: "paste",
        method: "a11y",
        error: `Paste outcome is indeterminate: the request was dispatched but no result was confirmed (${reason}). The paste may have been applied. Do not retry automatically. Observe before retrying.`,
      });
    }
    if (acknowledged && reason !== "success") {
      expect(result).toEqual({ success: false, action: "paste", method: "a11y", error: reason });
    }
    if (undelivered) {
      expect(result).toEqual({ success: true, action: "paste", method: "adb" });
    }
    expect(adb.getExecutedCommands()).toEqual(
      undelivered ? ["shell input keyevent KEYCODE_PASTE"] : [],
    );
  });

  test.each(["copy", "clear", "paste"] as const)(
    "acknowledged %s refusal preserves the device error without ADB recovery",
    async (action) => {
      const adb = new FakeAdbExecutor();
      adb.setCommandResponse(
        "shell cmd clipboard get",
        createExecResult("", "No shell command implementation.\n"),
      );
      const error = "No focused input field found. Focus a text field before pasting.";
      const clipboard = new Clipboard(
        androidDevice,
        new FakeAdbClientFactory(adb),
        () => ({
          requestClipboard: async (_action, _text, _timeout, _perf, _signal, onDispatch) => {
            onDispatch?.();
            return { success: false, acknowledged: true, error, totalTimeMs: 1 };
          },
        }),
        undefined,
        new FakeTimer(),
      );

      expect(await clipboard.execute(action, "x")).toEqual({
        success: false,
        action,
        error,
        method: "a11y",
      });
      expect(adb.getExecutedCommands()).toEqual([]);
    },
  );

  for (const action of ["copy", "clear"] as const) {
    for (const proxyFailure of ["timeout", "unreachable", "pre-send throw"] as const) {
      test.each([
        "stdout",
        "stderr",
        "rejected stdout",
        "rejected stderr",
        "cause stdout",
        "cause stderr",
        "own stdout with cause",
        "own stderr with cause",
        "non-zero exit",
        "wrapped non-zero exit",
        "success",
      ] as const)(`${action} after ${proxyFailure}: %s`, async (outcome) => {
        const adb = new FakeAdbExecutor();
        const command =
          action === "copy" ? "shell cmd clipboard set 'x'" : "shell cmd clipboard clear";
        const message = "No shell command implementation.\n";
        const transportFailure = outcome === "non-zero exit" || outcome === "wrapped non-zero exit";
        const unsupported = !transportFailure && outcome !== "success";
        let rejection: Error | undefined;
        if (outcome === "stdout" || outcome === "stderr" || outcome === "success") {
          adb.setCommandResponse(
            command,
            createExecResult(
              outcome === "stdout" ? message : "",
              outcome === "stderr" ? message : "",
            ),
          );
        } else {
          const output = {
            code: 1,
            stdout: unsupported && outcome.includes("stdout") ? message : "",
            stderr: unsupported && outcome.includes("stderr") ? message : "adb: device offline",
          };
          const error = Object.assign(
            new Error(transportFailure ? "adb: device offline" : "Command failed"),
            output,
          );
          if (outcome.startsWith("cause") || outcome === "wrapped non-zero exit") {
            rejection = wrapCommandError(error, { command });
          } else if (outcome.startsWith("own")) {
            rejection = Object.assign(
              new Error("Command failed", { cause: new Error("exec failed") }),
              output,
            );
          } else {
            rejection = error;
          }
          adb.setCommandError(command, rejection);
        }
        const reason =
          proxyFailure === "timeout"
            ? "Clipboard request timed out"
            : "Failed to connect to accessibility service";
        const clipboard = new Clipboard(
          androidDevice,
          new FakeAdbClientFactory(adb),
          () => ({
            requestClipboard: async (_action, _text, _timeout, _perf, _signal, onDispatch) => {
              if (proxyFailure === "pre-send throw") {
                throw new Error(reason);
              }
              if (proxyFailure === "timeout") {
                onDispatch?.();
              }
              return { success: false, acknowledged: false, error: reason, totalTimeMs: 1 };
            },
          }),
          undefined,
          new FakeTimer(),
        );

        expect(await clipboard.execute(action, "x")).toEqual({
          success: outcome === "success",
          action,
          method: "adb",
          ...(unsupported
            ? {
                error: `cmd clipboard is not supported on this device/API level (CtrlProxy: ${reason})`,
              }
            : transportFailure
              ? { error: `ADB clipboard operation failed: ${errorMessage(rejection)}` }
              : {}),
        });
        expect(adb.getExecutedCommands()).toEqual([command]);
      });
    }
  }

  for (const proxyFailure of ["unreachable", "pre-send throw"] as const) {
    test.each(["available", "unimplemented"] as const)(
      `paste after ${proxyFailure} ignores %s cmd clipboard get and completes the key event`,
      async (availability) => {
        const adb = new FakeAdbExecutor();
        adb.setCommandResponse(
          "shell cmd clipboard get",
          createExecResult(
            availability === "available" ? "hello" : "",
            availability === "unimplemented" ? "No shell command implementation.\n" : "",
          ),
        );
        const clipboard = new Clipboard(
          androidDevice,
          new FakeAdbClientFactory(adb),
          () => ({
            requestClipboard: async () => {
              if (proxyFailure === "pre-send throw") {
                throw new Error("Failed to connect to accessibility service");
              }
              return {
                success: false,
                acknowledged: false,
                error: "Failed to connect to accessibility service",
                totalTimeMs: 1,
              };
            },
          }),
          undefined,
          new FakeTimer(),
        );
        expect(await clipboard.execute("paste")).toEqual({
          success: true,
          action: "paste",
          method: "adb",
        });
        expect(adb.getExecutedCommands()).toEqual(["shell input keyevent KEYCODE_PASTE"]);
      },
    );
  }

  test.each(["transport", "wrapped transport", "unimplemented"] as const)(
    "paste key event rejection: %s",
    async (failure) => {
      const adb = new FakeAdbExecutor();
      const command = "shell input keyevent KEYCODE_PASTE";
      const error = Object.assign(new Error("adb: device offline"), {
        code: 1,
        stdout: "",
        stderr:
          failure === "unimplemented" ? "No shell command implementation." : "adb: device offline",
      });
      const rejection =
        failure === "wrapped transport" ? wrapCommandError(error, { command }) : error;
      adb.setCommandError(command, rejection);
      const reason = "Failed to connect to accessibility service";
      const clipboard = new Clipboard(
        androidDevice,
        new FakeAdbClientFactory(adb),
        () => ({
          requestClipboard: async () => ({
            success: false,
            acknowledged: false,
            error: reason,
            totalTimeMs: 1,
          }),
        }),
        undefined,
        new FakeTimer(),
      );
      expect(await clipboard.execute("paste")).toEqual({
        success: false,
        action: "paste",
        method: "adb",
        error:
          failure === "unimplemented"
            ? `cmd clipboard is not supported on this device/API level (CtrlProxy: ${reason})`
            : `ADB clipboard operation failed: ${errorMessage(rejection)}`,
      });
      expect(adb.getExecutedCommands()).toEqual([command]);
    },
  );

  test.each(["acknowledged", "unacknowledged", "throw"] as const)(
    "get failure: %s never falls back to adb",
    async (failure) => {
      const adb = new FakeAdbExecutor();
      const reason = "Clipboard read is restricted";
      const clipboard = new Clipboard(
        androidDevice,
        new FakeAdbClientFactory(adb),
        () => ({
          requestClipboard: async (_action, _text, _timeout, _perf, _signal, onDispatch) => {
            onDispatch?.();
            if (failure === "throw") {
              throw new Error(reason);
            }
            return {
              success: false,
              acknowledged: failure === "acknowledged",
              error: reason,
              totalTimeMs: 1,
            };
          },
        }),
        undefined,
        new FakeTimer(),
      );
      expect(await clipboard.execute("get")).toEqual({
        success: false,
        action: "get",
        method: "a11y",
        error: failure === "throw" ? `Accessibility clipboard get failed: ${reason}` : reason,
      });
      expect(adb.getExecutedCommands()).toEqual([]);
    },
  );

  test.each(["copy", "clear", "paste", "get"] as const)(
    "CtrlProxy %s success is unchanged",
    async (action) => {
      const adb = new FakeAdbExecutor();
      const clipboard = new Clipboard(
        androidDevice,
        new FakeAdbClientFactory(adb),
        () => ({
          requestClipboard: async (_action, _text, _timeout, _perf, _signal, onDispatch) => {
            onDispatch?.();
            return { success: true, acknowledged: true, text: "hello", totalTimeMs: 1 };
          },
        }),
        undefined,
        new FakeTimer(),
      );
      expect(await clipboard.execute(action, "x")).toEqual({
        success: true,
        action,
        text: "hello",
        method: "a11y",
      });
      expect(adb.getExecutedCommands()).toEqual([]);
    },
  );

  // Regression for https://github.com/kaeawc/auto-mobile/issues/2227.
  // AndroidCtrlProxyClient.getInstance expects an AdbClientFactory and calls
  // `.create(device)` on it. Passing the resolved AdbExecutor instead
  // surfaces in production as `TypeError: <minified>.create is not a function`
  // and silently breaks the a11y clipboard path.
  test("passes the injected AdbClientFactory (not AdbExecutor) to AndroidCtrlProxyClient.getInstance", async () => {
    const factory = new FakeAdbClientFactory();
    let passedFactory: FakeAdbClientFactory | undefined;
    const clipboard = new Clipboard(androidDevice, factory, (_device, adbFactory) => {
      passedFactory = adbFactory as FakeAdbClientFactory;
      return {
        requestClipboard: async () => ({ success: true, action: "copy", totalTimeMs: 1 }),
      };
    });

    await clipboard.execute("copy", "hello");

    expect(passedFactory).toBeDefined();
    expect(typeof passedFactory!.create).toBe("function");
    expect(passedFactory).toBe(factory);
    expect(factory.wasCalledForDevice(androidDevice.deviceId)).toBe(true);
  });

  test("get returns accessibility restriction error without ADB fallback when Android denies clipboard reads", async () => {
    const factory = new FakeAdbClientFactory();
    const fakeAdb = factory.getFakeClient();
    const clipboard = new Clipboard(androidDevice, factory, () => ({
      requestClipboard: async () => ({
        success: false,
        action: "get",
        totalTimeMs: 1,
        error: "Clipboard read is restricted while CtrlProxy is not foreground",
      }),
    }));
    const result = await clipboard.execute("get");

    expect(result.success).toBe(false);
    expect(result.action).toBe("get");
    expect(result.method).toBe("a11y");
    expect(result.error).toContain("Clipboard read is restricted");
    expect(fakeAdb.getAllCommands()).not.toContain("shell cmd clipboard get");
  });

  test("get returns default accessibility error when Android read fails without details", async () => {
    const factory = new FakeAdbClientFactory();
    const fakeAdb = factory.getFakeClient();
    const clipboard = new Clipboard(androidDevice, factory, () => ({
      requestClipboard: async () => ({
        success: false,
        action: "get",
        totalTimeMs: 1,
      }),
    }));
    const result = await clipboard.execute("get");

    expect(result.success).toBe(false);
    expect(result.error).toBe("Accessibility clipboard get failed");
    expect(result.method).toBe("a11y");
    expect(fakeAdb.getAllCommands()).not.toContain("shell cmd clipboard get");
  });

  test("get does not use unsupported cmd clipboard fallback for an empty accessibility read", async () => {
    const factory = new FakeAdbClientFactory();
    const fakeAdb = factory.getFakeClient();
    fakeAdb.setCommandResult("shell cmd clipboard get", "No shell command implementation");
    const clipboard = new Clipboard(androidDevice, factory, () => ({
      requestClipboard: async () => ({
        success: true,
        action: "get",
        text: "",
        totalTimeMs: 1,
      }),
    }));
    const result = await clipboard.execute("get");

    expect(result.success).toBe(true);
    expect(result.action).toBe("get");
    expect(result.text).toBe("");
    expect(result.method).toBe("a11y");
    expect(fakeAdb.getAllCommands()).not.toContain("shell cmd clipboard get");
  });
});

describe("Clipboard iOS dispatch outcomes", () => {
  const device: BootedDevice = { platform: "ios", deviceId: "clipboard-ios", name: "iPhone" };

  test.each(["timeout", "socket closed", "abort", "refusal", "success", "before dispatch"])(
    "paste: %s",
    async (outcome) => {
      const controller = new AbortController();
      const reason = outcome === "timeout" ? "Clipboard operation timed out after 5000ms" : outcome;
      const clipboard = new Clipboard(
        device,
        new FakeAdbClientFactory(),
        () => ({
          requestClipboard: async (action, _text, _timeout, _perf, signal, onDispatch) => {
            if (action === "get") {
              return { success: true, text: "", totalTimeMs: 0 };
            }
            expect(signal).toBe(controller.signal);
            if (outcome !== "before dispatch") {
              onDispatch?.();
            }
            if (outcome === "abort") {
              await Promise.resolve();
              controller.abort(new Error(reason));
              throw controller.signal.reason;
            }
            if (outcome === "socket closed") {
              throw new Error(reason);
            }
            return {
              success: outcome === "success",
              acknowledged: outcome === "refusal" || outcome === "success",
              error: reason,
              totalTimeMs: 0,
            };
          },
        }),
        new FakeKeyboardHierarchyProvider(),
        new FakeTimer(),
      );
      const result = await clipboard.execute("paste", undefined, controller.signal);
      if (["timeout", "socket closed", "abort"].includes(outcome)) {
        expect(result).toEqual({
          success: false,
          action: "paste",
          method: "a11y",
          error: `Paste outcome is indeterminate: the request was dispatched but no result was confirmed (${outcome === "abort" ? "Operation cancelled" : reason}). The paste may have been applied. Do not retry automatically. Observe before retrying.`,
        });
      } else if (outcome === "success") {
        expect(result).toEqual({ success: true, action: "paste", method: "a11y", text: undefined });
      } else {
        expect(result).toEqual({ success: false, action: "paste", error: reason });
      }
    },
  );

  test.each([IosRunnerBusyError, IosRunnerStalledError])(
    "paste: %p is a plain refusal without replay",
    async (BusyError) => {
      let pasteRequests = 0;
      const clipboard = new Clipboard(device, new FakeAdbClientFactory(), () => ({
        requestClipboard: async (action, _text, _timeout, _perf, _signal, onDispatch) => {
          if (action === "get") {
            return { success: true, text: "", totalTimeMs: 0 };
          }
          pasteRequests++;
          onDispatch?.();
          throw new BusyError("runner busy");
        },
      }));
      const result = await clipboard.execute("paste");
      expect(result).toEqual({ success: false, action: "paste", error: "runner busy" });
      expect(pasteRequests).toBe(1);
    },
  );

  test("already aborted paste does not invoke the client", async () => {
    let requests = 0;
    const controller = new AbortController();
    const reason = new Error("cancelled");
    controller.abort(reason);
    const clipboard = new Clipboard(device, new FakeAdbClientFactory(), () => ({
      requestClipboard: async () => {
        requests++;
        return { success: true, totalTimeMs: 0 };
      },
    }));
    await expect(clipboard.execute("paste", undefined, controller.signal)).rejects.toThrow(
      "Operation cancelled",
    );
    expect(requests).toBe(0);
  });

  test.each(["copy", "clear", "get"] as const)(
    "%s remains a plain failure after dispatch without acknowledgement",
    async (action) => {
      const clipboard = new Clipboard(device, new FakeAdbClientFactory(), () => ({
        requestClipboard: async (_action, _text, _timeout, _perf, _signal, onDispatch) => {
          onDispatch?.();
          return { success: false, acknowledged: false, error: "timeout", totalTimeMs: 0 };
        },
      }));
      expect(await clipboard.execute(action, "hello")).toEqual({
        success: false,
        action,
        error: "timeout",
      });
    },
  );
});
