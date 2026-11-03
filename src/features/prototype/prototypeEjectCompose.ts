import type { EjectScope } from "./prototypeEjectScope";
import {
  block,
  inlineStatements,
  type EjectDialect,
  type NodeEmitter,
} from "./prototypeEjectWriter";
import type { Raw } from "./prototypeTemplate";

/** Jetpack Compose (Material 3) half of `automobile:prototype/eject` (#14129). */

/** `Modifier` with any `extra` calls, the node's `testTag`, and its `onTap` as `clickable`. */
function modifier(scope: EjectScope, extra = "", clickable = true): string {
  const parts = ["Modifier", extra];
  const tag = scope.testTag();
  if (tag !== undefined) {
    parts.push(`.testTag(${tag})`);
  }
  const actions = clickable ? scope.actions("onTap") : [];
  if (actions.length > 0) {
    parts.push(`.clickable { ${inlineStatements(actions)} }`);
  }
  return parts.join("");
}

function container(name: string, args = ""): NodeEmitter {
  return (_node, scope) =>
    block(`${name}(modifier = ${modifier(scope)}${args}) {`, scope.children());
}

function spanText(node: Raw): string {
  const spans = Array.isArray(node.spans) ? node.spans : [];
  return spans
    .map((span: unknown) =>
      typeof span === "object" && span !== null && "text" in span ? String(span.text) : "",
    )
    .join("");
}

function textValue(node: Raw, scope: EjectScope): string {
  return scope.text(scope.string("text") ?? spanText(node));
}

const BUTTONS: Record<string, string> = {
  filled: "Button",
  tonal: "FilledTonalButton",
  elevated: "ElevatedButton",
  outlined: "OutlinedButton",
  text: "TextButton",
};

const button: NodeEmitter = (node, scope) => [
  `${BUTTONS[scope.string("variant") ?? "filled"] ?? "Button"}(`,
  ...block(
    "    onClick = {",
    scope.actions("onTap").map((line) => `    ${line}`),
    "    },",
  ),
  `    modifier = ${modifier(scope, "", false)},`,
  ...block(") {", [`Text(text = ${scope.text(scope.string("label") ?? "")})`]),
];

function optionalSlot(scope: EjectScope, slot: string, field: string): string[] {
  const value = scope.string(field);
  return value === undefined ? [] : [`    ${slot} = { Text(text = ${scope.text(value)}) },`];
}

const textField: NodeEmitter = (node, scope) => {
  const key = scope.text(scope.string("stateKey") ?? "");
  const secure = node.secure === true || node.keyboardType === "password";
  return [
    `${node.variant === "filled" ? "TextField" : "OutlinedTextField"}(`,
    `    value = ui.text(${key}),`,
    `    onValueChange = { ui.setText(${key}, it) },`,
    `    modifier = ${modifier(scope)},`,
    ...optionalSlot(scope, "label", "label"),
    ...optionalSlot(scope, "placeholder", "placeholder"),
    ...optionalSlot(scope, "supportingText", "supportingText"),
    ...(node.multiline === true ? [] : ["    singleLine = true,"]),
    ...(secure ? ["    visualTransformation = PasswordVisualTransformation(),"] : []),
    ")",
  ];
};

const list: NodeEmitter = (node, scope) => {
  const lazy = node.axis === "horizontal" ? "LazyRow" : "LazyColumn";
  const header = scope.children("header");
  const footer = scope.children("footer");
  return block(`${lazy}(modifier = ${modifier(scope)}) {`, [
    ...(header.length > 0 ? block("item {", header) : []),
    ...block(`items(${scope.rowCount()}) { index ->`, scope.row("index")),
    ...(footer.length > 0 ? block("item {", footer) : []),
  ]);
};

const listItem: NodeEmitter = (_node, scope) => [
  "ListItem(",
  `    headlineContent = { Text(text = ${scope.text(scope.string("headline") ?? "")}) },`,
  ...optionalSlot(scope, "supportingContent", "supporting"),
  `    modifier = ${modifier(scope)},`,
  ")",
];

const stack: NodeEmitter = (_node, scope) => {
  const id = scope.literal(scope.string("id") ?? "");
  const branches = scope.stackScreens().map(([name, fn]) => `${scope.literal(name)} -> ${fn}(ui)`);
  return block(`Box(modifier = ${modifier(scope)}) {`, block(`when (ui.top(${id})) {`, branches));
};

const scroll: NodeEmitter = (node, scope) => {
  const horizontal = node.axis === "horizontal";
  const scrollCall = horizontal ? ".horizontalScroll" : ".verticalScroll";
  return block(
    `${horizontal ? "Row" : "Column"}(modifier = ${modifier(scope, `${scrollCall}(rememberScrollState())`)}) {`,
    scope.children("child"),
  );
};

export const composeDialect: EjectDialect = {
  language: "kotlin",
  emitters: {
    box: container("Box"),
    row: container("Row", ", verticalAlignment = Alignment.CenterVertically"),
    column: container("Column"),
    card: container("Card"),
    scroll,
    spacer: (_node, scope) => [`Spacer(modifier = ${modifier(scope, ".size(8.dp)")})`],
    divider: (node, scope) => [
      `${node.orientation === "vertical" ? "VerticalDivider" : "HorizontalDivider"}(modifier = ${modifier(scope)})`,
    ],
    text: (node, scope) => [
      `Text(text = ${textValue(node, scope)}, modifier = ${modifier(scope)})`,
    ],
    button,
    textField,
    list,
    listItem,
    stack,
  },
  todoStub: (node, scope, children) => [
    `// TODO(eject): ${String(node.type)} at ${scope.path} has no scaffold mapping; build it by hand.`,
    ...block(`Column(modifier = ${modifier(scope)}) {`, [
      `Text(text = ${scope.literal(`TODO: ${String(node.type)}`)})`,
      ...children,
    ]),
  ],
  indexed: (index) => index,
};

/** Wildcard imports keep the scaffold compiling whichever subset of components it uses. */
export const COMPOSE_IMPORTS = [
  "androidx.compose.foundation.*",
  "androidx.compose.foundation.layout.*",
  "androidx.compose.foundation.lazy.*",
  "androidx.compose.material3.*",
  "androidx.compose.runtime.*",
  "androidx.compose.ui.Alignment",
  "androidx.compose.ui.Modifier",
  "androidx.compose.ui.graphics.Color",
  "androidx.compose.ui.platform.testTag",
  "androidx.compose.ui.text.input.PasswordVisualTransformation",
  "androidx.compose.ui.unit.dp",
];
