import { MAX_PROTOTYPE_PATCH_OPS } from "./prototypePatch";
import { MAX_PROTOTYPE_SPEC_BYTES } from "./prototypeSpec";
export const GUIDE_GESTURES = `## Gestures

\`onLongPress\` and \`onDoubleTap\` run their action lists exactly like \`onTap\`, with no new
event kind. A node with either list is interactive even without \`onTap\`. All three may coexist;
a node with only \`onLongPress\` and/or \`onDoubleTap\` does not consume single taps:
the nearest ancestor's \`onTap\` runs. The single-tap delay applies only to nodes declaring
\`onDoubleTap\`; \`onTap\` with only \`onLongPress\` fires immediately.
Repeat item and component prop placeholders bind in these lists just as they do in \`onTap\`.
Use \`tapOn\` with \`action: "longPress"|"doubleTap"\` and \`layer: "prototype"\` to drive them
by coordinate gesture; no new MCP tool is needed. Long-press uses the platform default threshold
(about 0.5 s on iOS versus the Android long-press timeout, about 0.4 s); the double-tap window is
the system's. The host refuses unsupported agents before sending a show.
`;

/**
 * Hand-written authoring prose for the `automobile:prototype` resource. Everything that names a
 * limit, node type, action, theme role or icon is generated from the spec contract in
 * prototypeGuide.ts; the prose here describes behaviour only and must not restate those values.
 */
