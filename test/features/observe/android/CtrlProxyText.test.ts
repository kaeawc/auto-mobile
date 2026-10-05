import { createIosDelegateHarness } from "../../../helpers/iosDelegateHarness";
import {
  runWithTextRequestContext,
  TextRequestState,
} from "../../../../src/features/action/textTransportTimeout";
import { describe, expect, test } from "bun:test";
import type WebSocket from "ws";
import { AndroidCtrlProxyClient } from "../../../../src/features/observe/android";
import {
  CtrlProxyText,
  imeCommitSegmentCount,
  imeCommitSubsequenceMatches,
  imeCommitSuffixMatches,
  imeCommitTimeoutMs,
} from "../../../../src/features/observe/android/CtrlProxyText";
import type { DelegateContext } from "../../../../src/features/observe/android/types";
import type { BootedDevice } from "../../../../src/models";
import { RequestManager } from "../../../../src/utils/RequestManager";
import { FakeAdbExecutor } from "../../../fakes/FakeAdbExecutor";
import { FakeTimer } from "../../../fakes/FakeTimer";
import { FakeWebSocket, WebSocketState } from "../../../fakes/FakeWebSocket";

class CapturingWebSocket extends FakeWebSocket {
  sentMessages: string[] = [];

  send(data: unknown): void {
    this.sentMessages.push(String(data));
    super.send(data);
  }
}

async function waitForSocketOpen(socket: CapturingWebSocket): Promise<void> {
  if (socket.readyState === WebSocketState.OPEN) {
    return;
  }
  await new Promise<void>((resolve) => socket.once("open", () => resolve()));
}

