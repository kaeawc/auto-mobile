import Ajv2020 from "ajv/dist/2020";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import {
  OBSERVE_WAIT_FOR_SKIP_SCREENSHOT_ENV,
  shouldSkipObserveWaitForScreenshot,
} from "../../src/features/observe/automaticScreenshotPolicy";
import { DefaultElementFinder } from "../../src/features/utility/ElementFinder";
import type { ObserveResult, ViewHierarchyResult } from "../../src/models";
import {
  findWaitForElement,
  observeSchema,
  registerObserveTools,
  waitForObservation,
} from "../../src/server/observeTools";
import { ToolRegistry } from "../../src/server/toolRegistry";
import { serverConfig } from "../../src/utils/ServerConfig";
import { FakeObserveScreen } from "../fakes/FakeObserveScreen";
import { FakeTimer } from "../fakes/FakeTimer";

const bounds = (left: number, top: number, right: number, bottom: number) => ({
  left,
  top,
  right,
  bottom,
});

const makeHierarchy = (
  nodes: unknown[],
  screenSize = { width: 200, height: 200 },
): ViewHierarchyResult => ({
  hierarchy: {
    node: {
      $: { bounds: bounds(0, 0, screenSize.width, screenSize.height) },
      node: nodes,
    },
  },
  screenWidth: screenSize.width,
  screenHeight: screenSize.height,
});

const originalWaitForScreenshotPolicy = process.env[OBSERVE_WAIT_FOR_SKIP_SCREENSHOT_ENV];

afterEach(() => {
  if (originalWaitForScreenshotPolicy === undefined) {
    delete process.env[OBSERVE_WAIT_FOR_SKIP_SCREENSHOT_ENV];
  } else {
    process.env[OBSERVE_WAIT_FOR_SKIP_SCREENSHOT_ENV] = originalWaitForScreenshotPolicy;
  }
  serverConfig.setAccessibilityAuditConfig(null);
});

describe("observeSchema waitFor.container", () => {
  test("accepts elementId waitFor with container elementId", () => {
    const parsed = observeSchema.parse({
      platform: "android",
      waitFor: {
        elementId: "com.app:id/name",
        timeout: 8000,
        container: { elementId: "com.app:id/list" },
      },
    });
    expect(parsed.waitFor).toMatchObject({
      elementId: "com.app:id/name",
      container: { elementId: "com.app:id/list" },
    });
  });

  test("accepts text waitFor with container text", () => {
    const parsed = observeSchema.parse({
      platform: "android",
      waitFor: {
        text: "Dan Corkill",
        container: { text: "PEOPLE" },
      },
    });
    expect(parsed.waitFor).toMatchObject({
      text: "Dan Corkill",
      container: { text: "PEOPLE" },
    });
  });

  test("accepts textAny waitFor with ordered variants", () => {
    const parsed = observeSchema.parse({
      platform: "ios",
      waitFor: {
        textAny: ["Done", "Add"],
        timeout: 8000,
      },
    });
    expect(parsed.waitFor).toMatchObject({
      textAny: ["Done", "Add"],
      timeout: 8000,
    });
  });

  test("rejects empty textAny waitFor", () => {
    expect(() =>
      observeSchema.parse({
        platform: "ios",
        waitFor: {
          textAny: [],
        },
      }),
    ).toThrow();
  });

  test.each([
    {
      waitFor: { elementId: "com.app:id/name", textAny: ["Name", "Label"] },
      label: "elementId and textAny",
    },
    {
      waitFor: { text: "Name", textAny: ["Name", "Label"] },
      label: "text and textAny",
    },
    {
      waitFor: { elementId: "com.app:id/name", text: "Name", textAny: ["Name", "Label"] },
      label: "elementId, text, and textAny",
    },
  ])("rejects waitFor with textAny mixed with element fields: $label", ({ waitFor }) => {
    expect(() =>
      observeSchema.parse({
        platform: "ios",
        waitFor,
      }),
    ).toThrow();
  });

  test("rejects container object that includes both elementId and text", () => {
    expect(() =>
      observeSchema.parse({
        platform: "android",
        waitFor: {
          elementId: "com.app:id/name",
          container: { elementId: "com.app:id/list", text: "extra" },
        },
      }),
    ).toThrow();
  });
});

