import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  readOpenSmartStack,
  tapSmartStackAt,
  tapSmartStackOn,
} from "../../../src/features/watch/WatchSmartStackTap";
import { FakeWatchRunnerClient } from "../../fakes/FakeWatchRunnerClient";
import type {
  WatchCommand,
  WatchRunnerClient,
} from "../../../src/features/watch/WatchRunnerClient";
import { FakeTimer } from "../../fakes/FakeTimer";
import { ActionableError } from "../../../src/models/ActionableError";

const stackDump = readFileSync(
  new URL("../../fixtures/watch/fixture-face-dump-smartstack.txt", import.meta.url),
  "utf8",
);
const textDump = readFileSync(
  new URL("../../fixtures/watch/fixture-face-smartstack-after-reload.txt", import.meta.url),
  "utf8",
);
const hostDump = readFileSync(
  new URL("../../fixtures/watch/fixture-face-dump-host-foreground.txt", import.meta.url),
  "utf8",
);

class FaceDumpClient extends FakeWatchRunnerClient {
  constructor(
    private readonly dump: unknown = stackDump,
    private readonly probeError?: Error,
  ) {
    super();
  }
  override async request(
    command: WatchCommand,
    signal?: AbortSignal,
    options?: Parameters<WatchRunnerClient["request"]>[2],
  ): Promise<unknown> {
    const result = await super.request(command, signal, options);
    if (command.type === "face" && command.op === "dump") {
      if (this.probeError) {
        throw this.probeError;
      }
      return this.dump;
    }
    return result;
  }
}

describe("Smart Stack tap preflight", () => {
  test.each([stackDump, textDump])(
    "recognizes captured stack with an injected timestamp",
    async (dump) => {
      const client = new FaceDumpClient(dump);
      const timer = new FakeTimer();
      const signal = new AbortController().signal;
      const hierarchy = await readOpenSmartStack(client, () => timer.now(), signal);
      expect(hierarchy?.hierarchy).toMatchObject({
        screenWidth: 187,
        screenHeight: 223,
        updatedAt: timer.now(),
      });
      expect(client.commands).toEqual([{ type: "face", op: "dump" }]);
      expect(client.requestOptions).toEqual([{ timeoutMs: 2000 }]);
      expect(timer.getSleepHistory()).toEqual([]);
    },
  );
  test("host foreground capture has neither header nor cards", async () => {
    expect(await readOpenSmartStack(new FaceDumpClient(hostDump), () => 1)).toBeUndefined();
  });
  test.each(["unsupported face command", "Watch runner face timed out after 2000ms"])(
    "swallows optional probe failure: %s",
    async (message) => {
      expect(
        await readOpenSmartStack(new FaceDumpClient(stackDump, new Error(message)), () => 1),
      ).toBeUndefined();
    },
  );
  test.each(["invalid dump", undefined, {}])(
    "swallows malformed probe response %j",
    async (dump) => {
      // Null avoids the fake's default parameter for an absent response.
      expect(await readOpenSmartStack(new FaceDumpClient(dump ?? null), () => 1)).toBeUndefined();
    },
  );
});

