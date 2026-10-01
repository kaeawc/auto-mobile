import { describe, expect, test } from "bun:test";
import { android, createSendKeysHarness, ios } from "./SendKeysTestHarness";

const corpus = [
  "a\u{1F600}b\u{1F44D}\u{1F3FD}c\u{1F468}\u200D\u{1F469}\u200D\u{1F467}\u200D\u{1F466}d\u{1F1EF}\u{1F1F5}e\u2764\uFE0Ff\u00E9\u65E5\u672C",
  "1\uFE0F\u20E3",
  "e\u0301",
  "\u{1F3F3}\uFE0F\u200D\u{1F308}",
  "\u{1F469}\u{1F3FD}\u200D\u{1F4BB}",
  "\u0E44\u0E17\u0E22",
  "\u0939\u093F\u0928\u094D\u0926\u0940",
  "\u0645\u0631\u062D\u0628\u0627",
  "\uD55C\uAD6D\uC5B4",
] as const;
const androidUnicodeModes = ["a11y", "ime", "auto"] as const;
const eventModes = ["eventAll", "eventLast"] as const;
const requestedModes = [
  "auto",
  "ime",
  "a11y",
  "eventAll",
  "eventLast",
  "eventOnly",
  "imeKeyEvents",
] as const;

function deliveredText(harness: ReturnType<typeof createSendKeysHarness>): string {
  return harness.deliveries.map((delivery) => delivery.text).join("");
}

function codePointCount(text: string): number {
  return Array.from(text).length;
}

describe("sendKeys Unicode corpus", () => {
  test("iOS forwards the complete corpus through xcuiTypeText for every requested mode", async () => {
    for (const mode of requestedModes) {
      for (const text of corpus) {
        const harness = createSendKeysHarness(ios);
        const result = await harness.executor.type({ action: "type", text, mode });
        expect(result).toMatchObject({
          success: true,
          resolvedMode: "xcuiTypeText",
          textLength: codePointCount(text),
        });
        expect(harness.inserted).toEqual([text]);
        expect(deliveredText(harness)).toBe(text);
      }
    }
  });

  test("Android a11y, ime, and auto deliver each corpus string intact", async () => {
    for (const mode of androidUnicodeModes) {
      for (const text of corpus) {
        const harness = createSendKeysHarness(android);
        const result = await harness.executor.type({ action: "type", text, mode });
        expect(result).toMatchObject({ success: true, textLength: codePointCount(text) });
        expect(deliveredText(harness)).toBe(text);
        expect(mode === "ime" || mode === "auto" ? harness.committed : harness.inserted).toEqual([
          text,
        ]);
      }
    }
  });

  test("Android eventAll and eventLast preserve corpus order across key events and a11y chunks", async () => {
    for (const mode of eventModes) {
      for (const text of corpus) {
        const harness = createSendKeysHarness(android);
        const result = await harness.executor.type({ action: "type", text, mode });
        expect(result).toMatchObject({ success: true, textLength: codePointCount(text) });
        expect(deliveredText(harness)).toBe(text);
      }
    }
  });

  test("eventAll keeps clusters whole while eventLast retains its split delivery", async () => {
    const cases = [
      ["e\u0301", "\u0301"],
      ["1\uFE0F\u20E3", "\uFE0F\u20E3"],
      ["a\u200D\u{1F600}", "\u200D\u{1F600}"],
    ] as const;
    for (const mode of eventModes) {
      for (const [text, expectedLeadingChunk] of cases) {
        const harness = createSendKeysHarness(android);
        expect(await harness.executor.type({ action: "type", text, mode })).toMatchObject({
          success: true,
        });
        expect(harness.inserted[0]).toBe(mode === "eventAll" ? text : expectedLeadingChunk);
        if (mode === "eventAll") {
          expect(harness.adb.getExecutedCommands()).toEqual([]);
        }
        expect(
          harness.inserted.every((chunk) => {
            const firstCodeUnit = chunk.charCodeAt(0);
            return firstCodeUnit < 0xdc00 || firstCodeUnit > 0xdfff;
          }),
        ).toBe(true);
      }
    }
  });

  test("Android eventOnly and imeKeyEvents reject the corpus before any client mutation", async () => {
    for (const mode of ["eventOnly", "imeKeyEvents"] as const) {
      for (const text of corpus) {
        const harness = createSendKeysHarness(android);
        const result = await harness.executor.type({ action: "type", text, mode });
        expect(result).toMatchObject({ success: false, textLength: codePointCount(text) });
        expect(harness.clientCalls).toEqual([]);
        expect(harness.inserted).toEqual([]);
        expect(harness.replaced).toEqual([]);
        expect(harness.committed).toEqual([]);
        expect(harness.adb.getExecutedCommands()).toEqual([]);
      }
    }
  });
});