describe("observeSchema rich waitFor predicates", () => {
  test("accepts element predicates combined on the same node", () => {
    const parsed = observeSchema.parse({
      platform: "ios",
      waitFor: {
        elementId: "home_tab_bar",
        className: "UITabBar",
        contentDescription: "Home tab",
        text: "Home",
        textMatch: "exact",
        matchType: "all",
        timeout: 25000,
      },
    });

    expect(parsed.waitFor).toMatchObject({
      elementId: "home_tab_bar",
      className: "UITabBar",
      contentDescription: "Home tab",
      text: "Home",
      textMatch: "exact",
      matchType: "all",
    });
  });

  test("accepts activeWindow predicates with an element predicate", () => {
    const parsed = observeSchema.parse({
      platform: "android",
      waitFor: {
        activeWindow: {
          appId: "com.example.app",
          activityName: "com.example.app.HomeActivity",
        },
        className: "android.widget.FrameLayout",
        timeout: 10000,
      },
    });

    expect(parsed.waitFor).toMatchObject({
      activeWindow: {
        appId: "com.example.app",
        activityName: "com.example.app.HomeActivity",
      },
      className: "android.widget.FrameLayout",
    });
  });

  test("accepts activeWindow appId aliases", () => {
    const androidParsed = observeSchema.parse({
      platform: "android",
      waitFor: {
        activeWindow: {
          packageName: "com.example.android",
        },
      },
    });
    const iosParsed = observeSchema.parse({
      platform: "ios",
      waitFor: {
        activeWindow: {
          bundleId: "com.example.ios",
        },
      },
    });

    expect(androidParsed.waitFor?.activeWindow?.appId).toBe("com.example.android");
    expect(iosParsed.waitFor?.activeWindow?.appId).toBe("com.example.ios");
  });

  test("rejects a rich waitFor with no predicate fields", () => {
    expect(() =>
      observeSchema.parse({
        platform: "android",
        waitFor: {
          matchType: "all",
        },
      }),
    ).toThrow();
  });

  test("rejects invalid waitFor regex text", () => {
    expect(() =>
      observeSchema.parse({
        platform: "android",
        waitFor: {
          text: "[",
          textMatch: "regex",
        },
      }),
    ).toThrow();
  });
});