export const GUIDE_INTRO = `# Prototype authoring guide

Use the \`prototype\` tool with \`action: "show"\` and a full \`spec\`. A show with the id of the
prototype already on screen replaces it. Use show for a new screen or a window, theme or root
change; patch for content (\`/data\`), state (\`/state\`) or one node by id (\`replaceNode\`). A large or script-generated spec can be written to a local JSON file and
shown with \`specPath\` (an absolute path the daemon reads) in place of \`spec\`; give exactly one of
the two. The spec is
\`{id, window, theme?, data?, state?, motion?, root}\`. State values are flat scalars (string, finite
number, boolean). State keys match \`[A-Za-z_][A-Za-z0-9_]{0,63}\`.

Screen navigation: \`{type:"stack", id, start, screens:{home: node, detail: node}}\` starts with
path [start] and renders only the top screen. Screen names and id are non-empty; start names an
existing screen. Actions \`push {stack, screen}\`, \`pop {stack}\`, \`popToRoot {stack}\`, and
\`replace {stack, screen}\` append, remove the top, reset to [start], and swap the top respectively.
Push is ignored at depth 32; pop at depth 1 does nothing. \`screen_changed\` has name = stack id
and payload \`{screen, depth}\`, emitted only when the top screen or depth changes. Requires
\`prototype_stack_v1\`; every screen counts toward node limits, including hidden screens.
Android Back and the iOS edge swipe pop a stack above depth 1. No transitions yet; per-screen
scroll position is not restored. A stack cannot appear inside a repeat template.

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

## Text field options

\`textField\` binds an initialized string state key. Optional \`label\` is a nonempty floating
label; \`variant\` is \`filled\` (default) or \`outlined\`; nonempty \`supportingText\` appears below
the field. \`keyboardType\` is \`text\` (default), \`number\`, \`decimal\`, \`email\`, \`phone\`, \`url\`,
or \`password\`. \`secure\` masks text; \`multiline\` enables multiple lines. \`minLines\` and
\`maxLines\` are integers in 1..20, permitted only with \`multiline: true\`; \`minLines\` cannot
exceed \`maxLines\`. Multiline text cannot use \`secure: true\` or \`keyboardType: "password"\`.
\`maxLength\` is an integer in 1..10000 and shows a character counter; the initial bound
value cannot exceed it (UTF-16 length).

All these options require \`prototype_text_field_options_v1\`. A device without the capability
is refused before uploads or show; nothing is shown. Update CtrlProxy, or relaunch the iOS
app with \`launchApp prototype: true\`, or drop the textField options.

Open question: a \`secure\` field's value still lives in state and in \`change\` events/\`inspect\`;
this slice does not redact it.

## Search field and results

\`searchBar.stateKey\` names an initialized string query. Editing uses the same state write
and \`change\` event as a text field; keyboard search runs \`onSubmit\`. A visible search bar
is an editable text target for \`sendKeys\` and makes the window focusable for the keyboard.
\`placeholder\` follows text-field rules. \`leadingIcon\` and each trailing action's required
\`icon\` use the icon catalog; its required nonempty \`label\` is the accessibility label,
and \`onTap\` runs ordinary actions.
\`activeKey\` names an initialized boolean: true shows the optional single \`child\`.
A child requires activeKey; activeKey without a child is allowed.
\`variant: "bar"\` (default) expands to fill its parent when active; \`"docked"\` stays in
place and draws results directly underneath. Results are ordinary nodes inside the prototype
window, so \`observe\` sees every row; use a column of literal rows rather than a lazy list.
Child nodes and submit/trailing actions participate in all normal validation and template walks;
repeat placeholders bind in the placeholder, trailing labels and actions as in other controls.
Show and patches producing a search bar require \`prototype_search_bar_v1\` and are refused
before device requests when it is absent. The Android and iOS implementations ship in later passes.
iOS uses a drawn field with SF Symbol icons, not SwiftUI \`.searchable\`; these differences
are reported in \`platformNotes\`.

## Rich text

A text node has exactly one of \`text\` or \`spans\`; plain \`text: ""\` remains valid.
Spans are strict \`{text, style?, onTap?}\` objects with nonempty, untrimmed text; whitespace is valid.
Span style accepts only color, fontWeight, fontStyle, textDecoration, textSize, letterSpacing,
fontFamily and background, with the same ranges as node style; background is a colour, never a gradient.
There are no span ids, testTags, visibility conditions, nested spans or URLs.
Each span uses the same state \`{key}\`, data \`{data:/pointer}\`, repeat \`{item.field}\` / \`{index}\`
and component \`{props.x}\` binding as node text; span actions bind like node onTap actions.
The resolved texts concatenate in order without separators: observe and accessibility show the
full plain text (an explicit node contentDescription still overrides its accessible label).
Spans do not count as nodes and require \`prototype_rich_text_v1\`; older devices are refused before show.
A tappable span is part of the text node, not a separate accessibility node, and runs actions without opening URLs.
On Android, activate it with \`tapOn {accessibilityLink:"<span text>"}\` or
\`tapOn {text:"<full plain text>", subtext:{text:"<span text>"}}\` without \`layer\`:
these selectors act across windows because tapOn refuses layer with accessibilityLink/subtext (#9305).
Use \`tapAt\` on the span bounds as the fallback.
On iOS, links are drawn as links and tap-through is by \`tapAt\` only; show reports the
\`rich-text-links\` platform note for tappable spans because there are no separate accessibility elements or semantic links.

## Fullscreen host chrome

\`window.chrome\` is \`"none"\` (default) or \`"bar"\`, fullscreen only, on a device advertising
\`prototype_window_chrome_v1\`. With \`none\` there is no host dismiss bar: content starts at the
very top of the screen, including under the status bar. A \`topAppBar\` or top content needs
\`safeAreaPadding\` on the top edge; relative sheet detents use the full window height.
A host-owned two-finger long press (about 1 s) anywhere on the window reveals a dismiss pill for
5 s; tapping it dismisses with reason \`user\`. Agent dismiss, a replacing show, authored dismiss,
the session's five-minute idle TTL and last-client disconnect still work.
\`window.persistence: "device"\` defaults to \`bar\` and keeps its existing persistence behaviour.
The device implementations ship separately: without the capability a device keeps the bar,
explicit \`none\` is refused, and omitted chrome or \`bar\` succeeds. A successful fullscreen
show and subsequent host-local status report the effective value as \`lastResult.chrome\`;
it is absent for sheet/floating windows, dismiss, failed show and adopted prototypes.


## Menu and select

\`menu\` and \`select\` require \`prototype_menus_v1\`; the host refuses them before showing or uploading assets when the connected renderer lacks it.

A \`menu\` requires \`openWhen: {key, equals}\` with a boolean equality and 1–16 strict \`items\`. Each item is \`{label, icon?, trailingText?, enabled?, onTap?}\` or exactly \`{type:"divider"}\`. Labels and trailing text are nonempty, icons use the existing icon names, and \`onTap\` has 1–32 existing actions. A disabled item is dimmed, cannot be tapped and does not close the menu. Dividers are neither focusable nor tappable. The elevated surface is anchored to its parent’s bottom end and clamped inside the window. An enabled item or outside tap writes \`!equals\` to the open key; item actions run after closing.

A \`select\` requires a string \`stateKey\` and 2–32 \`{value,label}\` options with unique nonempty values and nonempty labels; its optional label is nonempty. It shows the current option’s label, or empty text when no option matches, and a trailing expand indicator. Expansion is local view state. Choosing an option writes the string key, emits the same \`change\` payload as \`radioGroup\`, and collapses the list. Tapping the field again or outside also collapses it. Both nodes support repeat templates and reusable \`use\` components: state keys, menu item labels/trailing text/actions and select labels/option labels bind placeholders.

Rendering stays inside the prototype window on both platforms so \`observe\` and \`tapOn\` reach the normal hierarchy. Android uses an in-window surface rather than a separate DropdownMenu/Popup window. iOS uses an in-window list rather than system SwiftUI Menu/Picker popups; successful iOS shows report this substitution in \`platformNotes\`. Menu icons use the existing SF Symbols mapping on iOS.

The select field and menu surface carry the node \`testTag\`. Select option rows use \`<testTag>.<value>\`; menu item rows use \`<testTag>.<index>\`, with zero-based positions including dividers. Android adds row tags only when \`testTag\` is set; iOS falls back to \`(testTag ?? id).<value>\` or \`(testTag ?? id).<index>\`.

`;

