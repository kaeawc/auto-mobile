import { beforeAll, describe, expect, test } from "bun:test";
import contract from "../../schemas/prototype-spec-contract.json";
import { validatePrototypeSpec } from "../../src/features/prototype/prototypeValidation";
import {
  PROTOTYPE_APPEARANCE_CAPABILITY,
  PROTOTYPE_THEME_MODES_CAPABILITY,
} from "../../src/features/observe/android/ctrlProxyProtocol";
import {
  PROTOTYPE_APPEARANCE_INPUTS,
  PROTOTYPE_APPEARANCE_SOURCES,
} from "../../src/features/prototype/prototypeAppearance";
import { prototypeSchema } from "../../src/server/prototypeTools";
import { ResourceRegistry } from "../../src/server/resourceRegistry";
import { registerPrototypeResources } from "../../src/server/prototypeResources";
import {
  ICON_LOOKUP_LIMIT,
  renderLimitsTable,
  renderPrototypeGuide,
  searchIcons,
} from "../../src/features/prototype/prototypeGuide";

async function read(uri: string): Promise<string> {
  const direct = ResourceRegistry.getResource(uri);
  if (direct) {
    return (await direct.handler()).text ?? "";
  }
  const match = ResourceRegistry.matchTemplate(uri);
  if (!match || !("handler" in match.template)) {
    throw new Error(`no resource for ${uri}`);
  }
  return (await match.template.handler(match.params)).text ?? "";
}

describe("automobile:prototype resource", () => {
  beforeAll(() => registerPrototypeResources());

  test("is listed and readable", async () => {
    expect(ResourceRegistry.getResourceDefinitions().map((r) => r.uri)).toContain(
      "automobile:prototype",
    );
    expect(ResourceRegistry.getTemplateDefinitions().map((t) => t.uriTemplate)).toContain(
      "automobile:prototype/icons{?query}",
    );
    expect(await read("automobile:prototype")).toContain("# Prototype authoring guide");
  });

  test("limits table matches the contract", () => {
    const table = renderLimitsTable();
    for (const [name, value] of Object.entries(contract.limits)) {
      expect(table).toContain(`| \`${name}\` | ${value} |`);
    }
  });

  test("mentions every node type, action type and theme role in the contract", () => {
    const guide = renderPrototypeGuide();
    const defs = contract.definitions as unknown as Record<
      string,
      { variants?: Record<string, unknown>; values?: string[] }
    >;
    for (const type of [
      ...Object.keys(defs.node.variants ?? {}),
      ...Object.keys(defs.action.variants ?? {}),
    ]) {
      expect(guide).toContain(`\`${type}\``);
    }
    expect(defs.colorRole.values?.length).toBeGreaterThan(0);
    for (const role of defs.colorRole.values ?? []) {
      expect(guide).toContain(`\`${role}\``);
    }
  });

  test("icon lookup finds, caps and rejects empty queries", async () => {
    const found = JSON.parse(await read("automobile:prototype/icons?query=ARROW_back"));
    expect(found.names).toContain("arrow_back");
    expect(found.total).toBe(searchIcons("arrow_back").total);
    const capped = searchIcons("a");
    expect(capped.names).toHaveLength(ICON_LOOKUP_LIMIT);
    expect(capped.total).toBeGreaterThan(ICON_LOOKUP_LIMIT);
    expect(searchIcons("  ").names).toEqual([]);
  });

  test("runtime cost follows icons, precedes validation errors and cites the runtime issues", () => {
    const guide = renderPrototypeGuide();
    const icons = guide.indexOf("## Icons");
    const cost = guide.indexOf("## Runtime cost");
    const errors = guide.indexOf("## Common validation errors");
    expect(icons).toBeGreaterThanOrEqual(0);
    expect(cost).toBeGreaterThan(icons);
    expect(errors).toBeGreaterThan(cost);
    const section = guide.slice(cost, errors);
    for (const issue of [
      "#12133",
      "#12134",
      "#12135",
      "#12136",
      "#12138",
      "#12139",
      "#12140",
      "#12160",
      "#12162",
    ]) {
      expect(section).toContain(issue);
    }
  });

  test("the guide's JSON examples are valid specs", () => {
    const blocks = [...renderPrototypeGuide().matchAll(/```json\n([\s\S]*?)```/g)].map((m) =>
      JSON.parse(m[1]),
    );
    expect(blocks).toHaveLength(5);
    const [minimal, list, data, components, appearanceCall] = blocks;
    expect(validatePrototypeSpec(data)).toMatchObject({ success: true });
    expect(validatePrototypeSpec(minimal).success).toBe(true);
    // The light/dark section's example is a whole tool call, not a bare spec.
    expect(prototypeSchema.safeParse(appearanceCall)).toMatchObject({ success: true });
    expect(appearanceCall.appearance).toBe("dark");
    expect(validatePrototypeSpec(components)).toMatchObject({ success: true });
    const wrapped = {
      id: "list",
      window: { placement: { type: "fullscreen" } },
      state: { picked: "" },
      root: list,
    };
    expect(validatePrototypeSpec(wrapped)).toMatchObject({ success: true });
  });

  test("the light and dark section states the owner-decided rules and the names the tool uses", () => {
    const guide = renderPrototypeGuide();
    const section = guide.slice(guide.indexOf("## Light and dark mode"), guide.indexOf("## Icons"));
    expect(section.length).toBeGreaterThan(0);
    for (const name of [
      PROTOTYPE_APPEARANCE_CAPABILITY,
      PROTOTYPE_THEME_MODES_CAPABILITY,
      ...PROTOTYPE_APPEARANCE_INPUTS,
      ...PROTOTYPE_APPEARANCE_SOURCES,
      "appearance_changed",
      "theme.colors.light",
      "theme.colors.dark",
      "{light, dark}",
      "displayConfig",
      "0.4 alpha",
    ]) {
      expect(section).toContain(name);
    }
    // The override is the last step before the device, after everything the spec itself says.
    const order = ["(`explicit`)", "(`roleLuminance`)", "(`authoredBackground`)", "(`override`)"];
    const positions = order.map((step) => section.indexOf(step));
    expect(positions.every((position) => position > 0)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
    expect(section).toContain("(`override`), else\n   the device's own setting (`system`)");
  });
});

test("the Data guide describes bindings, ownership, reporting, capability and errors", () => {
  const guide = renderPrototypeGuide();
  const section = guide.slice(guide.indexOf("## Data"), guide.indexOf("## Reuse"));
  for (const text of [
    "agent-owned",
    "read-only",
    "RFC 6901",
    "repeat.items: {path}",
    "repeat.key",
    "{data:/pointer}",
    "prototype_data_model_v1",
    "once per show",
    "inspect",
    "Events never carry data",
  ]) {
    expect(section).toContain(text);
  }
  expect(guide).toContain("Repeat placeholder in a data condition operand is not supported");
  expect(guide).toContain("Requires key or data");
});