describe("published observe waitFor input schema", () => {
  let validatePublishedObserveInput = (_input: unknown): { valid: boolean } => {
    throw new Error("Published observe schema validator was not initialized");
  };

  beforeAll(() => {
    (ToolRegistry as any).tools.clear();
    registerObserveTools();
    const observeTool = ToolRegistry.getToolDefinitions().find((tool) => tool.name === "observe");
    expect(observeTool).toBeDefined();

    const ajv = new Ajv2020({ strict: false, allErrors: true });
    const validate = ajv.compile(observeTool!.inputSchema);
    validatePublishedObserveInput = (input: unknown) => ({
      valid: validate(input),
    });
  });

  afterAll(() => {
    ToolRegistry.clearTools();
  });

  const collectTextMatchDescriptions = (schema: unknown): string[] => {
    if (schema === null || typeof schema !== "object") {
      return [];
    }

    const record = schema as Record<string, unknown>;
    const descriptions: string[] = [];
    const properties = record.properties;
    if (properties !== null && typeof properties === "object") {
      const textMatch = (properties as Record<string, unknown>).textMatch;
      if (textMatch !== null && typeof textMatch === "object") {
        const description = (textMatch as Record<string, unknown>).description;
        if (typeof description === "string") {
          descriptions.push(description);
        }
      }
    }

    for (const value of Object.values(record)) {
      descriptions.push(...collectTextMatchDescriptions(value));
    }

    return descriptions;
  };

  test("documents textMatch as applying only to waitFor.text", () => {
    (ToolRegistry as any).tools.clear();
    registerObserveTools();
    const observeTool = ToolRegistry.getToolDefinitions().find((tool) => tool.name === "observe");
    expect(observeTool).toBeDefined();

    const descriptions = collectTextMatchDescriptions(observeTool!.inputSchema);

    expect(descriptions.length).toBeGreaterThan(0);
    expect(new Set(descriptions)).toEqual(
      new Set(["How to match waitFor.text; does not affect contentDescription"]),
    );
  });

  test("rejects selectorless predicate DSL forms while permitting whole-screen stable", () => {
    expect(
      validatePublishedObserveInput({
        platform: "android",
        waitFor: { for: "appear" },
      }).valid,
    ).toBe(false);
    expect(
      validatePublishedObserveInput({
        platform: "android",
        waitFor: { for: "stable" },
      }).valid,
    ).toBe(true);
    expect(
      validatePublishedObserveInput({
        platform: "android",
        waitFor: { for: "stable", container: { elementId: "scope" } },
      }).valid,
    ).toBe(false);
  });

  test("requires text for the advertised textEquals DSL form", () => {
    expect(
      validatePublishedObserveInput({
        platform: "android",
        waitFor: { for: "textEquals", elementId: "counter" },
      }).valid,
    ).toBe(false);
    expect(
      validatePublishedObserveInput({
        platform: "android",
        waitFor: { for: "textEquals", elementId: "counter", text: "5" },
      }).valid,
    ).toBe(true);
  });

  test("enforces the advertised container selector shape", () => {
    for (const container of [{}, { elementId: "scope", text: "Scope" }]) {
      expect(
        validatePublishedObserveInput({
          platform: "android",
          waitFor: { for: "appear", elementId: "target", container },
        }).valid,
      ).toBe(false);
    }
  });

  test("rejects dual timeout aliases in the advertised schema", () => {
    expect(
      validatePublishedObserveInput({
        platform: "android",
        waitFor: { for: "appear", elementId: "target", timeout: 1000, timeoutMs: 1000 },
      }).valid,
    ).toBe(false);
  });

  test("committed tool definitions document textMatch as applying only to waitFor.text", () => {
    const toolDefinitions = JSON.parse(
      readFileSync(new URL("../../schemas/tool-definitions.json", import.meta.url), "utf8"),
    ) as Array<{ name: string; inputSchema: unknown }>;
    const observeTool = toolDefinitions.find((tool) => tool.name === "observe");
    expect(observeTool).toBeDefined();

    const descriptions = collectTextMatchDescriptions(observeTool!.inputSchema);

    expect(descriptions.length).toBeGreaterThan(0);
    expect(new Set(descriptions)).toEqual(
      new Set(["How to match waitFor.text; does not affect contentDescription"]),
    );
  });

  test.each([
    {
      label: "legacy elementId with timeout",
      input: {
        platform: "android",
        waitFor: { elementId: "com.app:id/name", timeout: 5000 },
      },
    },
    {
      label: "legacy elementId with container",
      input: {
        platform: "android",
        waitFor: {
          elementId: "com.app:id/name",
          container: { text: "People" },
        },
      },
    },
    {
      label: "text with textMatch",
      input: {
        platform: "ios",
        waitFor: { text: "Home", textMatch: "contains", timeout: 5000 },
      },
    },
    {
      label: "combined rich predicates",
      input: {
        platform: "ios",
        waitFor: {
          elementId: "home_tab_bar",
          text: "Home",
          className: "UITabBar",
          contentDescription: "Home tab",
          textMatch: "exact",
          matchType: "all",
        },
      },
    },
    {
      label: "activeWindow appId and activityName",
      input: {
        platform: "android",
        waitFor: {
          activeWindow: {
            appId: "com.example.app",
            activityName: "com.example.app.HomeActivity",
          },
          timeout: 5000,
        },
      },
    },
    {
      label: "activeWindow packageName alias",
      input: {
        platform: "android",
        waitFor: {
          activeWindow: { packageName: "com.example.app" },
        },
      },
    },
    {
      label: "activeWindow bundleId alias",
      input: {
        platform: "ios",
        waitFor: {
          activeWindow: { bundleId: "com.example.app" },
        },
      },
    },
    {
      label: "absent alone",
      input: {
        platform: "ios",
        waitFor: { absent: { className: "UIActivityIndicatorView" } },
      },
    },
    {
      label: "absent combined with a positive predicate",
      input: {
        platform: "ios",
        waitFor: {
          absent: { className: "UIActivityIndicatorView" },
          elementId: "message_list",
        },
      },
    },
    {
      label: "absent combined with textAny",
      input: {
        platform: "android",
        waitFor: {
          textAny: ["Home", "Feed"],
          absent: { elementId: "com.app:id/spinner" },
        },
      },
    },
    {
      label: "settled with a waitFor predicate",
      input: {
        platform: "android",
        waitFor: { elementId: "home_tab_bar", timeout: 15000 },
        settled: { quietPeriodMs: 500 },
      },
    },
  ])("accepts runtime-valid waitFor input: $label", ({ input }) => {
    expect(observeSchema.safeParse(input).success).toBe(true);

    const result = validatePublishedObserveInput(input);

    expect(result.valid).toBe(true);
  });

  test.each([
    {
      label: "waitFor has only timeout",
      input: {
        platform: "android",
        waitFor: { timeout: 5000 },
      },
    },
    {
      label: "activeWindow is empty",
      input: {
        platform: "android",
        waitFor: { activeWindow: {} },
      },
    },
    {
      label: "textAny mixed with elementId",
      input: {
        platform: "android",
        waitFor: {
          elementId: "com.app:id/name",
          textAny: ["Name"],
        },
      },
    },
    {
      label: "textAny mixed with matchType",
      input: {
        platform: "android",
        waitFor: {
          textAny: ["Name"],
          matchType: "any",
        },
      },
    },
    {
      label: "textAny mixed with className",
      input: {
        platform: "android",
        waitFor: {
          textAny: ["Name"],
          className: "android.widget.TextView",
        },
      },
    },
    {
      label: "textAny mixed with contentDescription",
      input: {
        platform: "android",
        waitFor: {
          textAny: ["Name"],
          contentDescription: "Name",
        },
      },
    },
    {
      label: "textAny mixed with textMatch",
      input: {
        platform: "android",
        waitFor: {
          textAny: ["Name"],
          textMatch: "exact",
        },
      },
    },
    {
      label: "iOS activeWindow has activityName without app id",
      input: {
        platform: "ios",
        waitFor: {
          activeWindow: {
            activityName: "com.example.ios.IgnoredActivity",
          },
        },
      },
    },
    {
      label: "settled without waitFor",
      input: {
        platform: "android",
        settled: { quietPeriodMs: 500 },
      },
    },
    {
      label: "empty absent object",
      input: {
        platform: "android",
        waitFor: { absent: {} },
      },
    },
  ])("rejects runtime-invalid waitFor input: $label", ({ input }) => {
    expect(observeSchema.safeParse(input).success).toBe(false);

    const result = validatePublishedObserveInput(input);

    expect(result.valid).toBe(false);
  });
});