export const GUIDE_REPEAT = `## Lists: repeat

Wrapping containers require \`prototype_flow_grid_v1\`. A \`flow\` is a wrapping row:
\`style.spacing\` is the item gap, and \`style.runSpacing\` is the line gap (finite dp >= 0,
with the same bounds as spacing). Optional \`maxLines\` is an integer >= 1; overflow is
clipped visually, while all children stay in the hierarchy and count toward node/depth budgets.
A \`grid\` requires \`columns\`: an integer 1..12 or \`{minWidth: dp}\` with finite dp > 0.
Spacing applies to both axes unless runSpacing overrides the row gap. runSpacing is meaningful
only on flow/grid. Grid is always non-lazy and never scrolls itself; wrap it in \`scroll\`.
Children are placed row-major; a span that does not fit the row starts a new row. Optional
\`span\` is an integer >= 1 on any node shape, but is valid only on a direct grid child;
it must not exceed fixed columns. Adaptive runtime spans are clamped to the resolved count.

A \`box\`, \`row\`, \`column\`, \`flow\` or \`grid\` may declare \`repeat: {items, as}\`. Its \`children\` are the template and
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
- Literal items are objects of scalar fields (no nesting); \`as\` is a state-key-shaped identifier.
  A state key cannot hold a list.
- Placeholders are bound in a template child's \`text\`, the label/title/text fields of components
  (button, fab, segmentedButton options, topAppBar, dialog, menu item labels/trailingText, select labels/options, snackbar), state condition operands
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

export const GUIDE_DATA = `## Data

