import { describe, expect, test } from "bun:test";
import contract from "../../../schemas/prototype-spec-contract.json";
import type { NativePrototypeSources } from "../../../src/features/prototype/nativePrototype";
import { PrototypeShownSpecs } from "../../../src/features/prototype/PrototypeShownSpecs";
import { readPrototypeEject } from "../../../src/features/prototype/prototypeEject";
import { composeDialect } from "../../../src/features/prototype/prototypeEjectCompose";
import {
  isEjectScaffoldType,
  PROTOTYPE_EJECT_MAPPING,
} from "../../../src/features/prototype/prototypeEjectMapping";
import { swiftUiDialect } from "../../../src/features/prototype/prototypeEjectSwiftUi";
import { ActionableError } from "../../../src/models/ActionableError";

const shop = {
  id: "shop",
  theme: { colors: { primary: "#6750A4", dark: { primary: "#80D0BCFF" } } },
  state: { email: "a@b.test", price: "$5", count: 3 },
  data: { items: [{ name: "a" }, { name: "b" }, { name: "c" }] },
  root: {
    type: "stack",
    id: "main",
    start: "home",
    screens: {
      home: {
        type: "column",
        testTag: "home",
        children: [
          { type: "text", text: "Total $5" },
          { type: "textField", stateKey: "email", label: "Email", testTag: "email" },
          { type: "textField", stateKey: "pin", secure: true, placeholder: "PIN" },
          {
            type: "list",
            testTag: "feed",
            repeat: { items: { path: "/items" }, as: "item", key: "name" },
            children: [
              {
                type: "listItem",
                headline: "{item.name}",
                testTag: "row_{index}",
                onTap: [{ type: "push", stack: "main", screen: "detail" }],
              },
            ],
          },
          {
            type: "button",
            label: "Next",
            testTag: "next",
            onTap: [
              { type: "push", stack: "main", screen: "detail" },
              { type: "emit", name: "next" },
            ],
          },
          { type: "chart", testTag: "chart" },
          { type: "topAppBar", title: "Shop", children: [{ type: "text", text: "kept" }] },
        ],
      },
      detail: {
        type: "scroll",
        child: {
          type: "row",
          children: [
            {
              type: "button",
              label: "Back",
              variant: "text",
              onTap: [{ type: "pop", stack: "main" }],
            },
            { type: "spacer" },
            { type: "divider" },
          ],
        },
      },
    },
  },
};

function sources(spec: Record<string, unknown>): NativePrototypeSources {
  const specs = new PrototypeShownSpecs();
  const ticket = specs.beginShow("emulator-5554", String(spec.id));
  specs.endShow("emulator-5554", ticket, { id: String(spec.id), spec, replaceOthers: false });
  return {
    shownSpec: (deviceId, id) => specs.read(deviceId, id),
    devicesShowing: (id) => specs.devicesShowing(id),
    savedPrototypes: async () => [],
    platformOf: async () => undefined,
    libraryVersion: () => "0.0.88",
  };
}

async function eject(platform: "android" | "ios", spec: Record<string, unknown> = shop) {
  return readPrototypeEject({ id: String(spec.id), platform }, sources(spec));
}

describe("eject mapping", () => {
  test("classifies every contract node type, and both dialects write every mapped one", () => {
    const contractTypes = Object.keys(contract.definitions.node.variants).sort();
    expect(Object.keys(PROTOTYPE_EJECT_MAPPING).sort()).toEqual(contractTypes);
    const scaffolded = contractTypes.filter(isEjectScaffoldType).sort();
    expect(Object.keys(composeDialect.emitters).sort()).toEqual(scaffolded);
    expect(Object.keys(swiftUiDialect.emitters).sort()).toEqual(scaffolded);
  });

  test("covers the agreed subset: layout, text, buttons, fields, lists and stack", () => {
    for (const type of ["column", "row", "box", "text", "button", "textField", "list", "stack"]) {
      expect(isEjectScaffoldType(type)).toBe(true);
    }
    expect(isEjectScaffoldType("chart")).toBe(false);
    expect(isEjectScaffoldType("toString")).toBe(false);
  });
});

