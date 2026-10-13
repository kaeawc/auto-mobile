import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  IOS_PROTOTYPE_MAPPED_ICON_NAMES,
  PROTOTYPE_PLATFORM_DIFFERENCES,
  prototypePlatformNotes,
} from "../../../src/features/prototype/prototypePlatformNotes";
import { renderPrototypeGuide } from "../../../src/features/prototype/prototypeGuide";
import {
  prototypeSpecSchema,
  type PrototypeNode,
  type PrototypeSpec,
} from "../../../src/features/prototype/prototypeSpec";

const swift = readFileSync(
  new URL(
    "../../../ios/prototype-agent/Sources/AutoMobilePrototypeAgent/PrototypeRenderer.swift",
    import.meta.url,
  ),
  "utf8",
);
const symbolBody = swift.match(/private let sfSymbols: \[String: String\] = \[([\s\S]*?)\n\]/)![1];
const swiftKeys = [...symbolBody.matchAll(/"([^"]+)"\s*:/g)].map((match) => match[1]);
const noCapabilities = () => false;
const specFor = (root: PrototypeNode): PrototypeSpec => ({
  id: "panel",
  window: { placement: { type: "fullscreen" } },
  root,
});
const spec = specFor({
  type: "column",
  children: [
    { type: "icon", id: "glyph", name: "alarm_add", variant: "outlined" },
    {
      type: "bottomSheet",
      openWhen: { key: "open", equals: true },
      detents: ["half", "full"],
      child: { type: "text", text: "Sheet" },
    },
  ],
});