\`data\` is agent-owned, read-only content: nested objects, arrays, strings, finite numbers and
booleans, without null. \`state\` remains the user-owned scalar map; actions only write declared
state keys. A full show replaces data; a capability-gated patch can change data. See the generated Limits table.
The data byte limit uses the \`emit.payload\` cost: every number costs 32 bytes regardless of
its digits, so numeric-heavy data reaches the limit before its serialized size does.

\`MAX_PROTOTYPE_REPEAT_PATH_CELLS\` bounds all path-bound repeats after component expansion,
including empty templates. An instantiated object item costs one cell per projected scalar member,
with a minimum of one cell. Literal repeats do not count. Containers are checked in pre-order;
a crossing container fails at \`repeat.items.path\` with \`Repeat path cell limit exceeded\`, after
its three path-source checks and before template projection.

Pointers are nonempty RFC 6901 paths relative to data, beginning with \`/\`; decode \`~1\` as \`/\`
and \`~0\` as \`~\`. Object keys are exact own members; array indices are \`0\` or a positive decimal
without leading zeros. An empty key uses a trailing slash. Invalid escapes and overlong pointers
are rejected; a missing text path renders empty.

\`\`\`json
{
  "id": "orders",
  "window": { "placement": { "type": "fullscreen" } },
  "data": { "orders": [{ "id": 7, "title": "Latte", "total": 4.5 }], "cartCount": 1 },
  "state": { "liked_7": false },
  "root": {
    "type": "column",
    "repeat": { "items": { "path": "/orders" }, "as": "item", "key": "id" },
    "children": [{ "type": "text", "text": "{item.title} ({data:/cartCount})",
      "visibleWhen": { "data": "/cartCount", "gt": 0 },
      "onTap": [{ "type": "toggle", "key": "liked_{item.id}" }] }]
  }
}
\`\`\`

- \`repeat.items: {path}\` must resolve to an array of objects (empty is valid). Only scalar members
  with field-shaped names are projected into items. \`repeat.key\` names a field every item has;
  its rendered values must be unique, for literal lists too.
- \`{data:/pointer}\` binds only the text-kind fields repeat already binds: text, button/FAB labels,
  segmented option labels, app bar title/navigation/action labels, dialog title/text/button labels,
  menu item labels/trailing text, select labels/option labels, and snackbar text/action label. Missing, object or array values become empty text. Other braces
  stay literal. A data string is inserted as plain text before repeat and state binding, so
  \`{item.x}\`, \`{index}\` or \`{key}\` inside it bind afterwards exactly like authored text.
  Data values cannot be escaped; inserted strings are never scanned again for data placeholders.
  Pointers are untouched by component props.
- \`MAX_PROTOTYPE_SUBSTITUTED_TEXT_LENGTH\` (16384) bounds the sum of replacement UTF-16
  lengths per bindable field at each stage: data in text-kind fields, then repeat in all bindable
  fields for every item, including repeat placeholders inserted by data. Literal characters and
  unresolved repeat placeholders contribute zero. State placeholders are not validated because
  state can change after show. Exceeding the cap fails at the authored field path with
  \`Substituted text length limit exceeded\`.
  \`MAX_PROTOTYPE_SUBSTITUTED_TEXT_TOTAL\` (4194304) also bounds rebuilt text per validation: each
  recognized data stage and each repeat item charges authored stage length plus replacement length,
  including literal units and placeholder tokens. Inside a repeat, a data-resolved field is also
  charged once per item, even without repeat placeholders. Purely literal fields and state
  placeholders are not charged. Crossing the total fails at that field with \`Substituted text total limit exceeded\`.
  During state interpolation, a replacement that would exceed the per-call substitution limit stays
  as written, and later placeholders may still substitute.
- A condition uses exactly one of \`key\`, \`data\`, \`all\`, \`any\`, \`not\`. A data condition has exactly
  one comparison: \`equals\` (same scalar type and value), \`notEquals\` (its inverse, including missing
  or non-scalar), \`gt\` or \`lt\` (numbers only, otherwise false). \`equals\`/\`notEquals\` operands are
  literals; repeat placeholders there are rejected. \`bottomSheet.openWhen\` remains boolean state.

The host validates data and repeat paths; the device resolves bindings once per show before
repeat expansion. All data uses require \`prototype_data_model_v1\`; an older device is refused
before uploads or show, with an update/relaunch hint. \`status\` reports the last successful show's
data next to state; \`inspect\` reports and adopts device data. Absent data is omitted; dismiss
clears it. Events never carry data.
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

- A successful show returns \`lastResult.appearance: {mode, source, deviceDark}\`, and \`inspect\`
  carries the same object on each prototype; after a show crossed by an \`appearance_changed\`
  event, the status entry has no appearance until a later event or \`inspect\` states it.
  \`deviceDark\` is the device's own setting whatever
  decided \`mode\`. Only a device answer states it, and only for the moment it answered: the show
  result and \`inspect\`. \`status\` is host-local, so it reports \`mode\` and \`source\` (kept current by
  \`appearance_changed\` events) and never \`deviceDark\`, because the device can flip while a pinned
  mode stays put and then no event arrives. Call \`inspect\` when you need it now.
- While a prototype is shown it follows the device live. Any change of the resolved mode (the
  device flipping, or prototype state changing a background the mode is inferred from) sends one
  \`appearance_changed\` event with a null \`name\` and the payload \`{mode, source}\`, and refreshes
  \`status\`. Wait for it with \`awaitEvent\` and \`kind: "appearance_changed"\`. Nothing is sent when
  the mode stays the same, nor for the show itself, whose result already carries the mode.
`;