async function waitForRequest(
  socket: CapturingWebSocket,
  type: string,
): Promise<Record<string, unknown>> {
  for (let attempt = 0; attempt < 10; attempt++) {
    for (const message of socket.sentMessages) {
      const parsed = JSON.parse(message) as Record<string, unknown>;
      if (parsed.type === type) {
        return parsed;
      }
    }
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error(`No message of type ${type} in: ${socket.sentMessages.join(", ")}`);
}

async function waitForSent(sent: Record<string, unknown>[], count: number): Promise<void> {
  for (let attempt = 0; attempt < 10 && sent.length < count; attempt++) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  expect(sent.length).toBeGreaterThanOrEqual(count);
}

describe("Android CtrlProxyText", () => {
  test.each([
    ["١٢٣", "123"],
    ["१२३", "123"],
    ["𝟙𝟚𝟛", "123"],
    ["123", "١٢٣"],
    ["STRASSE", "straße"],
    ["e\u0301", "é"],
    ["é", "e\u0301"],
  ])("accepts normalized IME text: field=%s sent=%s", (field, sent) => {
    expect(imeCommitSubsequenceMatches(field, sent)).toBe(true);
  });

  test.each([
    ["7", "007"],
    ["😀", ":)"],
    ["İ", "i"],
  ])("rejects rewritten IME content: field=%s sent=%s", (field, sent) => {
    expect(imeCommitSubsequenceMatches(field, sent)).toBe(false);
  });

  test.each([
    ["(555) 123-4567", "5551234567", true],
    ["(555) 123-45", "5551234567", false],
    ["5551234567", "5551234567", true],
    ["555-0", "5550142", false],
    ["555-0142", "5550142", true],
    ["55-0142", "5550142", false],
    ["ba", "ab", false],
    ["anything", "", true],
    ["", "", true],
    ["", "5", false],
    ["prefix 😀-𐐀 tail", "😀𐐀", true],
    ["prefix 😀 tail", "😀𐐀", false],
    ["\ud83d-\ude00", "😀", false],
    ["e-\u0301", "e\u0301", true],
    ["ABC", "abc", true],
    ["5550142", "555-0142", true],
    ["helo", "hello", false],
    ["HELO", "HeLLo", false],
    ["HEL O", "hello", false],
    ["5551234567", "(555) 123-4567", true],
    ["𐐨", "𐐀", true],
    ["E\u0301", "e\u0301", true],
    ["e", "e\u0301", false],
    ["𐐀", "😀𐐀", true],
    ["1٢Ⅲ", "1-٢ Ⅲ", true],
    ["prefix !-!-! tail", "!!!", true],
    ["", "!!!", false],
    ["!!", "!!!", false],
    ["", "---", false],
    ["---", "---", true],
    ["???", "!!!", false],
    ["İ", "İ", true],
    ["i\u0307", "İ", false],
    ["i", "İ", false],
    ["İ", "i\u0307", false],
  ] as const)("checks IME subsequence: field=%s sent=%s", (fieldText, text, matches) => {
    expect(imeCommitSubsequenceMatches(fieldText, text)).toBe(matches);
  });

  test.each([
    ["prefix one *bold* two `code` tail", true],
    ["prefix one bold two code tail", true],
    ["prefix one bold two `code` tail", true],
    ["prefix one *bold* two `code` tai", false],
    ["prefix one bold two `code` tai", false],
    ["prefix one bold two code tai", false],
    ["one bold two code tail suffix", false],
    ["", false],
  ])("checks literal and projected IME suffixes: %s", (fieldText, matches) => {
    expect(imeCommitSuffixMatches(fieldText, "one *bold* two `code` tail")).toBe(matches);
  });

  test.each(["*x*", "**x**", "_x_", "~x~", "~~x~~", "`x`", "```x```"])(
    "projects the inline-format marker set: %s",
    (span) => {
      expect(imeCommitSuffixMatches("prefix x tail", `${span} tail`)).toBe(true);
      expect(imeCommitSuffixMatches(`prefix ${span} tail`, "x tail")).toBe(true);
      expect(imeCommitSuffixMatches("prefix x tai", `${span} tail`)).toBe(false);
    },
  );

  test.each(["", "```", "``````", "*_~`"])(
    "reports marker-only IME suffixes as unverifiable: %s",
    (text) => {
      expect(imeCommitSuffixMatches("prefix", text)).toBeUndefined();
      expect(imeCommitSuffixMatches(`prefix${text}`, text)).toBeUndefined();
    },
  );

  test("preserves non-marker suffix characters and whitespace", () => {
    expect(imeCommitSuffixMatches("prefix x # [] ", "*x* # [] ")).toBe(true);
    expect(imeCommitSuffixMatches("prefix x # []", "*x* # [] ")).toBe(false);
    expect(imeCommitSuffixMatches("prefix x  ", "*x* # [] ")).toBe(false);
  });

  test("scales commit timeout by spans and characters within the tool budget", async () => {
    const timer = new FakeTimer();
    const socket = new CapturingWebSocket("ws://localhost", "none", 0, timer);
    await waitForSocketOpen(socket);
    const requestManager = new RequestManager(timer);
    const context: DelegateContext = {
      getWebSocket: () => socket as unknown as WebSocket,
      requestManager,
      timer,
      ensureConnected: async () => true,
      cancelScreenshotBackoff: () => {},
    };
    const text = "one *bold* two `code` tail";
    expect(imeCommitSegmentCount(text)).toBe(3);
    const expected = 10_000 + 750 * 2 + 20 * text.length;
    expect(imeCommitTimeoutMs(text)).toBe(expected);
    expect(imeCommitTimeoutMs("*x* ".repeat(100))).toBe(25_000);

    const resultPromise = new CtrlProxyText(context).commitViaIme(text);
    const request = await waitForRequest(socket, "request_commit_text");
    expect(timer.getPendingTimeouts()).toContain(expected);
    requestManager.resolve(request.requestId as string, { success: true });
    expect(await resultPromise).toMatchObject({ success: true });
    expect(timer.getPendingTimeoutCount()).toBe(0);
  });

  test("commit timeout reports unknown editor state", async () => {
    const timer = new FakeTimer();
    const requestManager = new RequestManager(timer);
    const sent: Record<string, unknown>[] = [];
    const context: DelegateContext = {
      getWebSocket: () =>
        ({ readyState: 1, send: (data: string) => sent.push(JSON.parse(data)) }) as any,
      requestManager,
      timer,
      ensureConnected: async () => true,
      cancelScreenshotBackoff: () => {},
    };

    const resultPromise = new CtrlProxyText(context).commitViaIme("text", "prior");
    await waitForSent(sent, 1);
    timer.advanceTime(imeCommitTimeoutMs("text"));
    await waitForSent(sent, 2);
    timer.advanceTime(2_000);

    expect(await resultPromise).toMatchObject({
      success: false,
      partialApplication: true,
      sessionUnsafe: true,
      error: expect.stringContaining("cancellation was not acknowledged"),
    });
  });

  test("timed-out commit waits for a correlated cancel acknowledgement", async () => {
    const timer = new FakeTimer();
    const sent: Record<string, unknown>[] = [];
    const manager = new RequestManager(timer);
    const context: DelegateContext = {
      getWebSocket: () =>
        ({ readyState: 1, send: (data: string) => sent.push(JSON.parse(data)) }) as any,
      requestManager: manager,
      timer,
      ensureConnected: async () => true,
      cancelScreenshotBackoff: () => {},
    };
    const resultPromise = new CtrlProxyText(context).commitViaIme("text", "prior");
    await waitForSent(sent, 1);
    const commit = sent[0]!;
    timer.advanceTime(imeCommitTimeoutMs("text"));
    await waitForSent(sent, 2);
    const cancel = sent[1]!;
    expect(cancel).toMatchObject({
      type: "request_cancel_ime_commit",
      targetRequestId: commit.requestId,
    });
    manager.resolve(cancel.requestId as string, {
      success: true,
      targetRequestId: commit.requestId,
      partialApplication: true,
    });
    expect(await resultPromise).toMatchObject({ success: false, partialApplication: true });
    expect((await resultPromise).sessionUnsafe).toBeUndefined();
  });

  test.each([true, false])(
    "caller abort waits for cancellation acknowledgement=%s",
    async (acknowledged) => {
      const timer = new FakeTimer();
      const socket = new CapturingWebSocket("ws://localhost", "none", 0, timer);
      await waitForSocketOpen(socket);
      const manager = new RequestManager(timer);
      const context: DelegateContext = {
        getWebSocket: () => socket as unknown as WebSocket,
        requestManager: manager,
        timer,
        ensureConnected: async () => true,
        cancelScreenshotBackoff: () => {},
      };
      const controller = new AbortController();
      let settled = false;
      const promise = new CtrlProxyText(context).commitViaIme(
        "text",
        "prior",
        undefined,
        undefined,
        controller.signal,
      );
      void promise.then(() => {
        settled = true;
      });
      const commit = await waitForRequest(socket, "request_commit_text");
      controller.abort();
      const cancel = await waitForRequest(socket, "request_cancel_ime_commit");
      expect(cancel.targetRequestId).toBe(commit.requestId);
      expect(settled).toBe(false);
      timer.advanceTime(1_999);
      await Promise.resolve();
      expect(settled).toBe(false);
      if (acknowledged) {
        manager.resolve(cancel.requestId as string, {
          success: true,
          targetRequestId: commit.requestId,
          partialApplication: true,
          committedUnits: 2,
        });
      } else {
        timer.advanceTime(1);
      }
      const result = await promise;
      expect(result).toMatchObject({ success: false, partialApplication: true });
      expect(result.sessionUnsafe).toBe(acknowledged ? undefined : true);
      expect(result.committedUnits).toBe(acknowledged ? 2 : undefined);
      expect(timer.getPendingTimeoutCount()).toBe(0);
      socket.close();
    },
  );

  test("sends request_insert_text and resolves its result", async () => {
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const sent: string[] = [];
    const requestManager = new RequestManager(timer);
    const context: DelegateContext = {
      getWebSocket: () =>
        ({
          readyState: 1,
          send: (data: string) => sent.push(data),
        }) as any,
      requestManager,
      timer,
      ensureConnected: async () => true,
      cancelScreenshotBackoff: () => {},
    };
    const delegate = new CtrlProxyText(context);

    const resultPromise = delegate.requestInsertText("value");
    await Promise.resolve();
    await Promise.resolve();
    const request = JSON.parse(sent[0] ?? "{}") as Record<string, unknown>;
    requestManager.resolve(request.requestId as string, { success: true, totalTimeMs: 2 });

    expect(request).toMatchObject({
      type: "request_insert_text",
      text: "value",
    });
    expect(await resultPromise).toMatchObject({ success: true, totalTimeMs: 2 });
  });

  test("requests a versioned keyboard profile catalog", async () => {
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const sent: string[] = [];
    const requestManager = new RequestManager(timer);
    const context: DelegateContext = {
      getWebSocket: () => ({ readyState: 1, send: (data: string) => sent.push(data) }) as any,
      requestManager,
      timer,
      ensureConnected: async () => true,
      cancelScreenshotBackoff: () => {},
    };
    const resultPromise = new CtrlProxyText(context).listKeyboardProfiles();
    await Promise.resolve();
    await Promise.resolve();
    const request = JSON.parse(sent[0] ?? "{}") as Record<string, unknown>;
    requestManager.resolve(request.requestId as string, {
      success: true,
      catalogId: "automobile_behavior_profiles",
      catalogVersion: 1,
      supportedCatalogVersions: [1],
      activeProfileId: "gboard",
      profiles: [],
    });

    expect(request).toMatchObject({
      type: "request_list_keyboard_profiles",
      supportedCatalogVersions: [1],
    });
    expect(await resultPromise).toMatchObject({
      success: true,
      catalogId: "automobile_behavior_profiles",
      catalogVersion: 1,
      activeProfileId: "gboard",
    });
  });

  test("resolves commitViaIme from a commit_text_result frame", async () => {
    const timer = new FakeTimer();
    const fakeAdb = new FakeAdbExecutor();
    fakeAdb.setCommandResponse("forward", { stdout: "8765", stderr: "" });
    fakeAdb.setScreenState(true);
    const device: BootedDevice = {
      deviceId: "test-device-commit-text",
      platform: "android",
      isEmulator: true,
      name: "Test Device",
    };
    let socket: CapturingWebSocket | null = null;
    const client = AndroidCtrlProxyClient.createForTesting(
      device,
      fakeAdb,
      (url: string) => {
        socket = new CapturingWebSocket(url, "none", 0, timer);
        return socket;
      },
      timer,
    );

    try {
      expect(await client.ensureConnected()).toBe(true);
      if (!socket) {
        throw new Error("Expected the WebSocket factory to create a socket");
      }
      await waitForSocketOpen(socket);

      const textDelegate = (client as unknown as { text: CtrlProxyText }).text;
      const resultPromise = textDelegate.commitViaIme("value", "prior-ime");
      const request = await waitForRequest(socket, "request_commit_text");
      expect(request).toMatchObject({
        type: "request_commit_text",
        text: "value",
        priorImeId: "prior-ime",
      });
      expect(request.requestId).toStartWith("commitText_");

      socket.simulateMessage(
        JSON.stringify({
          type: "commit_text_result",
          timestamp: 1,
          requestId: request.requestId,
          success: true,
          totalTimeMs: 3,
        }),
      );

      expect(await resultPromise).toEqual({
        success: true,
        totalTimeMs: 3,
        error: undefined,
        partialApplication: undefined,
        perfTiming: undefined,
      });

      socket.sentMessages.length = 0;
      const eventPromise = textDelegate.commitViaIme(
        "Ab!",
        "prior-ime",
        10000,
        undefined,
        undefined,
        "keyEvents",
      );
      const eventRequest = await waitForRequest(socket, "request_commit_text");
      expect(eventRequest.delivery).toBe("keyEvents");
      socket.simulateMessage(
        JSON.stringify({
          type: "commit_text_result",
          timestamp: 2,
          requestId: eventRequest.requestId,
          success: true,
          totalTimeMs: 3,
          committedUnits: 3,
        }),
      );
      expect(await eventPromise).toMatchObject({ success: true, committedUnits: 3 });

      socket.sentMessages.length = 0;
      const failed = textDelegate.commitViaIme("long text", "prior-ime");
      const failedRequest = await waitForRequest(socket, "request_commit_text");
      socket.simulateMessage(
        JSON.stringify({
          type: "commit_text_result",
          timestamp: 2,
          requestId: failedRequest.requestId,
          success: false,
          // Flat payload emitted by CtrlProxy.kt broadcastCommitTextResult.
          error: "IME commit deadline exceeded",
          totalTimeMs: 4000,
          partialApplication: true,
          committedUnits: 3,
        }),
      );
      expect(await failed).toMatchObject({
        success: false,
        partialApplication: true,
        committedUnits: 3,
      });

      socket.sentMessages.length = 0;
      const controller = new AbortController();
      const aborted = textDelegate.commitViaIme(
        "text",
        "prior-ime",
        undefined,
        undefined,
        controller.signal,
      );
      const abortedRequest = await waitForRequest(socket, "request_commit_text");
      controller.abort();
      const cancelRequest = await waitForRequest(socket, "request_cancel_ime_commit");
      // Flat payload emitted by CtrlProxy.kt requestCancelImeCommit, not nested data.
      socket.simulateMessage(
        JSON.stringify({
          type: "cancel_ime_commit_result",
          timestamp: 3,
          requestId: cancelRequest.requestId,
          success: true,
          targetRequestId: abortedRequest.requestId,
          partialApplication: true,
          committedUnits: 2,
        }),
      );
      expect(await aborted).toMatchObject({
        success: false,
        partialApplication: true,
        committedUnits: 2,
      });
    } finally {
      await client.close();
    }
  });

  test("resolves setKeyboardProfile from a set_keyboard_profile_result frame", async () => {
    const timer = new FakeTimer();
    const fakeAdb = new FakeAdbExecutor();
    fakeAdb.setCommandResponse("forward", { stdout: "8765", stderr: "" });
    fakeAdb.setScreenState(true);
    const device: BootedDevice = {
      deviceId: "test-device-profile",
      platform: "android",
      isEmulator: true,
      name: "Test Device",
    };
    let socket: CapturingWebSocket | null = null;
    const client = AndroidCtrlProxyClient.createForTesting(
      device,
      fakeAdb,
      (url: string) => {
        socket = new CapturingWebSocket(url, "none", 0, timer);
        return socket;
      },
      timer,
    );
    try {
      expect(await client.ensureConnected()).toBe(true);
      if (!socket) {
        throw new Error("Expected the WebSocket factory to create a socket");
      }
      await waitForSocketOpen(socket);
      const resultPromise = client.setKeyboardProfile("samsung");
      const request = await waitForRequest(socket, "request_set_keyboard_profile");
      expect(request).toMatchObject({ profileId: "samsung" });
      expect(request.requestId).toStartWith("setKeyboardProfile_");
      socket.simulateMessage(
        JSON.stringify({
          type: "set_keyboard_profile_result",
          timestamp: 1,
          requestId: request.requestId,
          success: true,
          activeProfileId: "samsung",
          previousProfileId: "direct",
        }),
      );
      expect(await resultPromise).toEqual({
        success: true,
        activeProfileId: "samsung",
        previousProfileId: "direct",
        error: undefined,
      });
    } finally {
      await client.close();
    }
  });

  test("resolves listKeyboardProfiles from a versioned catalog result", async () => {
    const timer = new FakeTimer();
    const fakeAdb = new FakeAdbExecutor();
    fakeAdb.setCommandResponse("forward", { stdout: "8765", stderr: "" });
    fakeAdb.setScreenState(true);
    const device: BootedDevice = {
      deviceId: "test-device-profile-catalog",
      platform: "android",
      isEmulator: true,
      name: "Test Device",
    };
    let socket: CapturingWebSocket | null = null;
    const client = AndroidCtrlProxyClient.createForTesting(
      device,
      fakeAdb,
      (url: string) => {
        socket = new CapturingWebSocket(url, "none", 0, timer);
        return socket;
      },
      timer,
    );
    try {
      expect(await client.ensureConnected()).toBe(true);
      if (!socket) {
        throw new Error("Expected the WebSocket factory to create a socket");
      }
      await waitForSocketOpen(socket);
      const resultPromise = client.listKeyboardProfiles();
      const request = await waitForRequest(socket, "request_list_keyboard_profiles");
      expect(request).toMatchObject({ supportedCatalogVersions: [1] });
      socket.simulateMessage(
        JSON.stringify({
          type: "keyboard_profiles_result",
          timestamp: 1,
          requestId: request.requestId,
          success: true,
          catalogId: "automobile_behavior_profiles",
          catalogVersion: 1,
          supportedCatalogVersions: [1],
          activeProfileId: "samsung",
          profiles: [
            {
              id: "samsung",
              displayName: "Samsung",
              version: 1,
              evidenceStatus: "experimental",
              evidenceNote: "Real-device comparison remains pending.",
              behavior: {
                composeWords: true,
                enterStrategy: "COMMIT_NEWLINE",
                backspaceStrategy: "DELETE_SURROUNDING",
                recomposeOnCursorMove: true,
                recomposeOnBackspaceIntoWord: true,
                batchEdits: false,
              },
            },
          ],
        }),
      );
      expect(await resultPromise).toMatchObject({
        catalogId: "automobile_behavior_profiles",
        catalogVersion: 1,
        activeProfileId: "samsung",
        profiles: [{ id: "samsung", evidenceStatus: "experimental" }],
      });
    } finally {
      await client.close();
    }
  });
});

test("sends expectedSuffix only when provided and resolves insert metadata", async () => {
  const timer = new FakeTimer();
  const socket = new CapturingWebSocket("ws://localhost", "none", 0, timer);
  await waitForSocketOpen(socket);
  const requestManager = new RequestManager(timer);
  const context: DelegateContext = {
    getWebSocket: () => socket as unknown as WebSocket,
    requestManager,
    timer,
    ensureConnected: async () => true,
    cancelScreenshotBackoff: () => {},
  };
  const delegate = new CtrlProxyText(context);
  for (const suffix of ["x", undefined, ""]) {
    socket.sentMessages.length = 0;
    const resultPromise = delegate.requestInsertText("value", undefined, undefined, {
      expectedSuffix: suffix,
    });
    const request = await waitForRequest(socket, "request_insert_text");
    expect(request.acceptsCaretNotPlaced).toBe(true);
    if (suffix) {
      expect(request.expectedSuffix).toBe(suffix);
    } else {
      expect(request).not.toHaveProperty("expectedSuffix");
    }
    const metadata = {
      success: true,
      warning: "caret warning",
      caretPlaced: false,
      resultingTextLength: 5,
    };
    requestManager.resolve(request.requestId as string, metadata);
    expect(await resultPromise).toEqual(metadata);
  }
  socket.close();
});

test("client insert_text_result projection preserves optional fields and old APK responses", async () => {
  const timer = new FakeTimer();
  const adb = new FakeAdbExecutor();
  adb.setCommandResponse("forward", { stdout: "8765", stderr: "" });
  adb.setScreenState(true);
  const device: BootedDevice = {
    deviceId: "insert-projection",
    platform: "android",
    name: "Test Device",
  };
  let socket: CapturingWebSocket | null = null;
  const client = AndroidCtrlProxyClient.createForTesting(
    device,
    adb,
    (url: string) => {
      socket = new CapturingWebSocket(url, "none", 0, timer);
      return socket;
    },
    timer,
  );
  try {
    expect(await client.ensureConnected()).toBe(true);
    if (!socket) {
      throw new Error("Expected a socket");
    }
    await waitForSocketOpen(socket);
    for (const metadata of [
      { warning: "caret warning", caretPlaced: false, resultingTextLength: 5 },
      {},
    ]) {
      socket.sentMessages.length = 0;
      const promise = client.requestInsertText("value", undefined, undefined, {
        expectedSuffix: "x",
      });
      const request = await waitForRequest(socket, "request_insert_text");
      expect(request.expectedSuffix).toBe("x");
      socket.simulateMessage(
        JSON.stringify({
          type: "insert_text_result",
          timestamp: 1,
          requestId: request.requestId,
          success: true,
          totalTimeMs: 3,
          ...metadata,
        }),
      );
      const result = await promise;
      expect(result).toEqual({
        success: true,
        totalTimeMs: 3,
        error: undefined,
        partialApplication: undefined,
        perfTiming: undefined,
        warning: undefined,
        caretPlaced: undefined,
        resultingTextLength: undefined,
        ...metadata,
      });
    }
  } finally {
    await client.close();
  }
});

test("insert caret-warning acceptance defaults on and can explicitly opt out for compatibility", async () => {
  const timer = new FakeTimer();
  const socket = new CapturingWebSocket("ws://localhost", "none", 0, timer);
  await waitForSocketOpen(socket);
  const requestManager = new RequestManager(timer);
  const delegate = new CtrlProxyText({
    getWebSocket: () => socket as unknown as WebSocket,
    requestManager,
    timer,
    ensureConnected: async () => true,
    cancelScreenshotBackoff: () => {},
  });
  for (const acceptsCaretNotPlaced of [undefined, true, false]) {
    socket.sentMessages.length = 0;
    const pending = delegate.requestInsertText(
      "é",
      undefined,
      undefined,
      acceptsCaretNotPlaced === undefined ? undefined : { acceptsCaretNotPlaced },
    );
    const request = await waitForRequest(socket, "request_insert_text");
    expect(request.acceptsCaretNotPlaced).toBe(acceptsCaretNotPlaced ?? true);
    const response =
      acceptsCaretNotPlaced === false
        ? {
            success: false,
            partialApplication: true,
            error: "Text was inserted, but ACTION_SET_SELECTION returned false; do not retry",
          }
        : { success: true, warning: "caret could not be placed", caretPlaced: false };
    requestManager.resolve(request.requestId as string, response);
    expect(await pending).toEqual(response);
  }
  socket.close();
});

test("pre-dispatch state read round-trips and insert baseline is optional", async () => {
  const timer = new FakeTimer();
  const adb = new FakeAdbExecutor();
  adb.setCommandResponse("forward tcp:9008 tcp:9008", "");
  const device: BootedDevice = {
    deviceId: "baseline-device",
    platform: "android",
    name: "Test Device",
  };
  let socket: CapturingWebSocket | null = null;
  const client = AndroidCtrlProxyClient.createForTesting(
    device,
    adb,
    (url: string) => {
      socket = new CapturingWebSocket(url, "none", 0, timer);
      return socket;
    },
    timer,
  );
  try {
    expect(await client.ensureConnected()).toBe(true);
    if (!socket) {
      throw new Error("Expected a socket");
    }
    socket.simulateMessage(
      JSON.stringify({
        type: "connected",
        supportedCommands: ["request_insert_text_state", "request_insert_text"],
      }),
    );
    const promise = client.requestInsertTextState();
    const request = await waitForRequest(socket, "request_insert_text_state");
    const state = { text: "éx", isShowingHintText: false, selectionStart: 2, selectionEnd: 2 };
    socket.simulateMessage(
      JSON.stringify({
        type: "insert_text_state_result",
        requestId: request.requestId,
        success: true,
        state,
      }),
    );
    expect(await promise).toEqual({ success: true, state });
    for (const precedingState of [state, undefined]) {
      socket.sentMessages.length = 0;
      const insert = client.requestInsertText("😀", undefined, undefined, {
        expectedSuffix: "x",
        precedingState,
      });
      const wire = await waitForRequest(socket, "request_insert_text");
      if (precedingState) {
        expect(wire.precedingState).toEqual(state);
      } else {
        expect(wire).not.toHaveProperty("precedingState");
      }
      socket.simulateMessage(
        JSON.stringify({
          type: "insert_text_result",
          requestId: wire.requestId,
          success: true,
          totalTimeMs: 1,
        }),
      );
      expect(await insert).toMatchObject({ success: true });
    }
    socket.sentMessages.length = 0;
    socket.simulateMessage(JSON.stringify({ type: "connected", supportedCommands: [] }));
    expect(await client.requestInsertTextState()).toEqual({ success: true });
    expect(socket.sentMessages).toEqual([]);
  } finally {
    await client.close();
  }
});

test("Android text keeps its 5000ms transport and plain failure under an iOS request budget", async () => {
  const h = createIosDelegateHarness();
  const state = new TextRequestState();
  const deadline = h.timer.now() + 2000;
  const pending = runWithTextRequestContext(
    { textState: state, getDeadlineMs: () => deadline },
    () => new CtrlProxyText(h.context).requestSetText("a".repeat(1000)),
  );
  await new Promise<void>((resolve) => setImmediate(resolve));
  h.advanceTime(2000);
  expect(h.requestManager.getPendingCount()).toBe(1);
  h.advanceTime(3000);
  expect(await pending).toEqual({
    success: false,
    totalTimeMs: 5000,
    error: "Set text timed out after 5000ms",
  });
  expect(state.timeoutError("expired")).toBeUndefined();
});
