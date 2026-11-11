import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseCarPlayTemplateDocument } from "../../src/models/CarPlayTemplates";

// Inline contract examples, not captured simulator snapshots.
const disabled = {
  schemaVersion: 1,
  enabled: false,
  connected: false,
  templates: [],
  truncated: false,
};

describe("CarPlay template documents", () => {
  test("parses disabled and preserves additive fields", () => {
    expect(parseCarPlayTemplateDocument({ ...disabled, future: true }).future).toBe(true);
  });
  test("validates nested templates", () => {
    const template = {
      id: "stack/0",
      type: "tabBar",
      tabs: [
        {
          id: "stack/0/tabs/0",
          type: "tab",
          selected: true,
          template: {
            id: "stack/0/tabs/0/template",
            type: "list",
            sections: [
              {
                id: "stack/0/tabs/0/template/sections/0",
                type: "section",
                header: "Stations",
                items: [
                  {
                    id: "stack/0/tabs/0/template/sections/0/items/0",
                    type: "item",
                    text: "North",
                    enabled: true,
                    hasImage: false,
                  },
                ],
              },
            ],
          },
        },
      ],
    };
    expect(
      parseCarPlayTemplateDocument({
        ...disabled,
        enabled: true,
        connected: true,
        templates: [template],
      }).templates,
    ).toEqual([template]);
  });
  test("preserves unknown types and parses optional presentation and errors", () => {
    const presented = { id: "presented", type: "alert", titleVariants: ["Notice"] };
    const document = parseCarPlayTemplateDocument({
      ...disabled,
      enabled: true,
      connected: true,
      templates: [{ id: "stack/0", type: "unknown", className: "FutureTemplate", futureField: 1 }],
      presented,
      error: "example",
    });
    expect(document.presented).toEqual(presented);
    expect(document.templates[0]?.futureField).toBe(1);
    expect(document.error).toBe("example");
  });
  test("rejects malformed document and nested values", () => {
    expect(() => parseCarPlayTemplateDocument({ ...disabled, connected: "false" })).toThrow();
    expect(() =>
      parseCarPlayTemplateDocument({
        ...disabled,
        templates: [
          { id: "stack/0", type: "grid", buttons: [{ id: "b", type: "button", enabled: "yes" }] },
        ],
      }),
    ).toThrow();
  });
});

// Real output of the SDK's CarPlay serializer, produced on an iOS 27.0 simulator from in-memory
// CPTabBarTemplate/CPListTemplate/CPGridTemplate instances with the CarPlayFixture's content, and the
// route's response before any controller is registered (served by the fixture app on the simulator).
const fixture = (name: string): unknown =>
  JSON.parse(readFileSync(join(import.meta.dir, "../fixtures/ios-carplay", name), "utf8"));

describe("captured CarPlay snapshots", () => {
  test("parses the route answer of an app that has not registered", () => {
    const document = parseCarPlayTemplateDocument(fixture("templates-not-registered-route.json"));
    expect(document.enabled).toBe(false);
    expect(document.connected).toBe(false);
    expect(document.templates).toEqual([]);
  });

  test("parses a tab bar over a pushed list with stable path ids", () => {
    const document = parseCarPlayTemplateDocument(fixture("templates-tabbar-and-pushed-list.json"));
    expect(document.connected).toBe(true);
    expect(document.templates.map((template) => template.id)).toEqual(["stack/0", "stack/1"]);
    const [list, grid] = document.templates[0].tabs ?? [];
    expect(list.template?.sections?.map((section) => section.header)).toEqual([
      "Nearby",
      "Favorites",
    ]);
    expect(list.template?.sections?.[0].items?.[0].id).toBe(
      "stack/0/tabs/0/template/sections/0/items/0",
    );
    expect(grid.template?.buttons?.map((button) => button.titleVariants)).toEqual([
      ["Start"],
      ["Status"],
    ]);
    expect(document.templates[1].title).toBe("Charger details");
  });
});