describe("findWaitForElement textAny", () => {
  test("skips off-screen earlier variants when a later variant is visible", () => {
    const finder = new DefaultElementFinder();
    const hierarchy = makeHierarchy([
      { $: { text: "Done", bounds: bounds(-300, 0, -200, 50) } },
      { $: { text: "Add", bounds: bounds(20, 20, 120, 70) } },
    ]);

    const element = findWaitForElement(finder, { textAny: ["Done", "Add"] }, hierarchy);

    expect(element?.text).toBe("Add");
    expect(element?.bounds).toEqual(bounds(20, 20, 120, 70));
  });

  test("returns null when every matched variant is off-screen", () => {
    const finder = new DefaultElementFinder();
    const hierarchy = makeHierarchy([
      { $: { text: "Done", bounds: bounds(-300, 0, -200, 50) } },
      { $: { text: "Add", bounds: bounds(220, 20, 320, 70) } },
    ]);

    const element = findWaitForElement(finder, { textAny: ["Done", "Add"] }, hierarchy);

    expect(element).toBeNull();
  });

  test("checks visible duplicate matches before trying later variants", () => {
    const finder = new DefaultElementFinder();
    const hierarchy = makeHierarchy([
      { $: { text: "Done", bounds: bounds(-300, 0, -200, 50) } },
      { $: { text: "Done", bounds: bounds(20, 20, 120, 70) } },
      { $: { text: "Add", bounds: bounds(20, 90, 120, 140) } },
    ]);

    const element = findWaitForElement(finder, { textAny: ["Done", "Add"] }, hierarchy);

    expect(element?.text).toBe("Done");
    expect(element?.bounds).toEqual(bounds(20, 20, 120, 70));
  });
});

