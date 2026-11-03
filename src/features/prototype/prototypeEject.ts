import { ActionableError } from "../../models/ActionableError";
import {
  prototypeHostTypeName,
  resolveExportTarget,
  type NativePrototypeFile,
  type NativePrototypePlatform,
  type NativePrototypeSources,
} from "./nativePrototype";
import { stringLiteral } from "./nativePrototypeTemplates";
import { PROTOTYPE_EJECT_URI } from "./nativePrototypeUris";
import { expandPrototypeComponents } from "./prototypeComponents";
import { COMPOSE_IMPORTS, composeDialect } from "./prototypeEjectCompose";
import {
  composeThemeLines,
  ejectThemeColors,
  swiftThemeLines,
  type EjectThemeColors,
} from "./prototypeEjectTheme";
import { swiftUiDialect } from "./prototypeEjectSwiftUi";
import { block, EjectWriter, type EjectTodo } from "./prototypeEjectWriter";
import { record, type Raw } from "./prototypeTemplate";

/**
 * `automobile:prototype/eject` (#14129): a deterministic, one-shot scaffold of a prototype as
 * hand-owned Jetpack Compose or SwiftUI code with no renderer dependency. It covers layout, text,
 * buttons, fields, lists and `stack` navigation; every other node becomes a labelled TODO stub
 * that keeps its `testTag` and children. It is not round-trip: the app owns the file afterwards.
 */

export interface PrototypeEject {
  id: string;
  platform: NativePrototypePlatform;
  files: NativePrototypeFile[];
  /** Node types written as real code, sorted. */
  scaffolded: string[];
  /** What the scaffold could not translate, by spec path. */
  remaining: EjectTodo[];
  notes: string[];
}

interface Generated {
  readonly writer: EjectWriter;
  readonly root: string[];
  readonly typeName: string;
  readonly theme: EjectThemeColors;
  readonly texts: [string, string][];
  readonly header: string[];
}

function expandedSpec(spec: Raw): Raw {
  const expansion = expandPrototypeComponents(spec);
  const expanded = expansion.success ? record(expansion.spec) : undefined;
  if (!expanded) {
    throw new ActionableError(
      `Cannot eject prototype "${String(spec.id)}": its components do not expand. Show it again to see the error.`,
    );
  }
  return expanded;
}

/** String state values seed the text fields; other state types are left to the app. */
function textState(spec: Raw): [string, string][] {
  return Object.entries(record(spec.state) ?? {}).filter(
    (entry): entry is [string, string] => typeof entry[1] === "string",
  );
}

function headerLines(id: string, platform: NativePrototypePlatform, todos: number): string[] {
  const query = new URLSearchParams({ id, platform }).toString();
  return [
    `// Generated once by ${PROTOTYPE_EJECT_URI}?${query}.`,
    "// This file is yours: edit it freely. It is never regenerated or synced back to the spec.",
    `// ${todos} TODO(eject) item(s) remain; search for TODO(eject).`,
  ];
}

function generate(id: string, platform: NativePrototypePlatform, spec: Raw): Generated {
  const dialect = platform === "android" ? composeDialect : swiftUiDialect;
  const writer = new EjectWriter(dialect, spec.data, "");
  const root = writer.emit(spec.root, "root");
  return {
    writer,
    root,
    typeName: prototypeHostTypeName(id),
    theme: ejectThemeColors(spec.theme),
    texts: textState(spec),
    header: headerLines(id, platform, writer.todos.length),
  };
}

function kotlinMap(entries: readonly [string, string][]): string {
  const pairs = entries.map(
    ([key, value]) => `${stringLiteral(key, "kotlin")} to ${stringLiteral(value, "kotlin")}`,
  );
  return `mapOf<String, String>(${pairs.join(", ")})`;
}

function composeStateLines(g: Generated): string[] {
  return block(`class ${g.typeName}State {`, [
    `private val starts: Map<String, String> = ${kotlinMap([...g.writer.stackStarts])}`,
    "private val stacks = mutableStateMapOf<String, List<String>>()",
    `private val texts = mutableStateMapOf<String, String>().apply { putAll(${kotlinMap(g.texts)}) }`,
    "",
    "fun top(stack: String): String = path(stack).last()",
    "fun push(stack: String, screen: String) { stacks[stack] = path(stack) + screen }",
    "fun pop(stack: String) { val p = path(stack); if (p.size > 1) stacks[stack] = p.dropLast(1) }",
    'fun popToRoot(stack: String) { stacks[stack] = listOf(starts[stack] ?: "") }',
    "fun replace(stack: String, screen: String) { stacks[stack] = path(stack).dropLast(1) + screen }",
    'fun text(key: String): String = texts[key] ?: ""',
    "fun setText(key: String, value: String) { texts[key] = value }",
    "",
    'private fun path(stack: String): List<String> = stacks[stack] ?: listOf(starts[stack] ?: "")',
  ]);
}