describe("prototype platform notes", () => {
  test("reports all five iOS constructs with field paths and effects", () => {
    expect(prototypePlatformNotes(spec, "ios", noCapabilities)).toEqual([
      {
        platform: "ios",
        construct: "node.id",
        effect: "substituted",
        paths: ["root.children[0].id"],
        detail: PROTOTYPE_PLATFORM_DIFFERENCES[0].detail,
      },
      {
        platform: "ios",
        construct: "bottomSheet.dismissOnSwipe",
        effect: "ignored",
        paths: ["root.children[1].dismissOnSwipe"],
        detail: PROTOTYPE_PLATFORM_DIFFERENCES[1].detail,
      },
      {
        platform: "ios",
        construct: "bottomSheet.detents",
        effect: "ignored",
        paths: ["root.children[1].detents"],
        detail: PROTOTYPE_PLATFORM_DIFFERENCES[2].detail,
      },
      {
        platform: "ios",
        construct: "icon.name",
        effect: "substituted",
        paths: ["root.children[0].name"],
        values: ["alarm_add"],
        detail: PROTOTYPE_PLATFORM_DIFFERENCES[3].detail,
      },
      {
        platform: "ios",
        construct: "icon.variant",
        effect: "ignored",
        paths: ["root.children[0].variant"],
        detail: PROTOTYPE_PLATFORM_DIFFERENCES[4].detail,
      },
    ]);
  });
  test("Android returns no notes and does not query capabilities", () => {
    expect(
      prototypePlatformNotes(spec, "android", () => {
        throw new Error("No query expected");
      }),
    ).toEqual([]);
  });
  test.each(
    PROTOTYPE_PLATFORM_DIFFERENCES.map(
      ({ construct, capability }) => [construct, capability] as const,
    ),
  )("%s is lifted by its capability", (construct, capability) => {
    const notes = prototypePlatformNotes(spec, "ios", (name) => name === capability);
    expect(notes.some((note) => note.construct === construct)).toBe(false);
    expect(notes.length).toBe(capability === "prototype_bottom_sheet_drag_v1" ? 3 : 4);
  });
  test("testTag, mapped names, disabled swipe and a single detent need no notes", () => {
    const clean = specFor({
      type: "bottomSheet",
      id: "sheet",
      testTag: "shared",
      dismissOnSwipe: false,
      detents: ["half"],
      openWhen: { key: "open", equals: true },
      child: { type: "icon", name: "home" },
    });
    expect(prototypePlatformNotes(clean, "ios", noCapabilities)).toEqual([]);
    expect(prototypePlatformNotes(spec, "ios", () => true)).toEqual([]);
  });
  test("pins exactly the 55 iOS mapped names to the Swift source", () => {
    expect(IOS_PROTOTYPE_MAPPED_ICON_NAMES.size).toBe(55);
    expect(new Set(swiftKeys)).toEqual(IOS_PROTOTYPE_MAPPED_ICON_NAMES);
  });
  test("caps paths at 20, keeps total and all distinct sorted icon values", () => {
    const many = specFor({
      type: "column",
      children: Array.from({ length: 22 }, (_, index) => ({
        type: "icon",
        id: `n${index}`,
        name: index === 21 ? "access_alarm" : "alarm_add",
        variant: "filled",
      })),
    });
    const notes = prototypePlatformNotes(many, "ios", noCapabilities);
    for (const note of notes) {
      expect(note.paths).toHaveLength(20);
      expect(note.total).toBe(22);
    }
    expect(notes.find((note) => note.construct === "icon.name")?.values).toEqual([
      "access_alarm",
      "alarm_add",
    ]);
    const exactly = specFor({
      ...many.root,
      type: "column",
      children: (many.root as Extract<PrototypeNode, { type: "column" }>).children.slice(0, 20),
    });
    expect(
      prototypePlatformNotes(exactly, "ios", noCapabilities).every(
        (note) => note.total === undefined,
      ),
    ).toBe(true);
  });
  test("covers every schema icon slot without treating other variant fields as icon variants", () => {
    const allSlots = specFor({
      type: "column",
      children: [
        { type: "button", label: "Button", icon: "alarm_add", variant: "tonal" },
        { type: "iconButton", icon: "alarm_add", variant: "outlined" },
        { type: "fab", icon: "alarm_add" },
        {
          type: "listItem",
          headline: "Item",
          leadingIcon: "alarm_add",
          trailing: { type: "icon", name: "access_alarm" },
        },
        {
          type: "topAppBar",
          title: "Bar",
          navigationIcon: { icon: "alarm_add", label: "Back" },
          actions: [{ icon: "alarm_add", label: "Action" }],
        },
        { type: "tabBar", items: [{ label: "Tab", icon: "alarm_add" }], stateKey: "tab" },
        {
          type: "bottomNav",
          items: [
            { label: "A", icon: "alarm_add" },
            { label: "B", icon: "home" },
          ],
          stateKey: "nav",
        },
        {
          type: "dialog",
          icon: "alarm_add",
          openWhen: { key: "open", equals: true },
          confirm: { label: "OK" },
        },
      ],
    });
    expect(prototypeSpecSchema.safeParse(allSlots).success).toBe(true);
    const notes = prototypePlatformNotes(allSlots, "ios", noCapabilities);
    expect(notes).toHaveLength(1);
    expect(notes[0].paths).toEqual([
      "root.children[0].icon",
      "root.children[1].icon",
      "root.children[2].icon",
      "root.children[3].leadingIcon",
      "root.children[3].trailing.name",
      "root.children[4].navigationIcon.icon",
      "root.children[4].actions[0].icon",
      "root.children[5].items[0].icon",
      "root.children[6].items[0].icon",
      "root.children[7].icon",
    ]);
    expect(notes[0].values).toEqual(["access_alarm", "alarm_add"]);
  });
  test("walks nested child and children in tree order without mutating the spec", () => {
    const nested = specFor({
      type: "column",
      id: "outer",
      children: [
        { type: "scroll", id: "scroll", child: { type: "text", id: "inner", text: "Hi" } },
        { type: "text", id: "last", text: "Last" },
      ],
    });
    const before = JSON.stringify(nested);
    expect(prototypePlatformNotes(nested, "ios", noCapabilities)[0].paths).toEqual([
      "root.id",
      "root.children[0].id",
      "root.children[0].child.id",
      "root.children[1].id",
    ]);
    expect(JSON.stringify(nested)).toBe(before);
  });
  test("guide generates all five platform differences from the table", () => {
    const guide = renderPrototypeGuide();
    expect(guide).toContain("## Platform differences");
    expect(guide).toContain("platformNotes");
    for (const difference of PROTOTYPE_PLATFORM_DIFFERENCES) {
      expect(guide).toContain(`\`${difference.construct}\``);
      expect(guide).toContain(difference.detail);
      expect(guide).toContain(difference.capability);
    }
  });
});
