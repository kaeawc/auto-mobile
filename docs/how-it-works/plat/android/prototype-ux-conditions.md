# Prototype spec: conditions, templates and components

Part of [the agent-authored prototype specification](prototype-ux.md).

## Conditions

A condition is exactly one of these forms. `visibleWhen` takes any of them;
`bottomSheet.openWhen` keeps the boolean `{key, equals}` form.

| Form                        | Holds when                                                                            |
| --------------------------- | ------------------------------------------------------------------------------------- |
| `{key, equals: scalar}`     | The state value is exactly equal (same type). A missing key never holds.              |
| `{key, notEquals: scalar}`  | The state value differs, including when the key is missing.                           |
| `{key, gt: number}`         | The state value is a number greater than `gt`. Any other type is false.               |
| `{key, lt: number}`         | The state value is a number less than `lt`. Any other type is false.                  |
| `{key, contains: string}`   | A string state value contains the operand, case-sensitive UTF-16 units.               |
| `{key, startsWith: string}` | A string state value starts with the operand, case-sensitive UTF-16 units.            |
| `{key, lengthGt: integer}`  | A string state value has UTF-16 length strictly greater than the operand.             |
| `{key, lengthLt: integer}`  | A string state value has UTF-16 length strictly less than the operand.                |
| `{valid: key or keys}`      | All referenced keys pass their checks.                                                |
| `{data \| platform, ...}`   | `equals`, `notEquals`, `gt`, `lt` on `/data` or `/platform`; `empty` only on `/data`. |
| `{all: [condition, ...]}`   | Every member holds. One to 16 members.                                                |
| `{any: [condition, ...]}`   | At least one member holds. One to 16 members.                                         |
| `{not: condition}`          | The member does not hold.                                                             |

String comparisons require `prototype_string_conditions_v1` and are key-only. Missing and non-string values fail all four. The `contains`/`startsWith` literals are nonempty, at most 256 UTF-16 units. Operands bind repeat `{item.x}`/`{index}` placeholders as text (a numeric item renders as its text, unlike `equals`). An empty substituted operand holds for every string. The runtime performs no Unicode normalization. The `lengthGt`/`lengthLt` operands are literal integers in 0..100000; equality to the length fails both, and `😀` has length 2.