describe("findWaitForElement rich predicates", () => {
  test("matches all specified element fields on the same node by default", () => {
    const finder = new DefaultElementFinder();
    const hierarchy = makeHierarchy([
      {
        $: {
          text: "Home",
          "resource-id": "home_label",
          class: "android.widget.TextView",
          bounds: bounds(10, 10, 110, 60),
        },
      },
      {
        $: {
          text: "Settings",
          "resource-id": "home_tab",
          class: "android.widget.BottomNavigationView",
          "content-desc": "Home tab",
          bounds: bounds(10, 80, 190, 140),
        },
      },
    ]);

    const element = findWaitForElement(
      finder,
      {
        elementId: "home_tab",
        className: "android.widget.BottomNavigationView",
        contentDescription: "Home tab",
      } as any,
      hierarchy,
    );

    expect(element?.["resource-id"]).toBe("home_tab");
    expect(element?.class).toBe("android.widget.BottomNavigationView");
  });

  test("ignores camelCase className attributes on parsed elements", () => {
    const finder = new DefaultElementFinder();
    const hierarchy = makeHierarchy([
      {
        $: {
          className: "android.widget.BottomNavigationView",
          bounds: bounds(10, 80, 190, 140),
        },
      },
    ]);

    const element = findWaitForElement(
      finder,
      {
        className: "android.widget.BottomNavigationView",
      } as any,
      hierarchy,
    );

    expect(element).toBeNull();
  });

  test.each([
    {
      label: "contentDescription",
      attributes: { contentDescription: "Home tab" },
    },
    {
      label: "accessibilityLabel",
      attributes: { accessibilityLabel: "Home tab" },
    },
  ])("ignores camelCase $label attributes on parsed elements", ({ attributes }) => {
    const finder = new DefaultElementFinder();
    const hierarchy = makeHierarchy([
      {
        $: {
          ...attributes,
          bounds: bounds(10, 80, 190, 140),
        },
      },
    ]);

    const element = findWaitForElement(
      finder,
      {
        contentDescription: "Home tab",
      } as any,
      hierarchy,
    );

    expect(element).toBeNull();
  });

  test("requires elementId and text to match the same node", () => {
    const finder = new DefaultElementFinder();
    const hierarchy = makeHierarchy([
      {
        $: {
          text: "Profile",
          "resource-id": "home_tab",
          bounds: bounds(10, 10, 110, 60),
        },
      },
      {
        $: {
          text: "Home",
          "resource-id": "other_tab",
          bounds: bounds(10, 80, 190, 140),
        },
      },
      {
        $: {
          text: "Home",
          "resource-id": "home_tab",
          bounds: bounds(10, 150, 190, 190),
        },
      },
    ]);

    const element = findWaitForElement(
      finder,
      {
        elementId: "home_tab",
        text: "Home",
      } as any,
      hierarchy,
    );

    expect(element?.bounds).toEqual(bounds(10, 150, 190, 190));
  });

  test("does not satisfy elementId and text across different nodes", () => {
    const finder = new DefaultElementFinder();
    const hierarchy = makeHierarchy([
      {
        $: {
          text: "Profile",
          "resource-id": "home_tab",
          bounds: bounds(10, 10, 110, 60),
        },
      },
      {
        $: {
          text: "Home",
          "resource-id": "other_tab",
          bounds: bounds(10, 80, 190, 140),
        },
      },
    ]);

    const element = findWaitForElement(
      finder,
      {
        elementId: "home_tab",
        text: "Home",
      } as any,
      hierarchy,
    );

    expect(element).toBeNull();
  });

  test("scopes rich predicates to the requested container", () => {
    const finder = new DefaultElementFinder();
    const hierarchy = makeHierarchy([
      {
        $: {
          "resource-id": "outside_container",
          bounds: bounds(0, 0, 200, 80),
        },
        node: [
          {
            $: {
              "resource-id": "home_tab",
              class: "UITabBar",
              "content-desc": "Home tab",
              bounds: bounds(10, 10, 190, 60),
            },
          },
        ],
      },
      {
        $: {
          "resource-id": "target_container",
          bounds: bounds(0, 90, 200, 190),
        },
        node: [
          {
            $: {
              "resource-id": "settings_tab",
              class: "UITabBar",
              "content-desc": "Settings tab",
              bounds: bounds(10, 110, 190, 160),
            },
          },
        ],
      },
    ]);

    const element = findWaitForElement(
      finder,
      {
        className: "UITabBar",
        contentDescription: "Settings tab",
        container: { elementId: "target_container" },
      } as any,
      hierarchy,
    );

    expect(element?.["resource-id"]).toBe("settings_tab");
  });

  test("returns null for rich predicates when the requested container is missing", () => {
    const finder = new DefaultElementFinder();
    const hierarchy = makeHierarchy([
      {
        $: {
          class: "UITabBar",
          "content-desc": "Home tab",
          bounds: bounds(10, 10, 190, 60),
        },
      },
    ]);

    const element = findWaitForElement(
      finder,
      {
        className: "UITabBar",
        contentDescription: "Home tab",
        container: { elementId: "missing_container" },
      } as any,
      hierarchy,
    );

    expect(element).toBeNull();
  });

  test("does not satisfy matchType all across different nodes", () => {
    const finder = new DefaultElementFinder();
    const hierarchy = makeHierarchy([
      { $: { text: "Home", bounds: bounds(10, 10, 110, 60) } },
      {
        $: {
          class: "UITabBar",
          "resource-id": "home_tab_bar",
          bounds: bounds(10, 80, 190, 140),
        },
      },
    ]);

    const element = findWaitForElement(
      finder,
      {
        text: "Home",
        className: "UITabBar",
        matchType: "all",
      } as any,
      hierarchy,
    );

    expect(element).toBeNull();
  });

  test("matches any specified element field when matchType is any", () => {
    const finder = new DefaultElementFinder();
    const hierarchy = makeHierarchy([
      {
        $: {
          class: "UITabBar",
          "resource-id": "home_tab_bar",
          bounds: bounds(10, 80, 190, 140),
        },
      },
    ]);

    const element = findWaitForElement(
      finder,
      {
        text: "Home",
        className: "UITabBar",
        matchType: "any",
      } as any,
      hierarchy,
    );

    expect(element?.class).toBe("UITabBar");
  });

  test("honors exact, contains, and regex text matching modes", () => {
    const finder = new DefaultElementFinder();
    const hierarchy = makeHierarchy([
      { $: { text: "Welcome Home", bounds: bounds(10, 10, 180, 60) } },
    ]);

    expect(
      findWaitForElement(finder, { text: "Home", textMatch: "contains" } as any, hierarchy)?.text,
    ).toBe("Welcome Home");
    expect(
      findWaitForElement(
        finder,
        { text: "^Welcome\\s+Home$", textMatch: "regex" } as any,
        hierarchy,
      )?.text,
    ).toBe("Welcome Home");
    expect(
      findWaitForElement(finder, { text: "Home", textMatch: "exact" } as any, hierarchy),
    ).toBeNull();
  });

  test("keeps contentDescription exact-only when textMatch is non-exact", () => {
    const finder = new DefaultElementFinder();
    const hierarchy = makeHierarchy([
      { $: { "content-desc": "Home tab", bounds: bounds(10, 10, 180, 60) } },
    ]);

    expect(
      findWaitForElement(
        finder,
        { contentDescription: "Home tab", textMatch: "exact" } as any,
        hierarchy,
      )?.["content-desc"],
    ).toBe("Home tab");
    expect(
      findWaitForElement(
        finder,
        { contentDescription: "Home", textMatch: "contains" } as any,
        hierarchy,
      ),
    ).toBeNull();
    expect(
      findWaitForElement(
        finder,
        { contentDescription: "^Home", textMatch: "regex" } as any,
        hierarchy,
      ),
    ).toBeNull();
  });

  test("matches iOS accessibility labels exposed as text for contentDescription", () => {
    const finder = new DefaultElementFinder();
    const hierarchy = makeHierarchy([
      {
        $: {
          text: "Home",
          class: "XCUIElementTypeButton",
          bounds: bounds(10, 10, 180, 60),
        },
      },
    ]);

    const element = findWaitForElement(
      finder,
      {
        contentDescription: "Home",
      } as any,
      hierarchy,
      "ios",
    );

    expect(element?.text).toBe("Home");
  });

  test("matches canonical iOS accessibility labels for contentDescription", () => {
    const finder = new DefaultElementFinder();
    const hierarchy = makeHierarchy([
      {
        $: {
          "ios-accessibility-label": "Home",
          class: "XCUIElementTypeButton",
          bounds: bounds(10, 10, 180, 60),
        },
      },
    ]);

    const element = findWaitForElement(
      finder,
      {
        contentDescription: "Home",
      } as any,
      hierarchy,
      "ios",
    );

    expect(element?.["ios-accessibility-label"]).toBe("Home");
  });

  test("does not match Android text-only nodes for contentDescription", () => {
    const finder = new DefaultElementFinder();
    const hierarchy = makeHierarchy([
      {
        $: {
          text: "Home",
          class: "android.widget.TextView",
          bounds: bounds(10, 10, 180, 60),
        },
      },
    ]);

    const element = findWaitForElement(
      finder,
      {
        contentDescription: "Home",
      } as any,
      hierarchy,
      "android",
    );

    expect(element).toBeNull();
  });
});

