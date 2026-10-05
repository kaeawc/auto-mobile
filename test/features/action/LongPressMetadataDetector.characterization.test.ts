import { describe, expect, test } from "bun:test";
import { LongPressMetadataDetector } from "../../../src/features/action/LongPressMetadataDetector";
import type { ObserveResult, ViewHierarchyResult } from "../../../src/models";
import { FakeElementParser } from "../../fakes/FakeElementParser";
import containerCapture from "../../fixtures/observe/android-container-scope.json";
import scrollCapture from "../../fixtures/observe/diff/scroll-before.json";
import keyboardCapture from "../../fixtures/observe/diff/text-input-typed.json";

const observation: ObserveResult = {
  viewHierarchy: containerCapture.viewHierarchy as ViewHierarchyResult,
} as ObserveResult;

describe("LongPressMetadataDetector captured hierarchy characterization", () => {
  test("recognizes a menu indicator deep in the captured scroll hierarchy", () => {
    const detector = new LongPressMetadataDetector(new FakeElementParser());
    expect(detector.detect(null, scrollCapture as ObserveResult)).toEqual({
      pressRecognized: true,
      contextMenuOpened: true,
      selectionStarted: false,
    });
  });

  test("recognizes the captured keyboard menu description", () => {
    const detector = new LongPressMetadataDetector(new FakeElementParser());
    expect(detector.detect(null, keyboardCapture as ObserveResult)).toEqual({
      pressRecognized: true,
      contextMenuOpened: true,
      selectionStarted: false,
    });
  });

  test("does not reclassify an existing captured root as a new context menu", () => {
    const detector = new LongPressMetadataDetector(new FakeElementParser());
    expect(detector.detect(scrollCapture as ObserveResult, scrollCapture as ObserveResult)).toEqual(
      {
        pressRecognized: false,
        contextMenuOpened: false,
        selectionStarted: false,
      },
    );
  });

  // The captured tree stays intact; only the fake parser's returned metadata varies.
  const selections = [
    { name: "missing range", props: {}, selected: false },
    { name: "missing end", props: { textSelectionStart: "0" }, selected: false },
    { name: "missing start", props: { textSelectionEnd: "5" }, selected: false },
    {
      name: "lowercase text aliases",
      props: { textselectionstart: "0", textselectionend: "5" },
      selected: true,
    },
    {
      name: "lowercase selection aliases",
      props: { selectionstart: 0, selectionend: 5 },
      selected: true,
    },
    { name: "numeric range", props: { selectionStart: 0, selectionEnd: 5 }, selected: true },
    {
      name: "string prefix parsing",
      props: { selectionStart: "1tail", selectionEnd: "5tail" },
      selected: true,
    },
    {
      name: "invalid start",
      props: { selectionStart: "invalid", selectionEnd: "5" },
      selected: false,
    },
    {
      name: "invalid end",
      props: { selectionStart: "0", selectionEnd: "invalid" },
      selected: false,
    },
    { name: "reversed range", props: { selectionStart: "5", selectionEnd: "0" }, selected: false },
    { name: "zero width", props: { selectionStart: "3", selectionEnd: "3" }, selected: false },
    {
      name: "null without lowercase fallback",
      props: { selectionStart: null, selectionEnd: 2 },
      selected: false,
    },
    {
      name: "first pair precedence",
      props: { textSelectionStart: 0, textSelectionEnd: 5, selectionStart: 3, selectionEnd: 3 },
      selected: true,
    },
    {
      name: "second pair after invalid first",
      props: {
        textSelectionStart: "invalid",
        textSelectionEnd: 5,
        selectionStart: 0,
        selectionEnd: 5,
      },
      selected: true,
    },
    {
      name: "populated camel case wins",
      props: { selectionStart: 5, selectionEnd: 0, selectionstart: 0, selectionend: 5 },
      selected: false,
    },
  ];
  for (const { name, props, selected } of selections) {
    test(`selection metadata: ${name}`, () => {
      const parser = new FakeElementParser();
      parser.nextNodeProperties = props;
      const detector = new LongPressMetadataDetector(parser);
      expect(detector.detect(observation, observation)).toEqual({
        pressRecognized: selected,
        contextMenuOpened: false,
        selectionStarted: selected,
      });
    });
  }

  for (const [field, value] of [
    ["resource-id", "SomeMENU"],
    ["resourceId", "SomePOPUP"],
    ["class", "PopupWindow"],
    ["className", "MenuWindow"],
    ["text", "Open MENU"],
    ["content-desc", "Open POPUP"],
  ]) {
    test(`menu metadata: ${field}`, () => {
      const parser = new FakeElementParser();
      parser.nextNodeProperties = { [field]: value };
      const detector = new LongPressMetadataDetector(parser);
      expect(detector.detect(null, observation)).toEqual({
        pressRecognized: true,
        contextMenuOpened: true,
        selectionStarted: false,
      });
    });
  }

  test("menu metadata prefers populated primary fields over aliases", () => {
    const parser = new FakeElementParser();
    parser.nextNodeProperties = {
      "resource-id": "plain",
      resourceId: "menu",
      class: "plain",
      className: "popup",
      text: "plain",
      "content-desc": "menu",
    };
    const detector = new LongPressMetadataDetector(parser);
    expect(detector.detect(null, observation)).toEqual({
      pressRecognized: true,
      contextMenuOpened: false,
      selectionStarted: false,
    });
  });
});