export const GUIDE_COST = `## Runtime cost

What each construct costs on a device, so a large prototype can pick the cheap form. This is
guidance read from the renderer code, not measurement: the Android renderer (Jetpack Compose) and
the iOS agent (SwiftUI) were read, and no statement below has been measured on a device. The only
measurement behind it is epic #12127: a prototype of several hundred nodes on a debug build of the
Android renderer dropped frames on tab switches, section collapses and page swipes. It predates
the fixes noted below and gives no per-construct cost. A row marked *being changed* describes
today's behaviour; the issue it names is open and the row will shrink when it lands.

What one state change costs:

- **Android.** Every state write publishes one new snapshot. The render tree is mapped once per
  snapshot: every node is visited, hidden ones included, and its \`visibleWhen\`, \`styleWhen\` and
  \`{key}\` text are evaluated against the new state. A node whose result equals the previous one
  is reused as the same object, so only the nodes that changed recompose (#12162). The mapping is
  proportional to the node count; the recomposition to the nodes that changed.
- **Android, validation.** A state write is validated by re-checking the new state and the nodes
  that bind a key, not by re-encoding and re-validating the whole spec (#12162). The whole spec is
  checked once, on the first write after a \`show\` or a replace. A tap with several
  \`setState\`, \`toggle\` or \`increment\` actions validates each of them in turn before anything
  is applied.
- **iOS.** Every node view reads the prototype's state, so a state change re-evaluates the body of
  each node on screen and SwiftUI's diffing decides what is redrawn. Each write also re-validates
  the whole tree (every node, in several passes) and re-encodes the state to check the size cap;
  iOS has no equivalent of the Android state-only validation.
- A tap's action list sends one \`change\` event with the final state, however many keys it wrote.

Authoring choices:

- **Writes.** Each \`setState\` in a tap is its own validation and its own state snapshot on
  Android. Prefer one key that several nodes read (a selected tab index that \`visibleWhen\` and
  \`styleWhen\` compare against) over several keys set together. Whether snapshots published in
  one frame are mapped separately depends on frame timing; one key avoids the question.
- **\`styleWhen\` over two \`visibleWhen\` siblings.** On Android a node with \`visibleWhen\` is
  wrapped in an animation container while motion is on; iOS keeps an equivalent container. Two
  siblings with opposite \`visibleWhen\` conditions that cross-fade cost two such wrappers; one
  node whose look changes with \`styleWhen\` costs none, because the style is merged into the
  node's own modifiers.
- **\`visibleWhen\` transition.** The default transition (no \`transition\`, or \`expand\`) animates
  the node's size, which re-measures its siblings while it runs. Use \`transition: "fade"\`,
  \`"slide"\` or \`"none"\` unless the size change is the point. *Being changed (#12136):* every
  \`box\`, \`row\`, \`column\`, \`flow\` and \`grid\` also animates its own size whenever its children change while
  motion is on, so a size change below a container is animated by that container whatever
  transition the child chose. iOS does the same per container, from a layout signature computed
  from the container's children on each state change.
- **Hidden subtrees.** A node hidden by \`visibleWhen\` costs nothing at rest on either platform:
  its subtree is not composed (Android) or not built (iOS). It is built in the frame in which it
  becomes visible, so a large subtree behind \`visibleWhen\` can make that one frame slow; keep
  such subtrees small, or split the prototype. *Being changed (#12133):* on Android a hidden
  subtree is disposed when hidden and rebuilt when shown, and a pager page other than the current
  one is not composed until it is swiped to.
- **\`pressScale\`.** On Android it adds an animated press state and a graphics layer to each
  tappable node that sets it, so put it on buttons, not on every row. On iOS every node with
  \`onTap\`, \`onLongPress\` or \`onDoubleTap\` already has the press gesture, a minimum touch target and a scale effect whether or
  not it sets \`pressScale\`, so \`pressScale\` adds nothing there.
- **Images.** On Android each \`image\` node is a sub-composition that asks the image cache for a
  bitmap sized to the node, so many small images in a list cost more than one strip image. Decode
  is cached and runs off the main thread. Further per-recomposition work in images and icons is
  *being changed (#12138)*. The iOS image path was not checked.
- **Accessibility nodes.** On Android a decorative \`icon\` or \`image\` (not tappable,
  no \`testTag\`, no \`contentDescription\`) reports no node, except inside a tappable node with
  no text of its own and no \`contentDescription\`, where icons and images keep their node and label
  because they are the only way to find it. A tappable \`box\`,
  \`row\`, \`column\`, \`flow\`, \`grid\` or \`card\` whose only text is one \`text\` node is one node
  labelled by that text when its descendants have no independent tags, actions, descriptions,
  controls or visibility conditions. Other non-tappable text, icon and image nodes are never labelled
  with their kind; empty tappable ones keep the kind as their only selector handle. An unlabelled,
  non-tappable layout container (\`box\`, \`row\`, \`column\`, \`flow\`, \`grid\`, \`scroll\`, \`pager\`, \`card\`,
  \`divider\`, \`spacer\`) with no text, \`testTag\`, content description or state also reports
  no node. Every text, tagged node and tappable node stays targetable. Give a \`testTag\` only to
  nodes you will look up. Every accessibility node is work whenever \`observe\` or a screen reader
  reads the tree.
- **Long lists.** A \`scroll\` node builds all of its children up front on both platforms, so a
  long list inside \`scroll\` pays for every row when it is shown. *Being changed on Android
  (#12139).* \`repeat\` expands to real nodes that count against the node limit.
- **\`motion: "none"\`.** It removes the visibility animations, size animations and press springs
  (changes become instant) and a hidden \`visibleWhen\` node is simply absent, so it is the right
  choice for automated checks. Motion is also off when the system animation scale is 0.
- **Window format.** On Android an opaque fullscreen prototype is still composited as a
  translucent layer, whatever the spec says. *Being changed (#12140).*
- **Accessibility events.** The Android accessibility service resolves an event's window type once
  per window rather than once per event (#12160), so a prototype that changes a lot no longer
  pays that lookup on every change event. Throttling the events a prototype's own window emits is
  *being changed (#12134)*.
- **Size.** The node count and the spec bytes are both limited (see Limits) and both drive the
  per-change work above. No tested budget exists yet; for a prototype of several hundred nodes
  every rule above matters, so split it well before it nears the limits.
`;