describe("waitForObservation activeWindow", () => {
  const makeObservation = (
    appId: string,
    activityName: string,
    nodes: unknown[] = [],
  ): ObserveResult => ({
    updatedAt: 0,
    screenSize: { width: 200, height: 200 },
    systemInsets: { top: 0, right: 0, bottom: 0, left: 0 },
    activeWindow: { appId, activityName, layoutSeqSum: 0 },
    viewHierarchy: makeHierarchy(nodes),
  });

  test("keeps polling until activeWindow and element predicates are both true", async () => {
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const observeScreen = new FakeObserveScreen();
    const observations = [
      makeObservation("com.browser", "", [
        { $: { class: "UITabBar", bounds: bounds(10, 10, 100, 60) } },
      ]),
      makeObservation("com.example.app", "com.example.app.HomeActivity", [
        { $: { class: "UITabBar", bounds: bounds(10, 10, 100, 60) } },
      ]),
    ];
    observeScreen.setObserveResult(() => observations.shift() ?? observations[0]);

    const outcome = await waitForObservation(
      observeScreen,
      {
        activeWindow: { appId: "com.example.app" },
        className: "UITabBar",
        timeout: 500,
      } as any,
      undefined,
      false,
      timer,
    );

    expect(outcome.awaitTimeout).toBe(false);
    expect(outcome.observation.activeWindow?.appId).toBe("com.example.app");
    expect(observeScreen.getExecuteCallCount()).toBe(2);
    expect(
      observeScreen.getExecuteOptions().every((options) => options.skipScreenshot === true),
    ).toBe(true);
    expect(observeScreen.getCaptureScreenshotCallCount()).toBe(0);
    expect(observeScreen.getAccessibilityAuditCallCount()).toBe(1);
    expect(shouldSkipObserveWaitForScreenshot()).toBe(true);
  });

  test("opt-in captures one terminal screenshot while every poll remains suppressed", async () => {
    process.env[OBSERVE_WAIT_FOR_SKIP_SCREENSHOT_ENV] = "0";
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const observeScreen = new FakeObserveScreen();
    const observations = [
      makeObservation("com.browser", "", [
        { $: { class: "UITabBar", bounds: bounds(10, 10, 100, 60) } },
      ]),
      makeObservation("com.example.app", "com.example.app.HomeActivity", [
        { $: { class: "UITabBar", bounds: bounds(10, 10, 100, 60) } },
      ]),
    ];
    observeScreen.setObserveResult(() => observations.shift() ?? observations[0]);

    const outcome = await waitForObservation(
      observeScreen,
      {
        activeWindow: { appId: "com.example.app" },
        className: "UITabBar",
        timeout: 500,
      } as any,
      undefined,
      false,
      timer,
    );

    expect(outcome.awaitTimeout).toBe(false);
    expect(observeScreen.getExecuteCallCount()).toBe(2);
    expect(observeScreen.getExecuteOptions().every((options) => options.skipScreenshot)).toBe(true);
    expect(
      observeScreen.getExecuteOptions().every((options) => options.skipAccessibilityAudit),
    ).toBe(true);
    expect(observeScreen.getCaptureScreenshotCallCount()).toBe(1);
    expect(observeScreen.getCapturedScreenshotObservations()).toEqual([outcome.observation]);
    expect(shouldSkipObserveWaitForScreenshot()).toBe(false);
  });

  test("an enabled accessibility audit captures one fresh terminal screenshot", async () => {
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const observeScreen = new FakeObserveScreen();
    const observations = [
      makeObservation("com.browser", "", [
        { $: { class: "UITabBar", bounds: bounds(10, 10, 100, 60) } },
      ]),
      makeObservation("com.example.app", "com.example.app.HomeActivity", [
        { $: { class: "UITabBar", bounds: bounds(10, 10, 100, 60) } },
      ]),
    ];
    observeScreen.setObserveResult(() => observations.shift() ?? observations[0]);
    serverConfig.setAccessibilityAuditConfig({
      level: "AA",
      failureMode: "report",
      useBaseline: false,
    });

    const outcome = await waitForObservation(
      observeScreen,
      {
        activeWindow: { appId: "com.example.app" },
        className: "UITabBar",
        timeout: 500,
      } as any,
      undefined,
      false,
      timer,
    );

    expect(outcome.awaitTimeout).toBe(false);
    expect(observeScreen.getExecuteOptions().every((options) => options.skipScreenshot)).toBe(true);
    expect(observeScreen.getCaptureScreenshotCallCount()).toBe(1);
    expect(observeScreen.getCapturedScreenshotObservations()).toEqual([outcome.observation]);
  });

  test("the declarative waitFor path also captures only its terminal screenshot", async () => {
    process.env[OBSERVE_WAIT_FOR_SKIP_SCREENSHOT_ENV] = "false";
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const observeScreen = new FakeObserveScreen();
    observeScreen.setObserveSequence([
      makeObservation("com.example.app", "com.example.app.HomeActivity"),
      makeObservation("com.example.app", "com.example.app.HomeActivity"),
    ]);

    const outcome = await waitForObservation(
      observeScreen,
      {
        for: "stable",
        timeout: 500,
        stableReads: 2,
      } as any,
      undefined,
      false,
      timer,
    );

    expect(outcome.settled).toBe(true);
    expect(observeScreen.getExecuteCallCount()).toBe(2);
    expect(observeScreen.getExecuteOptions().every((options) => options.skipScreenshot)).toBe(true);
    expect(observeScreen.getCaptureScreenshotCallCount()).toBe(1);
  });

  test("keeps polling until Android activityName matches", async () => {
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const observeScreen = new FakeObserveScreen();
    const observations = [
      makeObservation("com.example.app", "com.example.app.SplashActivity"),
      makeObservation("com.example.app", "com.example.app.HomeActivity"),
    ];
    observeScreen.setObserveResult(() => observations.shift() ?? observations[0]);

    const outcome = await waitForObservation(
      observeScreen,
      {
        activeWindow: {
          appId: "com.example.app",
          activityName: "com.example.app.HomeActivity",
        },
        timeout: 500,
      } as any,
      undefined,
      false,
      timer,
    );

    expect(outcome.awaitTimeout).toBe(false);
    expect(outcome.observation.activeWindow?.activityName).toBe("com.example.app.HomeActivity");
    expect(observeScreen.getExecuteCallCount()).toBe(2);
  });

  test("times out when only activeWindow appId matches but activityName does not", async () => {
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const observeScreen = new FakeObserveScreen();
    observeScreen.setObserveResult(() =>
      makeObservation("com.example.app", "com.example.app.SplashActivity"),
    );

    const outcome = await waitForObservation(
      observeScreen,
      {
        activeWindow: {
          appId: "com.example.app",
          activityName: "com.example.app.HomeActivity",
        },
        timeout: 250,
      } as any,
      undefined,
      false,
      timer,
    );

    expect(outcome.awaitTimeout).toBe(true);
    expect(observeScreen.getExecuteCallCount()).toBeGreaterThan(1);
  });

  test("ignores Android-only activityName on iOS", async () => {
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const observeScreen = new FakeObserveScreen();
    observeScreen.setObserveResult(() => makeObservation("com.example.ios", ""));

    const outcome = await waitForObservation(
      observeScreen,
      {
        activeWindow: {
          appId: "com.example.ios",
          activityName: "com.example.ios.IgnoredActivity",
        },
        timeout: 250,
      } as any,
      undefined,
      false,
      timer,
      "ios",
    );

    expect(outcome.awaitTimeout).toBe(false);
    expect(observeScreen.getExecuteCallCount()).toBe(1);
  });

  test("rejects iOS activeWindow with only Android activityName", () => {
    expect(() =>
      observeSchema.parse({
        platform: "ios",
        waitFor: {
          activeWindow: {
            activityName: "com.example.ios.IgnoredActivity",
          },
          timeout: 250,
        },
      }),
    ).toThrow("activityName is Android-only; use appId/bundleId on iOS");
  });

  test("times out when only the element predicate matches", async () => {
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const observeScreen = new FakeObserveScreen();
    observeScreen.setObserveResult(() =>
      makeObservation("com.browser", "", [
        { $: { class: "UITabBar", bounds: bounds(10, 10, 100, 60) } },
      ]),
    );

    const outcome = await waitForObservation(
      observeScreen,
      {
        activeWindow: { appId: "com.example.app" },
        className: "UITabBar",
        timeout: 250,
      } as any,
      undefined,
      false,
      timer,
    );

    expect(outcome.awaitTimeout).toBe(true);
    expect(outcome.awaitedElement).toBeUndefined();
    expect(observeScreen.getExecuteCallCount()).toBeGreaterThan(1);
  });
});

