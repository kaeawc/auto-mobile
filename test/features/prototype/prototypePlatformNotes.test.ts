import { PROTOTYPE_ICON_SF_SYMBOLS_CAPABILITY } from "../../../src/features/observe/android/ctrlProxyProtocol";
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
    "../../../ios/prototype-agent/Sources/AutoMobilePrototypeAgentCore/PrototypeAgentProtocol.swift",
    import.meta.url,
  ),
  "utf8",
);
const noCapabilities = () => false;
const specFor = (root: PrototypeNode): PrototypeSpec => ({
  id: "panel",
  window: { placement: { type: "fullscreen" }, opacity: 1 },
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
    PROTOTYPE_PLATFORM_DIFFERENCES.filter(({ capability }) => capability !== undefined).map(
      ({ construct, capability }) => [construct, capability] as const,
    ),
  )("%s is lifted by its capability", (construct, capability) => {
    const notes = prototypePlatformNotes(spec, "ios", (name) => name === capability);
    expect(notes.some((note) => note.construct === construct)).toBe(false);
    expect(notes.length).toBe(
      capability === "prototype_bottom_sheet_drag_v1"
        ? 3
        : capability === "prototype_text_field_material_style_v1"
          ? 5
          : 4,
    );
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
  test("pins the SF Symbols capability to the agent without advertising Material parity", () => {
    expect(IOS_PROTOTYPE_MAPPED_ICON_NAMES.size).toBe(55);
    expect(swift).toContain(
      `static let iconSfSymbolsCapability = "${PROTOTYPE_ICON_SF_SYMBOLS_CAPABILITY}"`,
    );
    expect(swift).toContain("        iconSfSymbolsCapability,");
    expect(swift).not.toContain("prototype_icon_set_material_v1");
    expect(swift).not.toContain("prototype_icon_variant_v1");
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
        {
          type: "scroll",
          axis: "vertical",
          id: "scroll",
          child: { type: "text", id: "inner", text: "Hi" },
        },
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
  test("guide generates every platform difference from the table", () => {
    const guide = renderPrototypeGuide();
    expect(guide).toContain("## Platform differences");
    expect(guide).toContain("platformNotes");
    expect(guide).toContain("iOS draws SF Symbols:");
    expect(guide).toContain("filled/outlined map where a form exists");
    expect(guide).toContain("rounded/sharp/twoTone");
    for (const difference of PROTOTYPE_PLATFORM_DIFFERENCES) {
      expect(guide).toContain(`\`${difference.construct}\``);
      if (!difference.construct.startsWith("icon.")) {
        if (difference.capability) {
          expect(
            difference.detail.startsWith(`An iOS agent without ${difference.capability} `),
          ).toBe(true);
        }
        expect(guide).toContain(difference.detail);
      }
      if (difference.capability) {
        expect(guide).toContain(difference.capability);
      }
    }
  });
});

const currentAgent = (name: string) => name === PROTOTYPE_ICON_SF_SYMBOLS_CAPABILITY;
describe("SF Symbols agent platform notes", () => {
  test("notes unmapped names with values and leaves mapped defaults alone", () => {
    const notes = prototypePlatformNotes(
      specFor({ type: "icon", name: "android" }),
      "ios",
      currentAgent,
    );
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({
      construct: "icon.name",
      effect: "substituted",
      paths: ["root.name"],
      values: ["android"],
    });
    expect(notes[0].detail).toContain("no SF Symbol equivalent");
    expect(
      prototypePlatformNotes(specFor({ type: "icon", name: "ac_unit" }), "ios", currentAgent),
    ).toEqual([]);
  });
  test.each(["filled", "outlined"] as const)("%s with a form needs no note", (variant) => {
    expect(
      prototypePlatformNotes(specFor({ type: "icon", name: "home", variant }), "ios", currentAgent),
    ).toEqual([]);
  });
  test.each(["filled", "outlined", "rounded", "sharp", "twoTone"] as const)(
    "%s without an SF form substitutes the default",
    (variant) => {
      const notes = prototypePlatformNotes(
        specFor({ type: "icon", name: "wifi", variant }),
        "ios",
        currentAgent,
      );
      expect(notes).toHaveLength(1);
      expect(notes[0]).toMatchObject({
        construct: "icon.variant",
        effect: "substituted",
        paths: ["root.variant"],
      });
    },
  );
  test.each(["rounded", "sharp", "twoTone"] as const)(
    "%s substitutes even for a fill/outline pair",
    (variant) => {
      expect(
        prototypePlatformNotes(
          specFor({ type: "icon", name: "home", variant }),
          "ios",
          currentAgent,
        )[0]?.construct,
      ).toBe("icon.variant");
    },
  );
  test("an unmapped variant is covered only by the name note", () => {
    const notes = prototypePlatformNotes(
      specFor({ type: "icon", name: "android", variant: "filled" }),
      "ios",
      currentAgent,
    );
    expect(notes.map((note) => note.construct)).toEqual(["icon.name"]);
  });
  test("container variants are not icon variants", () => {
    expect(
      prototypePlatformNotes(
        specFor({ type: "iconButton", icon: "wifi", variant: "outlined" }),
        "ios",
        currentAgent,
      ),
    ).toEqual([]);
  });
  test("Material parity capabilities still lift both notes", () => {
    const notes = prototypePlatformNotes(
      specFor({ type: "icon", name: "android", variant: "sharp" }),
      "ios",
      (name) =>
        currentAgent(name) ||
        name === "prototype_icon_set_material_v1" ||
        name === "prototype_icon_variant_v1",
    );
    expect(notes).toEqual([]);
    expect(
      prototypePlatformNotes(
        specFor({ type: "icon", name: "wifi", variant: "sharp" }),
        "ios",
        (name) => currentAgent(name) || name === "prototype_icon_variant_v1",
      ),
    ).toEqual([]);
  });
  test("caps current-agent paths and keeps all distinct names", () => {
    const root: PrototypeNode = {
      type: "column",
      children: Array.from({ length: 22 }, (_, index) => ({
        type: "icon",
        name: index === 21 ? "facebook" : "android",
      })),
    };
    const notes = prototypePlatformNotes(specFor(root), "ios", currentAgent);
    expect(notes[0]).toMatchObject({ total: 22, values: ["android", "facebook"] });
    expect(notes[0].paths).toHaveLength(20);
  });
});

describe("text field platform notes", () => {
  test("outlined and label substitute; maxLength and filled do not", () => {
    const fields = specFor({
      type: "textField",
      stateKey: "name",
      variant: "outlined",
      label: "Name",
      maxLength: 20,
    });
    const notes = prototypePlatformNotes(fields, "ios", noCapabilities);
    expect(notes.map(({ construct, effect, paths }) => ({ construct, effect, paths }))).toEqual([
      { construct: "textField.variant", effect: "substituted", paths: ["root.variant"] },
      { construct: "textField.label", effect: "substituted", paths: ["root.label"] },
    ]);
    expect(
      prototypePlatformNotes(
        fields,
        "ios",
        (name) => name === "prototype_text_field_material_style_v1",
      ),
    ).toEqual([]);
    expect(prototypePlatformNotes(fields, "android", noCapabilities)).toEqual([]);
    expect(
      prototypePlatformNotes(
        specFor({ type: "textField", stateKey: "name", variant: "filled", maxLength: 20 }),
        "ios",
        noCapabilities,
      ),
    ).toEqual([]);
  });
});

test("stack back gesture remains a platform difference on capable devices", () => {
  const stackSpec = specFor({
    type: "stack",
    id: "nav",
    start: "home",
    screens: { home: { type: "text", text: "Home" } },
  });
  expect(prototypePlatformNotes(stackSpec, "ios", () => true)).toEqual([
    expect.objectContaining({
      construct: "stack",
      paths: ["root"],
      detail: expect.stringContaining("left-edge swipe"),
    }),
  ]);
});

import { prototypeStringsFallbackNotes } from "../../../src/features/prototype/prototypePlatformNotes";
test("fallback notes use referenced keys, region chain, opacity and a twenty-key cap", () => {
  const value = {
    ...specFor({ type: "text", text: "{t:title} {t:missing} {t:missing}" }),
    strings: {
      default: { title: "Title", missing: "Fallback", unused: "Unused" },
      fr: { title: "Titre" },
    },
  };
  expect(prototypeStringsFallbackNotes(value, "fr-CA")).toMatchObject([
    {
      platform: "all",
      construct: "strings.fallback",
      paths: ["strings.default.missing"],
      values: ["missing"],
    },
  ]);
  expect(prototypeStringsFallbackNotes(value)).toEqual([]);
  expect(
    prototypeStringsFallbackNotes({ ...value, root: { type: "text", text: "{t:title}" } }, "FR-ca"),
  ).toEqual([]);
  const keys = Array.from({ length: 25 }, (_, i) => `key${i}`);
  const capped = prototypeStringsFallbackNotes(
    {
      ...value,
      strings: { default: Object.fromEntries(keys.map((key) => [key, "Text"])) },
      root: { type: "text", text: keys.map((key) => `{t:${key}}`).join(" ") },
    },
    "de",
  );
  expect(capped[0]?.paths).toHaveLength(20);
  expect(capped[0]?.values).toHaveLength(20);
  expect(capped[0]?.total).toBe(25);
});
