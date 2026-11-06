import type { EjectScope } from "./prototypeEjectScope";
import {
  block,
  inlineStatements,
  type EjectDialect,
  type NodeEmitter,
} from "./prototypeEjectWriter";
import type { Raw } from "./prototypeTemplate";

/** SwiftUI half of `automobile:prototype/eject` (#14129). */

/** The node's `testTag` as an accessibility identifier and its `onTap` as a tap gesture. */
function modifiers(scope: EjectScope, clickable = true): string[] {
  const lines: string[] = [];
  const tag = scope.testTag();
  if (tag !== undefined) {
    lines.push(`.accessibilityIdentifier(${tag})`);
  }
  const actions = clickable ? scope.actions("onTap") : [];
  if (actions.length > 0) {
    lines.push(`.onTapGesture { ${inlineStatements(actions)} }`);
  }
  return lines;
}

function container(open: string, extra: readonly string[] = []): NodeEmitter {
  return (_node, scope) => [...block(`${open} {`, scope.children()), ...extra, ...modifiers(scope)];
}

function spanText(node: Raw): string {
  const spans = Array.isArray(node.spans) ? node.spans : [];
  return spans
    .map((span: unknown) =>
      typeof span === "object" && span !== null && "text" in span ? String(span.text) : "",
    )
    .join("");
}

const BUTTON_STYLES: Record<string, string> = {
  filled: ".borderedProminent",
  tonal: ".bordered",
  elevated: ".bordered",
  outlined: ".bordered",
  text: ".borderless",
};

const button: NodeEmitter = (_node, scope) => [
  ...block("Button {", scope.actions("onTap"), "} label: {"),
  `    Text(verbatim: ${scope.text(scope.string("label") ?? "")})`,
  "}",
  `.buttonStyle(${BUTTON_STYLES[scope.string("variant") ?? "filled"] ?? ".borderedProminent"})`,
  ...modifiers(scope, false),
];

function field(node: Raw, scope: EjectScope): string {
  const binding = `ui.text(${scope.text(scope.string("stateKey") ?? "")})`;
  const placeholder = scope.string("placeholder");
  const prompt =
    placeholder === undefined ? "" : `, prompt: Text(verbatim: ${scope.text(placeholder)})`;
  const label = `Text(verbatim: ${scope.text(scope.string("label") ?? placeholder ?? "")})`;
  if (node.secure === true || node.keyboardType === "password") {
    return `SecureField(text: ${binding}${prompt}) { ${label} }`;
  }
  const axis = node.multiline === true ? ", axis: .vertical" : "";
  return `TextField(text: ${binding}${prompt}${axis}) { ${label} }`;
}

const textField: NodeEmitter = (node, scope) => {
  const supporting = scope.string("supportingText");
  const input = [field(node, scope), ".textFieldStyle(.roundedBorder)"];
  if (supporting === undefined) {
    return [...input, ...modifiers(scope)];
  }
  return [
    ...block("VStack(alignment: .leading) {", [
      ...input,
      `Text(verbatim: ${scope.text(supporting)})`,
      "    .font(.caption)",
    ]),
    ...modifiers(scope),
  ];
};

const list: NodeEmitter = (node, scope) => {
  const horizontal = node.axis === "horizontal";
  const rows = block(
    `ForEach(0..<${scope.rowCount()}, id: \\.self) { index in`,
    scope.row("index"),
  );
  const lazy = block(`${horizontal ? "LazyHStack" : "LazyVStack(alignment: .leading)"} {`, [
    ...scope.children("header"),
    ...rows,
    ...scope.children("footer"),
  ]);
  return [
    ...block(`ScrollView(${horizontal ? ".horizontal" : ".vertical"}) {`, lazy),
    ...modifiers(scope),
  ];
};

const listItem: NodeEmitter = (_node, scope) => {
  const supporting = scope.string("supporting");
  const texts = [
    `Text(verbatim: ${scope.text(scope.string("headline") ?? "")})`,
    ...(supporting === undefined
      ? []
      : [
          `Text(verbatim: ${scope.text(supporting)})`,
          "    .font(.subheadline)",
          "    .foregroundStyle(.secondary)",
        ]),
  ];
  return [
    ...block("HStack {", [...block("VStack(alignment: .leading) {", texts), "Spacer()"]),
    ".contentShape(Rectangle())",
    ...modifiers(scope),
  ];
};

const stack: NodeEmitter = (_node, scope) => {
  const cases = scope
    .stackScreens()
    .flatMap(([name, view]) => [`case ${scope.literal(name)}:`, `    ${view}(ui: ui)`]);
  const id = scope.literal(scope.string("id") ?? "");
  const switchLines = [`switch ui.top(${id}) {`, ...cases, "default:", "    EmptyView()", "}"];
  return [...block("Group {", switchLines), ...modifiers(scope)];
};

const scroll: NodeEmitter = (node, scope) => [
  ...block(
    `ScrollView(${node.axis === "horizontal" ? ".horizontal" : ".vertical"}) {`,
    scope.children("child"),
  ),
  ...modifiers(scope),
];

export const swiftUiDialect: EjectDialect = {
  language: "swift",
  emitters: {
    box: container("ZStack"),
    row: container("HStack"),
    column: container("VStack(alignment: .leading)"),
    card: container("VStack(alignment: .leading)", [
      ".padding()",
      ".background(Color(UIColor.secondarySystemBackground), in: RoundedRectangle(cornerRadius: 12))",
    ]),
    scroll,
    spacer: (_node, scope) => ["Spacer()", ".frame(width: 8, height: 8)", ...modifiers(scope)],
    divider: (_node, scope) => ["Divider()", ...modifiers(scope)],
    text: (node, scope) => [
      `Text(verbatim: ${scope.text(scope.string("text") ?? spanText(node))})`,
      ...modifiers(scope),
    ],
    button,
    textField,
    list,
    listItem,
    stack,
  },
  todoStub: (node, scope, children) => [
    `// TODO(eject): ${String(node.type)} at ${scope.path} has no scaffold mapping; build it by hand.`,
    ...block("VStack(alignment: .leading) {", [
      `Text(verbatim: ${scope.literal(`TODO: ${String(node.type)}`)})`,
      ...children,
    ]),
    ...modifiers(scope),
  ],
  indexed: (index) => `String(${index})`,
};