// --- Issue #3490: settled (stability) gate ------------------------------------

describe("observeSchema settled", () => {
  test("accepts settled with a waitFor predicate", () => {
    const parsed = observeSchema.parse({
      platform: "android",
      waitFor: { elementId: "home_tab_bar", timeout: 15000 },
      settled: { quietPeriodMs: 500 },
    });
    expect(parsed.settled).toEqual({ quietPeriodMs: 500 });
  });

  test("rejects settled without a waitFor predicate", () => {
    expect(
      observeSchema.safeParse({
        platform: "android",
        settled: { quietPeriodMs: 500 },
      }).success,
    ).toBe(false);
  });

  test("rejects non-positive quietPeriodMs", () => {
    expect(
      observeSchema.safeParse({
        platform: "android",
        waitFor: { elementId: "home_tab_bar" },
        settled: { quietPeriodMs: 0 },
      }).success,
    ).toBe(false);
  });
});

describe("waitForObservation settled", () => {
  const makeObservation = (markerId: string): ObserveResult => ({
    updatedAt: 0,
    screenSize: { width: 200, height: 200 },
    systemInsets: { top: 0, right: 0, bottom: 0, left: 0 },
    activeWindow: { appId: "com.example.app", activityName: "", layoutSeqSum: 0 },
    viewHierarchy: makeHierarchy([
      { $: { "resource-id": "home_tab_bar", bounds: bounds(10, 10, 100, 60) } },
      { $: { "resource-id": markerId, bounds: bounds(10, 80, 100, 120) } },
    ]),
  });

  test("waits for a quiet hierarchy period after the predicate first matches", async () => {
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const observeScreen = new FakeObserveScreen();
    let call = 0;
    // Predicate (home_tab_bar) matches from the first observation, but the tree
    // keeps changing for the first three observations before it stabilizes.
    observeScreen.setObserveResult(() => {
      call++;
      return makeObservation(call <= 3 ? `marker_${call}` : "marker_stable");
    });

    const outcome = await waitForObservation(
      observeScreen,
      {
        elementId: "home_tab_bar",
        settled: { quietPeriodMs: 300 },
        timeout: 5000,
      } as any,
      undefined,
      false,
      timer,
    );

    expect(outcome.awaitTimeout).toBe(false);
    // Must have kept polling past the first match to confirm the quiet period.
    expect(observeScreen.getExecuteCallCount()).toBeGreaterThan(4);
    expect(outcome.awaitedElement?.["resource-id"]).toBe("home_tab_bar");
  });

  test("times out when the hierarchy never settles", async () => {
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const observeScreen = new FakeObserveScreen();
    let call = 0;
    // Predicate always matches, but every observation is a different tree, so it
    // never reaches a quiet period.
    observeScreen.setObserveResult(() => {
      call++;
      return makeObservation(`marker_${call}`);
    });

    const outcome = await waitForObservation(
      observeScreen,
      {
        elementId: "home_tab_bar",
        settled: { quietPeriodMs: 300 },
        timeout: 500,
      } as any,
      undefined,
      false,
      timer,
    );

    expect(outcome.awaitTimeout).toBe(true);
  });
});