Numbers compare by value, so a state of `-0` equals `0` on every platform (#11408).

Conditions nest to a depth of 8 (`MAX_PROTOTYPE_CONDITION_DEPTH` in the shared
contract). Every key/data/platform form takes exactly one comparison, and string comparisons require `key`.
Errors point at the offending field (for example `root.visibleWhen.gt`).
The `toggle`, `increment` and `decrement` actions validate their `key` against the declared `state`
(`root.onTap[0].key`). They are no-ops at runtime if other means changed the key's type.
After an `onTap` action list finishes, the device emits exactly one `change` event carrying
the final state (#10622) if `setState`, `toggle`, `increment` or `decrement` changed state.
Host `status` therefore follows button taps. A single changed
key sends `{key, value}`; several send `{keys, values}`. The `emit` actions still fire
in order with the state at that point. A list that nets no change emits nothing,
and a switch or checkbox tap keeps its own `{key, value}` change before its
`onTap` runs. Wire patches from the host stay silent.

An action list is atomic on Android (#11408). The runtime re-validates the state every
write would leave (binding types, numeric ranges, the size cap) before the first action
runs. If it rejects any write, it applies nothing in the list and emits nothing,
so device state and the host's event-fed copy never drift apart. Actions after a
`dismiss` never run, and the runtime does not check them. A control's own write (a switch flip, a chosen
option, a slider value, a picked time, a tab selection, a dialog close) is part of the
same unit as its `onTap` list. A rejected list leaves the control's value and a bound
pager's page untouched too. An accepted control still reports its own `change` first
and then its list, as the iOS agent does.

A rejected interaction is logged on the device
only; no event or status field reports it, so the host sees nothing change. The iOS
agent does not re-validate at runtime, so the same list applies there in full with
one `change`. The TypeScript host and Kotlin validators refuse at `show` a `setState` whose
value type does not fit a control bound to the key (#11452), which closes that gap on the host.

## Conditional style: styleWhen

Any node may declare `styleWhen`: one to 8 entries of `{when: condition, style: style}`
(for selected, disabled or error looks without duplicating nodes). The `when` field takes
any condition form above; `style` is the same strict style object as `style`, so
an unknown key fails at `root.styleWhen[0].style.colour`. At render, the device merges every entry
whose condition holds over the node's base `style` in authored order.
A property set by a later matching entry wins, and properties no entry sets keep
the base value. Merging is per top-level property, so `padding`, `border`, `offset` and a
per-corner `cornerRadius` replace the base object whole rather than merging field
by field. Conditions read the
node's local state, so pager `{page}`/`{pageCount}` keys work inside a pager.

## List templates: repeat

A `box`, `row` or `column` may declare `repeat: {items, as}` to render one template
per item without writing every row out. The container's `children` are the
template. The device instantiates them once per entry of `items`, in item order, as
siblings inside the same container. The container itself does not repeat, so a
list is a `column` with `repeat` whose single child is the row template.
The `items` array holds 1–128 entries, and the expanded tree still counts against the node
limits.

```json
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
      "styleWhen": [
        { "when": { "key": "picked", "equals": "{item.tag}" }, "style": { "color": "#2255CC" } }
      ],
      "onTap": [{ "type": "setState", "key": "picked", "value": "{item.tag}" }]
    }
  ]
}
```

- `items` is a literal array of 1 to 32 objects declared in the spec. Each object
  maps state-style field names to scalar values (string, finite number, boolean);
  no nesting. `as` names the item binding (a state-key-shaped identifier). State
  values are scalar, so a state key cannot hold a list; per-state-key lists are not
  supported.
- Placeholders are `{index}` (the zero-based position) and `{<as>.<field>}`. They
  bind in:
  - a template child's `text`;
  - the component fields `button.label`, `fab.label`, `segmentedButton.options[].label`,
    `topAppBar.title`, `topAppBar.navigationIcon`/`actions[]` (`label` and their `onTap`),
    `dialog.title`, `dialog.text`, `dialog.confirm`/`dismiss` (`label` and `onTap`),
    `snackbar.text` and `snackbar.action` (`label` and `onTap`);
  - condition operands (`equals` and `notEquals` strings in `visibleWhen`, `styleWhen[].when`
    and nested `all`/`any`/`not`), `setState.value` and `emit.name`;
  - every state key (#11051): `stateKey`, `timePicker` `hourKey`/`minuteKey`, a `listItem`
    trailing `stateKey`, `openWhen.key`, condition `key`s and the `key` of `setState`,
    `toggle`, `increment` and `decrement`, so `"key": "liked_{item.id}"` gives every row its
    own state.
- Anything else is not a repeat placeholder and stays untouched: a `{key}` state placeholder,
  other braces, and the container's own fields. Inside a template `{index}` shadows a state
  key named `index`. A string that is exactly one placeholder keeps the item's own
  type, so `equals: "{item.id}"` matches a numeric state value when `id` is a number.
  A placeholder inside a longer string renders to text (integral numbers without a
  decimal point). Repeat binding skips `emit.payload`. Bound values are plain text, but state
  interpolation then runs on a `text` node as usual, so an item string that itself
  reads `{status}` shows the state value. Item values cannot be escaped.
- Validation, with the same paths in TypeScript and Kotlin:
  - A placeholder naming a field that is missing from any item fails at the string (for
    example `root.children[0].text`, message `Unknown repeat field "nme"`).
  - A template may not contain another `repeat` (`root.children[0].repeat`) or a `pager`
    (`root.children[0]`).
  - A `repeat` on a leaf node is an unknown property.
  - An `emit.name` that binds to an empty string for any item fails at the name
    (`root.children[0].onTap[0].name`).
  - A bound state key must be a literal key (`^[A-Za-z_][A-Za-z0-9_]{0,63}$`) for every
    item; one that is not fails at that item (`root.repeat.items[1]`, message
    `Bound state key "liked_b-c" is invalid`).
  - A state-key placeholder outside every template fails at the key (`State key placeholder
    outside a repeat template`).
  - A bound key missing from `state` behaves exactly like a literal missing key: the type
    checks run once per item and fail at the key, naming the item (`Toggle requires a boolean
    state key (repeat item 1)`).
- Limits count the expanded tree. The validator checks the per-screen and whole-spec node and
  image limits against every instance, and an overflow fails at the container's
  `repeat` (for example `root.children[2].repeat`, `Expanded node limit exceeded`).
  The `MAX_PROTOTYPE_DEPTH` limit is unaffected by design: instances are siblings, so a
  template child is exactly as deep as it was written. Because items are literal,
  validation decides all of this statically; the renderer re-checks the expanded count
  before layout as a backstop.
- Rendering expands the template before layout. Each instance node renders under
  the path `container.repeat[item].children[template]`, which is also its Compose
  key, so a row keeps its identity for as long as it keeps its index.

## Reusable components: components and use

A spec may declare a top-level `components` map of named node templates and place
them with `use` nodes (#11053), so a card, row or header used in several places is
written once.

```json
{
  "components": {
    "postCard": {
      "root": {
        "type": "card",
        "children": [
          { "type": "text", "text": "{props.name}" },
          {
            "type": "button",
            "label": "Like",
            "onTap": [{ "type": "toggle", "key": "{props.likeKey}" }]
          }
        ]
      }
    }
  },
  "root": {
    "type": "column",
    "children": [
      {
        "type": "use",
        "component": "postCard",
        "props": { "name": "Alexey", "likeKey": "liked_a" }
      },
      { "type": "use", "component": "postCard", "props": { "name": "Bea", "likeKey": "liked_b" } }
    ]
  }
}
```

- Components are expanded on the host (`src/features/prototype/prototypeComponents.ts`)
  before validation and transport: each `use` is replaced by a copy of the
  component's `root` and `components` is dropped. Devices never see either, so the
  Kotlin and Swift renderers and the device validator are unchanged.
- Component names and prop names are state-key-shaped. A `use` node has only
  `type`, `component` and optional `props`; props are scalars (string, finite
  number, boolean).
- `{props.<field>}` binds in exactly the fields a `repeat` placeholder binds (see
  List templates above), state keys included, plus the `props` of a nested `use`.
  A string that is exactly one placeholder keeps the prop's type. The `{index}` placeholder and
  other aliases are left for a `repeat` to bind, so a `use` inside a repeat template
  can pass `"likeKey": "liked_{item.id}"`, and a component may contain `repeat`
  and further `use` nodes.
- Rejected, with the path of the `use`: an unknown component
  (`root.children[0].component`), a missing prop (`.props`), an unused or
  non-scalar prop (`.props.<name>`), and a cycle including self-reference
  (`.component`, message `Component cycle: a → b → a`). Nesting `use` deeper
  than 8 also fails. Unused components are allowed.
- Limits apply to the expanded tree: nodes, depth and images as usual (expansion
  itself stops at `MAX_PROTOTYPE_SPEC_NODES`). The byte limit applies to both the
  authored and the expanded spec (`Expanded spec byte limit exceeded`), because the
  device re-validates bytes.
- An error inside an expansion names each `use` it went through, for example
  `root.children[2] (use postCard) → components.postCard.root.children[1].label`.
  Nodes outside every component keep their authored paths, because a `use` expands
  to exactly one node.