describe("automobile:prototype/eject for Compose", () => {
  test("writes screens, navigation and fields as code that keeps every testTag", async () => {
    const result = await eject("android");
    expect(result.files.map((file) => file.path)).toEqual([
      "app/src/main/java/prototypes/eject/ShopPrototype.kt",
    ]);
    const kt = result.files[0].content;
    expect(kt).toContain("fun ShopPrototype() {");
    expect(kt).toContain('when (ui.top("main")) {');
    expect(kt).toContain('"home" -> MainHomeScreen(ui)');
    expect(kt).toContain("private fun MainDetailScreen(ui: ShopPrototypeState) {");
    expect(kt).toContain('Text(text = "Total \\$5", modifier = Modifier)');
    expect(kt).toContain('onValueChange = { ui.setText("email", it) },');
    expect(kt).toContain('modifier = Modifier.testTag("email"),');
    expect(kt).toContain("visualTransformation = PasswordVisualTransformation(),");
    expect(kt).toContain("items(3) { index ->");
    expect(kt).toContain(
      'Modifier.testTag("row_" + index).clickable { ui.push("main", "detail") }',
    );
    expect(kt).toContain('ui.push("main", "detail")\n');
    expect(kt).toContain("/* TODO(eject): emit action */");
    expect(kt).toContain(
      'TextButton(\n                onClick = {\n                    ui.pop("main")',
    );
    expect(kt).toContain('Column(modifier = Modifier.testTag("chart")) {');
    expect(kt).toContain('"email" to "a@b.test", "price" to "\\$5"');
  });

  test("exports theme roles as Material 3 color schemes", async () => {
    const kt = (await eject("android")).files[0].content;
    expect(kt).toContain("val dark = isSystemInDarkTheme()");
    expect(kt).toContain("lightColorScheme(\n    primary = Color(0xFF6750A4),\n)");
    expect(kt).toContain("darkColorScheme(\n    primary = Color(0x80D0BCFF),\n)");
    const forced = await eject("android", { id: "dark", theme: { mode: "dark" }, root: shop.root });
    expect(forced.files[0].content).toContain("val dark = true");
    expect(forced.files[0].content).toContain(
      "private val DarkPrototypeThemeLight = lightColorScheme()",
    );
  });
});

describe("automobile:prototype/eject for SwiftUI", () => {
  test("writes the same structure with accessibility identifiers", async () => {
    const result = await eject("ios");
    expect(result.files.map((file) => file.path)).toEqual(["ShopPrototype.swift"]);
    const swift = result.files[0].content;
    expect(swift).toContain("struct ShopPrototype: View {");
    expect(swift).toContain('switch ui.top("main") {');
    expect(swift).toContain('case "detail":\n                    MainDetailScreen(ui: ui)');
    expect(swift).toContain("private struct MainHomeScreen: View {");
    expect(swift).toContain('Text(verbatim: "Total $5")');
    expect(swift).toContain('TextField(text: ui.text("email")) { Text(verbatim: "Email") }');
    expect(swift).toContain(
      'SecureField(text: ui.text("pin"), prompt: Text(verbatim: "PIN")) { Text(verbatim: "PIN") }',
    );
    expect(swift).toContain("ForEach(0..<3, id: \\.self) { index in");
    expect(swift).toContain('.accessibilityIdentifier("row_" + String(index))');
    expect(swift).toContain('.onTapGesture { ui.push("main", "detail") }');
    expect(swift).toContain(".buttonStyle(.borderless)");
    expect(swift).toContain('.accessibilityIdentifier("next")');
    expect(swift).toContain('.accessibilityIdentifier("chart")');
    expect(swift).toContain(".tint(ShopPrototypeTheme.primary)");
    expect(swift).toContain("alpha: 0.502) : UIColor(red: 0.404, green: 0.314, blue: 0.643");
  });
});

