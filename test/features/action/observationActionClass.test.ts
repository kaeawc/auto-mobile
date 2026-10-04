import { describe, expect, test } from "bun:test";
import generatedDefinitions from "../../../schemas/tool-definitions.json";
import {
  classifyObservationAction,
  isSettleGatedActionClass,
  type ObservationActionClass,
} from "../../../src/features/action/observationActionClass";

// Read the generated schema without initializing the registry or its dependencies.
const definitions = generatedDefinitions;
const fixedClasses = {
  tapOn: "navigation",
  tapAny: "navigation",
  homeScreen: "navigation",
  recentApps: "navigation",
  openLink: "navigation",
  selectAllText: "inPlace",
  keyboard: "inPlace",
  clipboard: "inPlace",
  swipeOn: "scroll",
  dragAndDrop: "scroll",
} satisfies Record<string, ObservationActionClass>;

const advertisedClasses = {
  tapOn: "navigation",
  tapAny: "navigation",
  homeScreen: "navigation",
  recentApps: "navigation",
  openLink: "navigation",
  selectAllText: "inPlace",
  swipeOn: "scroll",
  dragAndDrop: "scroll",
  biometricAuth: "unknown",
  launchApp: "unknown",
  observe: "unknown", // Top-level projection; included to cover every raw/project advertiser.
  pinchOn: "unknown",
  pressButton: "unknown", // Missing button; argument-dependent cases are pinned below.
  rotate: "unknown",
  sendKeys: "inPlace", // Missing commands; argument-dependent cases are pinned below.
  shake: "unknown",
  systemTray: "unknown",
  // Pinned unknown pending an owner decision on whether coordinate taps should be settle-gated navigation actions.
  tapAt: "unknown",
  terminateApp: "unknown",
} satisfies Record<string, ObservationActionClass>;

const buttonClasses: Record<string, ObservationActionClass> = {
  back: "navigation",
  home: "navigation",
  recent: "navigation",
  power: "navigation",
  menu: "inPlace",
  volume_up: "inPlace",
  volume_down: "inPlace",
};
const submittingKeys = ["enter", "done", "go", "search", "send"];
const inPlaceKeys = [
  "tab",
  "escape",
  "backspace",
  "delete",
  "arrow_up",
  "arrow_down",
  "arrow_left",
  "arrow_right",
  "next",
  "previous",
];
const buttonEnum = definitions.find(({ name }) => name === "pressButton")?.inputSchema.properties
  ?.button?.enum;
const commandSchemas = definitions.find(({ name }) => name === "sendKeys")?.inputSchema.properties
  ?.commands?.items?.anyOf;
const keyEnum = commandSchemas?.find((schema) => schema.properties?.action?.const === "key")
  ?.properties?.key?.enum;

describe("observation action classification", () => {
  test.each(Object.entries(fixedClasses))("fixed tool %s is %s", (name, expected) => {
    expect(classifyObservationAction(name)).toBe(expected);
  });

  test("every raw/project advertiser has an explicit current classification", () => {
    const names = definitions
      .filter(({ inputSchema }) => {
        const properties = inputSchema.properties;
        return (
          properties && Object.hasOwn(properties, "raw") && Object.hasOwn(properties, "project")
        );
      })
      .map(({ name }) => name);
    expect(names.sort()).toEqual(Object.keys(advertisedClasses).sort());
    for (const [name, expected] of Object.entries(advertisedClasses)) {
      expect(classifyObservationAction(name)).toBe(expected);
    }
  });

  test("every schema button has an explicit class, including case-insensitive policy", () => {
    expect(buttonEnum).toBeDefined();
    expect([...(buttonEnum ?? [])].sort()).toEqual(Object.keys(buttonClasses).sort());
    for (const button of buttonEnum ?? []) {
      expect(classifyObservationAction("pressButton", { button })).toBe(buttonClasses[button]);
      expect(classifyObservationAction("pressButton", { button: button.toUpperCase() })).toBe(
        buttonClasses[button],
      );
    }
  });

  test.each([undefined, "unsupported", "constructor", null, 1])(
    "missing/unknown pressButton value %s is unknown",
    (button) => {
      expect(classifyObservationAction("pressButton", { button })).toBe("unknown");
      expect(classifyObservationAction("pressButton")).toBe("unknown");
    },
  );

  test("every schema key belongs to exactly one explicit expected group", () => {
    expect(keyEnum).toBeDefined();
    expect([...(keyEnum ?? [])].sort()).toEqual([...submittingKeys, ...inPlaceKeys].sort());
    for (const key of keyEnum ?? []) {
      expect(Number(submittingKeys.includes(key)) + Number(inPlaceKeys.includes(key))).toBe(1);
      expect(classifyObservationAction("sendKeys", { commands: [{ action: "key", key }] })).toBe(
        submittingKeys.includes(key) ? "navigation" : "inPlace",
      );
    }
  });

  test("every non-key schema command stays in place even with a submitting key field", () => {
    expect(commandSchemas?.length).toBeGreaterThan(0);
    for (const schema of commandSchemas ?? []) {
      const action = schema.properties?.action?.const;
      expect(action).toBeDefined();
      if (action !== "key") {
        expect(
          classifyObservationAction("sendKeys", {
            commands: [{ action, text: "test", key: "enter" }],
          }),
        ).toBe("inPlace");
      }
    }
  });

  test.each([
    undefined,
    {},
    { commands: [] },
    { commands: "malformed" },
    { commands: [null, false, 1, "key", {}, { action: "key" }, { action: "key", key: "unknown" }] },
  ])("missing/malformed sendKeys args %j stay in place", (args) => {
    expect(classifyObservationAction("sendKeys", args)).toBe("inPlace");
  });

  test("a submitting key anywhere in a mixed command sequence is navigation", () => {
    expect(
      classifyObservationAction("sendKeys", {
        commands: [null, { action: "type", text: "test" }, { action: "key", key: "enter" }],
      }),
    ).toBe("navigation");
  });

  test("unknown tools remain unknown", () => {
    expect(classifyObservationAction("unrecognizedTool")).toBe("unknown");
  });

  test.each<[ObservationActionClass, boolean]>([
    ["navigation", true],
    ["inPlace", false],
    ["scroll", false],
    ["unknown", false],
  ])("settle gating for %s is %s", (actionClass, expected) => {
    expect(isSettleGatedActionClass(actionClass)).toBe(expected);
  });
});