export const GUIDE_ERRORS = `## Common validation errors

| Message | Fix |
| --- | --- |
| \`Unknown prototype icon name\` | Look the name up with \`automobile:prototype/icons?query=<word>\`. |
| \`Expected object\` / \`Invalid data value\` | Data must be an object of nested JSON values without null or nonfinite numbers. |
| \`Data depth limit exceeded\` / \`Data array limit exceeded\` / \`Data byte limit exceeded\` | Reduce data to the generated limits. |
| \`Invalid pointer value\` | Use a nonempty RFC 6901 pointer within the pointer limit. |
| \`Repeat path does not resolve to an array\` / \`Repeat path resolves to more than 128 items\` / \`Repeat path item <i> is not an object\` | Point to an array of objects within the repeat item limit. |
| \`Duplicate repeat key "x" (items <i> and <j>)\` | Give every item a unique rendered identity. |
| \`Bound state key "x" is invalid (repeat item <i>)\` | A path-bound key must form a valid state key; error is at repeat.items.path. |
| \`Requires key or data\` | Supply one condition source with exactly one comparison. |
| \`Repeat path cell limit exceeded\` | Reduce path-bound repeats or the scalar members projected per item; see \`MAX_PROTOTYPE_REPEAT_PATH_CELLS\`. |
| \`Substituted text total limit exceeded\` | Reduce bindable fields, replacement lengths or repeat items; see \`MAX_PROTOTYPE_SUBSTITUTED_TEXT_TOTAL\`. |
| \`Repeat placeholder in a data condition operand is not supported\` | Use a literal operand; state conditions still bind repeat operands. |
| \`Unknown repeat field "x"\` | Every item needs the field the placeholder names. |
| \`Missing component prop "x"\` / \`Unused component prop\` | Pass exactly the props the component's \`{props.*}\` placeholders name. |
| \`Expanded node limit exceeded\` | Fewer items or a smaller template; the limit counts every instance. |
| a \`stateKey\` rejected | The key must be initialised in \`state\` with the type the node binds (string, boolean, number). |
| an unknown property | Nodes and actions are strict: only the fields listed above are accepted. |

Paths in errors (for example \`root.children[0].text\`) point at the offending value in the spec.
`;