describe("automobile:prototype/eject result", () => {
  test("lists what was scaffolded and every TODO by spec path", async () => {
    const result = await eject("android");
    expect(result.scaffolded).toEqual([
      "button",
      "column",
      "divider",
      "list",
      "listItem",
      "row",
      "scroll",
      "spacer",
      "stack",
      "text",
      "textField",
    ]);
    const home = 'root.screens["home"]';
    expect(result.remaining).toEqual([
      { path: `${home}.children[3].repeat`, kind: "binding", type: "/items" },
      { path: `${home}.children[3].children[0]`, kind: "binding", type: "{item.name}" },
      { path: `${home}.children[4].onTap[1]`, kind: "action", type: "emit" },
      { path: `${home}.children[5]`, kind: "node", type: "chart" },
      { path: `${home}.children[6]`, kind: "node", type: "topAppBar" },
    ]);
    expect(result.files[0].content).toContain("// 5 TODO(eject) item(s) remain");
  });

  test("a TODO stub keeps the unsupported node's children", async () => {
    const kt = (await eject("android")).files[0].content;
    expect(kt).toContain(
      'Column(modifier = Modifier) {\n            Text(text = "TODO: topAppBar")\n            Text(text = "kept", modifier = Modifier)',
    );
  });

  test("a stub keeps descendants in child and adaptive pane slots", async () => {
    const spec = {
      id: "slots",
      root: {
        type: "column",
        children: [
          { type: "drawer", child: { type: "text", text: "menu", testTag: "drawer-text" } },
          { type: "adaptive", list: { type: "text", text: "l", testTag: "pane-list" } },
        ],
      },
    };
    const result = await eject("ios", spec);
    const swift = result.files[0].content;
    expect(swift).toContain('.accessibilityIdentifier("drawer-text")');
    expect(swift).toContain('.accessibilityIdentifier("pane-list")');
    expect(result.remaining.map((item) => item.path)).toEqual([
      "root.children[0]",
      "root.children[1]",
    ]);
  });

  test("reports actions outside onTap, such as onSubmit, instead of dropping them", async () => {
    const spec = {
      id: "search",
      root: {
        type: "textField",
        stateKey: "q",
        onSubmit: [
          { type: "emit", name: "search" },
          { type: "push", stack: "main", screen: "results" },
        ],
      },
    };
    const result = await eject("android", spec);
    expect(result.remaining).toEqual([
      { path: "root.onSubmit[0]", kind: "action", type: "emit" },
      { path: "root.onSubmit[1]", kind: "action", type: "push" },
    ]);
    expect(result.files[0].content).toContain(
      "// TODO(eject): onSubmit actions at root are not translated.",
    );
  });

  test("reads eight-digit theme colors as alpha-first ARGB", async () => {
    const spec = { id: "argb", theme: { colors: { primary: "#80FF0000" } }, root: shop.root };
    expect((await eject("android", spec)).files[0].content).toContain(
      "primary = Color(0x80FF0000),",
    );
    expect((await eject("ios", spec)).files[0].content).toContain(
      "UIColor(red: 1.000, green: 0.000, blue: 0.000, alpha: 0.502)",
    );
  });

  test("popToRoot resets a stack to its declared start, even after a replace", async () => {
    const kt = (await eject("android")).files[0].content;
    const swift = (await eject("ios")).files[0].content;
    expect(kt).toContain(
      'fun popToRoot(stack: String) { stacks[stack] = listOf(starts[stack] ?: "") }',
    );
    expect(swift).toContain(
      'func popToRoot(_ stack: String) { stacks[stack] = [starts[stack] ?: ""] }',
    );
  });

  test("expands reusable components before translating them", async () => {
    const spec = {
      id: "reuse",
      components: { tile: { root: { type: "text", text: "{props.label}", testTag: "tile" } } },
      root: { type: "use", component: "tile", props: { label: "Hello" } },
    };
    const kt = (await eject("android", spec)).files[0].content;
    expect(kt).toContain('Text(text = "Hello", modifier = Modifier.testTag("tile"))');
  });

  test("an unknown id names the eject resource", async () => {
    const read = readPrototypeEject({ platform: "ios" }, sources(shop));
    await expect(read).rejects.toThrow(ActionableError);
    await expect(read).rejects.toThrow("automobile:prototype/eject needs id.");
  });
});
