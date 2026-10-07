import { describe, expect, test } from "bun:test";
import * as yaml from "js-yaml";
import {
  redactPlanObjectTypedText,
  redactPlanStepTypedText,
  redactPlanYamlTypedText,
  redactTypedTextArguments,
  typedTextPlaceholder,
} from "../../src/utils/redactTypedTextArguments";

const SECRET = "hunter2-secret";

describe("redactTypedTextArguments", () => {
  test("placeholder counts graphemes as code points, not UTF-16 units", () => {
    expect(typedTextPlaceholder("ab😀")).toBe("<text, 3 characters>");
  });

  test("sendKeys: redacts every command text and keeps every other field", () => {
    const args = {
      selector: { text: "Password" },
      commands: [
        { action: "type", text: SECRET, mode: "ime" },
        { action: "key", key: "enter" },
        { action: "clear" },
      ],
      platform: "android",
    };
    expect(redactTypedTextArguments("sendKeys", args)).toEqual({
      selector: { text: "Password" },
      commands: [
        { action: "type", text: "<text, 14 characters>", mode: "ime" },
        { action: "key", key: "enter" },
        { action: "clear" },
      ],
      platform: "android",
    });
    // The caller's arguments are never mutated.
    expect(args.commands[0].text).toBe(SECRET);
  });

  test("sendKeys: redacts an index-keyed commands object", () => {
    const args = { commands: { "0": { action: "type", text: SECRET } } };
    expect(redactTypedTextArguments("sendKeys", args)).toEqual({
      commands: { "0": { action: "type", text: "<text, 14 characters>" } },
    });
  });

  test("legacy inputText, clipboard and setUIState values are redacted", () => {
    expect(redactTypedTextArguments("inputText", { text: SECRET, imeAction: "done" })).toEqual({
      text: "<text, 14 characters>",
      imeAction: "done",
    });
    expect(redactTypedTextArguments("inputText", { value: SECRET })).toEqual({
      value: "<text, 14 characters>",
    });
    expect(redactTypedTextArguments("clipboard", { action: "copy", text: SECRET })).toEqual({
      action: "copy",
      text: "<text, 14 characters>",
    });
    expect(
      redactTypedTextArguments("setUIState", {
        fields: [
          { selector: { text: "Password" }, value: SECRET },
          { selector: { elementId: "remember" }, selected: true },
        ],
      }),
    ).toEqual({
      fields: [
        { selector: { text: "Password" }, value: "<text, 14 characters>" },
        { selector: { elementId: "remember" }, selected: true },
      ],
    });
  });

  test("other tools and non-object arguments pass through unchanged", () => {
    const tapArgs = { text: "Sign in" };
    expect(redactTypedTextArguments("tapOn", tapArgs)).toBe(tapArgs);
    expect(redactTypedTextArguments(undefined, tapArgs)).toBe(tapArgs);
    expect(redactTypedTextArguments("sendKeys", undefined)).toBeUndefined();
    expect(redactTypedTextArguments("clipboard", { action: "get" })).toEqual({ action: "get" });
  });

  test("executePlan: redacts sendKeys and inputText steps inside planContent", () => {
    const planContent = yaml.dump({
      name: "login",
      steps: [
        { tool: "tapOn", text: "Password" },
        { tool: "sendKeys", commands: [{ action: "type", text: SECRET }] },
        { command: "inputText", params: { text: SECRET } },
      ],
    });
    const redacted = redactTypedTextArguments("executePlan", { planContent, startStep: 0 }) as {
      planContent: string;
      startStep: number;
    };
    expect(redacted.startStep).toBe(0);
    expect(redacted.planContent).not.toContain(SECRET);
    expect(yaml.load(redacted.planContent)).toEqual({
      name: "login",
      steps: [
        { tool: "tapOn", text: "Password" },
        { tool: "sendKeys", commands: [{ action: "type", text: "<text, 14 characters>" }] },
        { command: "inputText", params: { text: "<text, 14 characters>" } },
      ],
    });
  });

  test("executePlan: decodes base64 plans, keeps text-free plans verbatim", () => {
    const withSecret = yaml.dump({ name: "p", steps: [{ tool: "clipboard", text: SECRET }] });
    const encoded = `base64:${Buffer.from(withSecret).toString("base64")}`;
    expect(redactPlanYamlTypedText(encoded)).not.toContain(SECRET);
    expect(redactPlanYamlTypedText(encoded)).toContain("<text, 14 characters>");

    const textFree = "name: p\nsteps:\n  - tool: sendKeys\n    commands:\n      - action: clear\n";
    expect(redactPlanYamlTypedText(textFree)).toBe(textFree);
  });

  test("executePlan: an unparseable plan is replaced whole", () => {
    const broken = `steps: [ { tool: sendKeys, text: ${SECRET}`;
    expect(redactPlanYamlTypedText(broken)).toBe(`<plan, ${broken.length} characters>`);
  });

  test("plan object and step helpers", () => {
    const plan = { name: "p", steps: [{ tool: "observe" }] };
    expect(redactPlanObjectTypedText(plan)).toBe(plan);
    expect(redactPlanObjectTypedText("not a plan")).toBe("not a plan");
    expect(
      redactPlanStepTypedText({
        tool: "sendKeys",
        params: { commands: [{ action: "type", text: SECRET }] },
      }),
    ).toEqual({
      tool: "sendKeys",
      params: { commands: [{ action: "type", text: "<text, 14 characters>" }] },
    });
  });
});
