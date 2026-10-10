/**
 * Hand-written authoring prose for the `automobile:prototype` resource. Everything that names a
 * limit, node type, action, theme role or icon is generated from the spec contract in
 * prototypeGuide.ts; the prose here describes behaviour only and must not restate those values.
 */
export const GUIDE_INTRO = `# Prototype authoring guide

Use the \`prototype\` tool with \`action: "show"\` and a full \`spec\`. A show with the id of the
prototype already on screen replaces it; there is no partial update. A large or script-generated spec can be written to a local JSON file and
shown with \`specPath\` (an absolute path the daemon reads) in place of \`spec\`; give exactly one of
the two. The spec is
\`{id, window, theme?, state?, motion?, root}\`. State values are flat scalars (string, finite
number, boolean). State keys match \`[A-Za-z_][A-Za-z0-9_]{0,63}\`.

Minimal spec:

\`\`\`json
{
  "id": "demo",
  "window": { "placement": { "type": "fullscreen" } },
  "state": { "name": "Ada" },
  "root": { "type": "text", "text": "Hello {name}" }
}
\`\`\`

A \`{key}\` placeholder in a \`text\` node reads the state value of that key.
`;

export const GUIDE_REPEAT = `## Lists: repeat

A \`box\`, \`row\` or \`column\` may declare \`repeat: {items, as}\`. Its \`children\` are the template and
are instantiated once per item, in order, as siblings inside the same container (the container
itself is not repeated). A list is a \`column\` with \`repeat\` whose single child is the row template.

\`\`\`json
{
  "type": "column",
  "repeat": {
    "items": [
      { "name": "Alpha", "tag": "a" },
      { "name": "Beta", "tag": "b" }
    ],
    "as": "item"
  },
  "children": [
    {
      "type": "text",
      "text": "{index}: {item.name}",
      "onTap": [{ "type": "setState", "key": "picked", "value": "{item.tag}" }]
    }
  ]
}
\`\`\`

Grammar:

- \`{index}\` is the zero-based position; \`{<as>.<field>}\` reads a field of the current item.
- Items are literal objects of scalar fields (no nesting); \`as\` is a state-key-shaped identifier.
  A state key cannot hold a list.
- Placeholders are bound in a template child's \`text\`, the label/title/text fields of components
  (button, fab, segmentedButton options, topAppBar, dialog, snackbar), condition operands
  (\`equals\`/\`notEquals\` strings), \`setState.value\` and \`emit.name\`. \`emit.payload\` is not bound.
  Anything else, including a \`{key}\` state placeholder and other braces, is left untouched.
- State keys bind too: \`stateKey\`, \`hourKey\`/\`minuteKey\`, a list item's trailing \`stateKey\`,
  \`openWhen.key\`, condition \`key\`s and the \`key\` of \`setState\`, \`toggle\`, \`increment\` and
  \`decrement\`, so \`"key": "liked_{item.id}"\` gives each row its own state. Every bound key must
  be a literal state key and, like any key, be initialised in \`state\` with the type it binds.
- A string that is exactly one placeholder keeps the item field's own type (so
  \`equals: "{item.id}"\` matches a numeric state value when \`id\` is a number); inside a longer
  string it renders as text.

Rejected (same paths in TypeScript and Kotlin):

- a placeholder naming a field missing from any item (\`Unknown repeat field "nme"\`)
- a template that contains another \`repeat\` or a \`pager\`
- \`repeat\` on a leaf node
- an \`emit.name\` that binds to an empty string for any item
- a state key that binds to an invalid key for some item (fails at \`<container>.repeat.items[i]\`),
  or a state-key placeholder outside every template
- an expanded tree that exceeds the node or image limit (fails at the container's \`repeat\`);
  depth is unaffected because instances are siblings
`;

export const GUIDE_COMPONENTS = `## Reuse: components

A top-level \`components\` map names node templates; a \`use\` node places one anywhere a node goes.
The host expands every \`use\` before validating and sending, so devices only see plain nodes and
every limit counts the expanded tree.

\`\`\`json
{
  "id": "feed",
  "window": { "placement": { "type": "fullscreen" } },
  "state": { "liked_a": false, "liked_b": true },
  "components": {
    "postCard": {
      "root": {
        "type": "card",
        "children": [
          { "type": "text", "text": "{props.name}" },
          { "type": "button", "label": "Like", "onTap": [{ "type": "toggle", "key": "{props.likeKey}" }] }
        ]
      }
    }
  },
  "root": {
    "type": "column",
    "children": [
      { "type": "use", "component": "postCard", "props": { "name": "Alexey", "likeKey": "liked_a" } },
      { "type": "use", "component": "postCard", "props": { "name": "Bea", "likeKey": "liked_b" } }
    ]
  }
}
\`\`\`

- A \`use\` node has only \`type\`, \`component\` and \`props\`; props are scalars (string, number,
  boolean). \`{props.<field>}\` binds in the same fields as repeat placeholders, state keys included,
  and a string that is exactly one placeholder keeps the prop's type.
- A component may contain \`repeat\` and other \`use\` nodes. A \`use\` inside a repeat template may
  pass item placeholders as props (\`"likeKey": "liked_{item.id}"\`); the repeat binds them later.
- Rejected: an unknown component, a missing or unused prop, a non-scalar prop, a cycle (including
  a component that uses itself) and \`use\` nesting deeper than its limit (see Limits).
- An error inside an expansion names each \`use\` it went through, for example
  \`root.children[2] (use postCard) → components.postCard.root.children[1].label\`.
`;