// --- Issue #3490: absence / negation predicate --------------------------------

describe("observeSchema waitFor.absent", () => {
  test("accepts absent combined with a positive predicate", () => {
    const parsed = observeSchema.parse({
      platform: "ios",
      waitFor: {
        absent: { className: "UIActivityIndicatorView" },
        elementId: "message_list",
        timeout: 15000,
      },
    });
    expect(parsed.waitFor).toMatchObject({
      absent: { className: "UIActivityIndicatorView" },
      elementId: "message_list",
    });
  });

  test("accepts absent alone", () => {
    const parsed = observeSchema.parse({
      platform: "ios",
      waitFor: { absent: { className: "UIActivityIndicatorView" } },
    });
    expect(parsed.waitFor).toMatchObject({
      absent: { className: "UIActivityIndicatorView" },
    });
  });

  test("accepts absent combined with textAny", () => {
    const parsed = observeSchema.parse({
      platform: "android",
      waitFor: {
        textAny: ["Home", "Feed"],
        absent: { elementId: "com.app:id/spinner" },
      },
    });
    expect(parsed.waitFor).toMatchObject({
      textAny: ["Home", "Feed"],
      absent: { elementId: "com.app:id/spinner" },
    });
  });

  test("rejects an empty absent object", () => {
    expect(
      observeSchema.safeParse({
        platform: "android",
        waitFor: { absent: {} },
      }).success,
    ).toBe(false);
  });
});

describe("waitForObservation absent", () => {
  const makeObservation = (nodes: unknown[]): ObserveResult => ({
    updatedAt: 0,
    screenSize: { width: 200, height: 200 },
    systemInsets: { top: 0, right: 0, bottom: 0, left: 0 },
    activeWindow: { appId: "com.example.app", activityName: "", layoutSeqSum: 0 },
    viewHierarchy: makeHierarchy(nodes),
  });

  const spinner = { $: { class: "UIActivityIndicatorView", bounds: bounds(10, 10, 50, 50) } };
  const list = { $: { "resource-id": "message_list", bounds: bounds(10, 60, 190, 190) } };

  test("resolves once the absent element disappears and the positive predicate is present", async () => {
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const observeScreen = new FakeObserveScreen();
    const observations = [makeObservation([spinner, list]), makeObservation([list])];
    observeScreen.setObserveResult(() => observations.shift() ?? observations[0]);

    const outcome = await waitForObservation(
      observeScreen,
      {
        absent: { className: "UIActivityIndicatorView" },
        elementId: "message_list",
        timeout: 500,
      } as any,
      undefined,
      false,
      timer,
    );

    expect(outcome.awaitTimeout).toBe(false);
    expect(outcome.awaitedElement?.["resource-id"]).toBe("message_list");
    expect(observeScreen.getExecuteCallCount()).toBe(2);
  });

  test("keeps waiting while the absent element is still present", async () => {
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const observeScreen = new FakeObserveScreen();
    observeScreen.setObserveResult(() => makeObservation([spinner, list]));

    const outcome = await waitForObservation(
      observeScreen,
      {
        absent: { className: "UIActivityIndicatorView" },
        elementId: "message_list",
        timeout: 250,
      } as any,
      undefined,
      false,
      timer,
    );

    expect(outcome.awaitTimeout).toBe(true);
    expect(observeScreen.getExecuteCallCount()).toBeGreaterThan(1);
  });

  test("absent-only predicate resolves when the element is gone", async () => {
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const observeScreen = new FakeObserveScreen();
    const observations = [makeObservation([spinner]), makeObservation([])];
    observeScreen.setObserveResult(() => observations.shift() ?? observations[0]);

    const outcome = await waitForObservation(
      observeScreen,
      {
        absent: { className: "UIActivityIndicatorView" },
        timeout: 500,
      } as any,
      undefined,
      false,
      timer,
    );

    expect(outcome.awaitTimeout).toBe(false);
    expect(observeScreen.getExecuteCallCount()).toBe(2);
  });
});
