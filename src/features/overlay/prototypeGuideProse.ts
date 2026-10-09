/**
 * Hand-written authoring prose for the `automobile:prototype` resource. Everything that names a
 * limit, node type, action, theme role or icon is generated from the spec contract in
 * prototypeGuide.ts; the prose here describes behaviour only and must not restate those values.
 */
export const GUIDE_INTRO = `# Prototype authoring guide

Use the \`prototype\` tool with \`action: "show"\` and a full \`spec\`. A show with the id of the
overlay already on screen replaces it; there is no partial update. A large or script-generated spec can be written to a local JSON file and
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

export const GUIDE_ERRORS = `## Common validation errors

| Message | Fix |
| --- | --- |
| \`Unknown overlay icon name\` | Look the name up with \`automobile:prototype/icons?query=<word>\`. |
| \`Unknown repeat field "x"\` | Every item needs the field the placeholder names. |
| \`Expanded node limit exceeded\` | Fewer items or a smaller template; the limit counts every instance. |
| a \`stateKey\` rejected | The key must be initialised in \`state\` with the type the node binds (string, boolean, number). |
| an unknown property | Nodes and actions are strict: only the fields listed above are accepted. |

Paths in errors (for example \`root.children[0].text\`) point at the offending value in the spec.
`;