export const GUIDE_APPEARANCE = `## Light and dark mode

A shown prototype has exactly one resolved mode, light or dark. Roles, per-mode values and the
scheme all read that one mode, on Android and on iOS.

Authoring, in order of preference:

- **Roles.** Use a colour role name instead of a hex value wherever a colour goes. A role already
  has a light and a dark value, so nothing else is needed.
- **\`{light, dark}\` pairs.** For a brand literal that needs a hand-picked dark value, a colour
  field, gradient stop or scrim takes \`{"light": "#FFFFFF", "dark": "surfaceContainer"}\`: both
  sides required, each a hex value or a role. An image takes \`{"light": assetId, "dark": assetId}\`;
  upload both assets.
- **Theme maps.** \`theme.colors.<role>\` overrides a role in both modes. \`theme.colors.light\` and
  \`theme.colors.dark\` are \`{<role>: hex}\` maps applied after the flat overrides, for the resolved
  mode only.
- **Scrims.** In a scrim slot (\`window.placement.scrim\`, a bottomSheet \`scrim\`) only the \`scrim\`
  role is drawn translucent, at 0.4 alpha. Any other role is drawn unchanged, so it covers what is
  behind it.

Pairs, theme maps and role names in gradient stops and scrims need a device advertising
\`prototype_theme_modes_v1\`; a show that uses them on an older device is refused.

How the mode is resolved. The first step that applies decides, and is reported as \`source\`:

1. \`theme.mode\` \`light\` or \`dark\` (\`explicit\`).
2. The luminance of the flat \`theme.colors.background\` override, else \`theme.colors.surface\`
   (\`roleLuminance\`). The per-mode maps never take part.
3. The first opaque hex background on the root's leading chain (\`authoredBackground\`). A role or
   a pair depends on the mode, so it cannot decide it.
4. The system setting: the show's \`appearance\` when it is \`light\` or \`dark\` (\`override\`), else
   the device's own setting (\`system\`).

\`theme.mode: "system"\` asks for the system setting outright and skips steps 2 and 3.

Checking both modes without touching the device: \`show\` takes \`appearance: "device" | "light" |
"dark"\` (default \`device\`).

\`\`\`json
{ "action": "show", "appearance": "dark", "spec": { "id": "demo", "window": { "placement": { "type": "fullscreen" } }, "root": { "type": "text", "text": "Hello" } } }
\`\`\`

- The override replaces the system setting only (step 4). It does not beat an explicit
  \`theme.mode\`, a flat \`background\`/\`surface\` override or an opaque authored background; the
  reported \`source\` says which step won.
- It belongs to that show: a later show of the same id without \`appearance\` follows the device
  again. The device and the app behind the prototype are not changed.
- \`light\` and \`dark\` need a device advertising \`prototype_appearance_v1\` and are refused, with
  nothing shown, on one that does not. \`device\` works everywhere.

To test a spec: show it with \`appearance: "dark"\`, \`observe\`, then show it again with
\`appearance: "light"\` and \`observe\`. To put the app behind the prototype into the same mode as
well, set the device with \`displayConfig\` and restore the \`previous\` value it returns when done.

What the device reports (\`prototype_appearance_v1\`; absent on a device without it):

- A successful show returns \`lastResult.appearance: {mode, source, deviceDark}\`; \`status\` and
  \`inspect\` carry the same object on each prototype. \`deviceDark\` is the device's own setting
  whatever decided \`mode\`; it is present only when the device reported it (a show result or
  \`inspect\`) and is omitted after an \`appearance_changed\` event until the next one.
- While a prototype is shown it follows the device live. Any change of the resolved mode (the
  device flipping, or prototype state changing a background the mode is inferred from) sends one
  \`appearance_changed\` event with a null \`name\` and the payload \`{mode, source}\`, and refreshes
  \`status\`. Wait for it with \`awaitEvent\` and \`kind: "appearance_changed"\`. Nothing is sent when
  the mode stays the same, nor for the show itself, whose result already carries the mode.
`;

export const GUIDE_ERRORS = `## Common validation errors

| Message | Fix |
| --- | --- |
| \`Unknown prototype icon name\` | Look the name up with \`automobile:prototype/icons?query=<word>\`. |
| \`Unknown repeat field "x"\` | Every item needs the field the placeholder names. |
| \`Missing component prop "x"\` / \`Unused component prop\` | Pass exactly the props the component's \`{props.*}\` placeholders name. |
| \`Expanded node limit exceeded\` | Fewer items or a smaller template; the limit counts every instance. |
| a \`stateKey\` rejected | The key must be initialised in \`state\` with the type the node binds (string, boolean, number). |
| an unknown property | Nodes and actions are strict: only the fields listed above are accepted. |

Paths in errors (for example \`root.children[0].text\`) point at the offending value in the spec.
`;