function composeFile(g: Generated): string {
  const name = g.typeName;
  const screens = g.writer.screens.flatMap((screen) => [
    "",
    "@Composable",
    ...block(`private fun ${screen.name}(ui: ${name}State) {`, screen.body),
  ]);
  const lines = [
    ...g.header,
    "package prototypes.eject",
    "",
    ...COMPOSE_IMPORTS.map((path) => `import ${path}`),
    "",
    "@Composable",
    ...block(`fun ${name}() {`, [
      `val ui = remember { ${name}State() }`,
      ...block(`${name}Theme {`, g.root),
    ]),
    ...screens,
    "",
    ...composeStateLines(g),
    "",
    ...composeThemeLines(g.theme, `${name}Theme`),
  ];
  return `${lines.join("\n")}\n`;
}

function swiftDictionary(entries: readonly [string, string][]): string {
  if (entries.length === 0) {
    return "[:]";
  }
  const pairs = entries.map(
    ([key, value]) => `(${stringLiteral(key, "swift")}, ${stringLiteral(value, "swift")})`,
  );
  // Canonically equivalent keys are one key in Swift; a dictionary literal would trap.
  return `Dictionary([${pairs.join(", ")}], uniquingKeysWith: { first, _ in first })`;
}

function swiftStateLines(g: Generated): string[] {
  return block(`final class ${g.typeName}State: ObservableObject {`, [
    "@Published private var stacks: [String: [String]] = [:]",
    "@Published private var texts: [String: String]",
    "private let starts: [String: String]",
    "",
    ...block("init() {", [
      `starts = ${swiftDictionary([...g.writer.stackStarts])}`,
      `texts = ${swiftDictionary(g.texts)}`,
    ]),
    "",
    'func top(_ stack: String) -> String { path(stack).last ?? "" }',
    "func push(_ stack: String, _ screen: String) { stacks[stack] = path(stack) + [screen] }",
    "func pop(_ stack: String) { let p = path(stack); if p.count > 1 { stacks[stack] = Array(p.dropLast()) } }",
    'func popToRoot(_ stack: String) { stacks[stack] = [starts[stack] ?: ""] }',
    "func replace(_ stack: String, _ screen: String) { stacks[stack] = Array(path(stack).dropLast()) + [screen] }",
    ...block("func text(_ key: String) -> Binding<String> {", [
      'Binding(get: { self.texts[key] ?? "" }, set: { self.texts[key] = $0 })',
    ]),
    "",
    'private func path(_ stack: String) -> [String] { stacks[stack] ?? [starts[stack] ?? ""] }',
  ]);
}

function swiftRootModifiers(g: Generated): string[] {
  const tint = g.theme.light.has("primary") || g.theme.dark.has("primary");
  return [
    ...(tint ? [`.tint(${g.typeName}Theme.primary)`] : []),
    ...(g.theme.mode ? [`.preferredColorScheme(.${g.theme.mode})`] : []),
  ];
}

function swiftFile(g: Generated): string {
  const name = g.typeName;
  const screens = g.writer.screens.flatMap((screen) => [
    "",
    ...block(`private struct ${screen.name}: View {`, [
      `@ObservedObject var ui: ${name}State`,
      "",
      ...block("var body: some View {", block("Group {", screen.body)),
    ]),
  ]);
  const lines = [
    ...g.header,
    "import SwiftUI",
    "import UIKit",
    "",
    ...block(`struct ${name}: View {`, [
      `@StateObject private var ui = ${name}State()`,
      "",
      ...block("var body: some View {", [...block("Group {", g.root), ...swiftRootModifiers(g)]),
    ]),
    ...screens,
    "",
    ...swiftStateLines(g),
    "",
    ...swiftThemeLines(g.theme, `${name}Theme`),
  ];
  return `${lines.join("\n")}\n`;
}

function ejectNotes(g: Generated): string[] {
  const notes = [
    "One-shot scaffold, not round-trip: re-reading this resource never merges with code you changed.",
    "Only layout, text, buttons, text fields, lists and stack navigation are translated; styles, conditions, state other than text, and data bindings are TODOs.",
    "Every testTag is kept (Modifier.testTag / .accessibilityIdentifier), so flows recorded on the prototype can target the ejected screens.",
  ];
  if (g.theme.seeded) {
    notes.push(
      "The spec seeds its color scheme (theme.colors.seed or source); only explicit color roles are exported.",
    );
  }
  return notes;
}

/** Builds the hand-owned scaffold for one prototype. */
export async function readPrototypeEject(
  params: Record<string, string | undefined>,
  sources: NativePrototypeSources,
): Promise<PrototypeEject> {
  const { id, platform, resolved } = await resolveExportTarget(
    params,
    sources,
    PROTOTYPE_EJECT_URI,
  );
  const g = generate(id, platform, expandedSpec(resolved.spec));
  const file =
    platform === "android"
      ? { path: `app/src/main/java/prototypes/eject/${g.typeName}.kt`, content: composeFile(g) }
      : { path: `${g.typeName}.swift`, content: swiftFile(g) };
  return {
    id,
    platform,
    files: [file],
    scaffolded: [...g.writer.scaffolded].sort(),
    remaining: g.writer.todos,
    notes: ejectNotes(g),
  };
}