export const GUIDE_PATCH = `### Patch (#11675)

Use \`show\` for a new screen or a window, theme or root change. Use \`patch\` for
content (\`/data\`), state (\`/state\`) or one node by id (\`replaceNode\`). Android CtrlProxy advertises
\`prototype_patch_v1\` and applies patches in place; iOS does not advertise it yet
and requires the whole spec with \`show\`.

\`{action:"patch", id, ops, baseRevision?}\` sends a \`patch_prototype\` frame
\`{requestId, id, baseRevision?, ops}\` only to a device advertising
\`prototype_patch_v1\`. Android and iOS use \`prototype_result\` replies. Success
carries \`revision\`; a state conflict carries
\`{success:false,error,conflict:{revision,state:{key:scalar}}}\`. Revisions are
non-negative safe integers; conflict values are strings, booleans or finite
numbers with valid state keys. Malformed reply fields are dropped. Show, status,
inspect and events do not report revisions through this host contract.

Ops apply in order, completely or not at all. \`add\`, \`replace\`, \`remove\` and
\`test\` address \`/data\` or \`/data\` followed by an RFC 6901 JSON pointer: \`~0\`
escapes \`~\`, \`~1\` escapes \`/\`; array indices are canonical non-negative decimal
integers, and \`-\` appends for \`add\` only. Parent paths must exist. \`replace\`,
\`remove\` and \`test\` require the addressed value to exist. \`add\`, \`replace\` and
\`test\` carry \`value\`; \`remove\` does not. State ops address exactly
\`/state/<key>\`, where keys match \`[A-Za-z_][A-Za-z0-9_]{0,63}\` and values are
strings, booleans or finite numbers.

\`replaceNode\` carries \`{op:"replaceNode",id,node}\`. The id must identify exactly
one node in the tree, cannot be the root or inside a repeat, and the replacement
must keep that id. Replacement nodes cannot contain \`use\` nodes or element
anchors. Inline the component, use a bounds anchor, or use \`show\`.

The agent writes data; the user writes state. Data-only patches and patches
containing only data ops and \`replaceNode\` ignore \`baseRevision\`. Any state op,
including \`test\`, requires \`baseRevision\`. A device supporting the capability
must refuse the whole patch with \`conflict\` if the user changed a touched state
key since that revision, returning the current revision and those keys' values.

There are at most ${MAX_PROTOTYPE_PATCH_OPS} ops, the frame is capped at ${MAX_PROTOTYPE_SPEC_BYTES / (1024 * 1024)} MiB, and the resulting whole
spec must satisfy every spec/data limit, including node count and depth. The
host tracks a cloned copy of the device spec from the last acknowledged show,
with components expanded and anchors resolved. It applies ops to a copy and
runs the full validator before sending. Errors preserve deterministic paths.
The host validates state ops against the agent-declared state and leaves value
comparison for \`/state\` \`test\` to the device; its copy cannot know user edits.

Patches are FIFO per device, with one in flight at a time. A pending show makes
patch refuse as busy. Shows are not delayed by patches. If a dispatched show
and an acknowledged patch overlap, their device-side order is unknown: the host
forgets its spec, warns, and requires a further successful show before patching.
A failed dispatched show, dismissed event, successful dismiss, session release,
device removal or unbinding also ends tracking. An adopted different id ends
tracking; inspecting the same tracked id retains it. A transport failure after
patch dispatch is indeterminate and requires a new show. An atomic device
refusal leaves the tracked copy unchanged. A successful patch refreshes shown
status data without changing \`lastResult\`, timestamps or event snapshots.
`;