describe("Smart Stack face taps", () => {
  test("normalizes widget center in points", async () => {
    const client = new FaceDumpClient();
    const hierarchy = await readOpenSmartStack(client, () => 1);
    expect(hierarchy).toBeDefined();
    await tapSmartStackAt(client, hierarchy!.hierarchy, { x: 93.5, y: 146.25 });
    expect(client.commands).toEqual([
      { type: "face", op: "dump" },
      { type: "face", op: "tap", x: 0.5, y: 146.25 / 223 },
    ]);
  });
  test.each([
    { x: 188, y: 10 },
    { x: 10, y: 224 },
    { x: -1, y: 1 },
    { x: NaN, y: 1 },
  ])("refuses out-of-screen point %j", async (point) => {
    const client = new FaceDumpClient();
    const hierarchy = await readOpenSmartStack(client, () => 1);
    await expect(tapSmartStackAt(client, hierarchy!.hierarchy, point)).rejects.toBeInstanceOf(
      ActionableError,
    );
    expect(client.commands).toEqual([{ type: "face", op: "dump" }]);
  });
  test("face tap failure propagates instead of retrying through the app", async () => {
    const client = new FaceDumpClient();
    const hierarchy = await readOpenSmartStack(client, () => 1);
    client.failure = new Error("face tap failed");
    await expect(
      tapSmartStackAt(client, hierarchy!.hierarchy, { x: 93.5, y: 146.25 }),
    ).rejects.toThrow("face tap failed");
    expect(client.commands).toEqual([
      { type: "face", op: "dump" },
      { type: "face", op: "tap", x: 0.5, y: 146.25 / 223 },
    ]);
  });
  test.each([
    { dump: textDump, selector: { text: "T28" } },
    {
      dump: stackDump,
      selector: {
        elementId:
          "StackCollectionViewComplicationCell -- 93A18F3B-D642-41DA-B6A4-F312ED9DB584 -- ProbeApp -- ProbeWidgetXYZ -- dev.probe.app -- dev.probe.app-dev.probe.app.widget-probe-0",
      },
    },
  ])("taps the card center and returns its cell for $selector", async ({ dump, selector }) => {
    const client = new FaceDumpClient(dump);
    const stack = await readOpenSmartStack(client, () => 1);
    const result = await tapSmartStackOn(client, stack!, { action: "tap", ...selector });
    expect(result).toMatchObject({
      success: true,
      action: "tap",
      element: {
        "resource-id":
          "StackCollectionViewComplicationCell -- 93A18F3B-D642-41DA-B6A4-F312ED9DB584 -- ProbeApp -- ProbeWidgetXYZ -- dev.probe.app -- dev.probe.app-dev.probe.app.widget-probe-0",
        bounds: { left: 5.5, top: 110, right: 181.5, bottom: 182.5 },
      },
    });
    expect(client.commands).toEqual([
      { type: "face", op: "dump" },
      { type: "face", op: "tap", x: 0.5, y: 146.25 / 223 },
    ]);
  });
  test("indexes matching cards rather than repeated cell-local text nodes", async () => {
    const client = new FaceDumpClient(textDump);
    const stack = await readOpenSmartStack(client, () => 1);
    // Give the system card the same text to exercise two matching cards in hierarchy order.
    stack!.smartStack.cards[1].texts.push("T28");
    const result = await tapSmartStackOn(client, stack!, { action: "tap", text: "T28", index: 1 });
    expect(result.element["resource-id"]).toBe("StackCollectionViewTriPlatterCell");
    expect(client.commands.at(-1)).toEqual({
      type: "face",
      op: "tap",
      x: (16.9 + 170) / 2 / 187,
      y: (137.4 + 200.5) / 2 / 223,
    });
  });
  test("skips an off-screen card with the same text before applying the index", async () => {
    const offScreenStack = async () => {
      const client = new FaceDumpClient(textDump);
      const stack = await readOpenSmartStack(client, () => 1);
      const visible = stack!.smartStack.cards[0];
      if (visible.type !== "widget") {
        throw new Error("fixture's first card is expected to be the T28 widget");
      }
      // A second T28 widget card scrolled above the screen, ahead of the visible one.
      stack!.smartStack.cards.unshift({
        ...visible,
        cellId: "00000000-0000-0000-0000-000000000000",
        bounds: { left: 5.5, top: -100, right: 181.5, bottom: -27.5 },
        texts: ["T28"],
      });
      return { client, stack: stack! };
    };
    const visibleTap = { type: "face", op: "tap", x: 0.5, y: 146.25 / 223 } as const;

    const first = await offScreenStack();
    const result = await tapSmartStackOn(first.client, first.stack, { action: "tap", text: "T28" });
    expect(result.element["resource-id"]).toBe(
      "StackCollectionViewComplicationCell -- 93A18F3B-D642-41DA-B6A4-F312ED9DB584 -- ProbeApp -- ProbeWidgetXYZ -- dev.probe.app -- dev.probe.app-dev.probe.app.widget-probe-0",
    );
    expect(first.client.commands.at(-1)).toEqual(visibleTap);

    // Index 1 counts only on-screen cards: one visible match leaves nothing at index 1.
    const second = await offScreenStack();
    await expect(
      tapSmartStackOn(second.client, second.stack, { action: "tap", text: "T28", index: 1 }),
    ).rejects.toThrow("The Smart Stack is open, but no element matched.");
    expect(second.client.commands).toEqual([{ type: "face", op: "dump" }]);

    // With a second visible match, index 1 still selects it rather than the off-screen card.
    const third = await offScreenStack();
    third.stack.smartStack.cards[2].texts.push("T28");
    const indexed = await tapSmartStackOn(third.client, third.stack, {
      action: "tap",
      text: "T28",
      index: 1,
    });
    expect(indexed.element["resource-id"]).toBe("StackCollectionViewTriPlatterCell");
    expect(third.client.commands.at(-1)).toEqual({
      type: "face",
      op: "tap",
      x: (16.9 + 170) / 2 / 187,
      y: (137.4 + 200.5) / 2 / 223,
    });
  });
  test("falls back to header element matching when no card matches", async () => {
    const client = new FaceDumpClient(stackDump);
    const stack = await readOpenSmartStack(client, () => 1);
    const result = await tapSmartStackOn(client, stack!, { action: "tap", text: "SAT" });
    expect(result.element.text).toBe("SAT");
    expect(client.commands.at(-1)).toEqual({
      type: "face",
      op: "tap",
      x: 31.5 / 187,
      y: 34.75 / 223,
    });
  });
  test("no-match and index errors explain how to recover without guessed widget names", async () => {
    const client = new FaceDumpClient(textDump);
    const hierarchy = await readOpenSmartStack(client, () => 1);
    for (const selector of [{ text: "missing" }, { text: "T28", index: 99 }]) {
      await expect(
        tapSmartStackOn(client, hierarchy!, { action: "tap", ...selector }),
      ).rejects.toThrow(
        "The Smart Stack is open, but no element matched. To observe it, call the face dump, use tapAt with coordinates in points, or call launchApp to bring the host app forward.",
      );
    }
    expect(client.commands).toEqual([{ type: "face", op: "dump" }]);
  });
});
