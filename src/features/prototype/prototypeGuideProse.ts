import { MAX_PROTOTYPE_PATCH_OPS } from "./prototypePatch";
import {
  MAX_PROTOTYPE_DATA_ARRAY_ITEMS,
  MAX_PROTOTYPE_LIST_ITEMS,
  MAX_PROTOTYPE_SPEC_BYTES,
} from "./prototypeSpec";
export const GUIDE_GESTURES = `## Platform namespaces

Prefer portable node/window fields, then portable theme tokens, then \`theme.design\` when
available, and finally a platform namespace as the last resort. Every namespace field has a
\`why\` explaining its lack of portable meaning.
Optional \`ios\` and \`android\` objects may appear on any node, \`window\` or \`theme\`.
The other platform’s block is ignored with a \`platformNotes\` entry. Own-platform blocks
require \`prototype_platform_namespace_v1\`; current renderers do not implement these fields.

## Gestures

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
Each declared list is also a named accessibility action on both platforms, so TalkBack and
VoiceOver users reach it without the touch gesture: \`Long press\` and \`Double tap\` (fixed English
names). A single \`onTap\` is the default activation and adds none.

### Swipe actions

A \`row\` or \`listItem\` may declare \`swipeActions: {start?, end?, fullSwipe?}\` (needs
\`prototype_swipe_actions_v1\`). \`start\` is revealed by swiping right and \`end\` by swiping left
(mirrored in right-to-left layouts is not done: sides are physical). Each side holds 1-3 entries
\`{label, icon?, role?, color?, onTap}\`: \`label\` is the button text and its accessibility name,
\`icon\` a built-in icon name (an SF Symbol on iOS), \`role\` \`default\` (primary colours) or
\`destructive\` (error colours), \`color\` a hex or theme role that overrides the background, and
\`onTap\` 1-32 actions. The first entry of a side sits at the screen edge. A release past 40% of
the revealed width, or a fling past the open velocity, leaves the row open; a drag beyond the
revealed width resists (rubber-band). With \`fullSwipe: true\` a drag past 60% of the row (or a hard
fling) runs the swiped side's first entry and closes the row. Only one row is open at a time, and a
tap on an open row closes it instead of running its \`onTap\`. Revealed buttons get the test tag
\`<rowTestTag>.swipe.<index>\`, counting \`start\` entries first and then \`end\`; they exist only while
the row is open. Every entry is also an accessibility action (TalkBack custom action, VoiceOver
action) on the row, so assistive technology can run it without swiping. The reduced profile snaps row settling; spec
\`motion: "none"\` snaps instead of animating. Put swipeActions on repeated rows; a row inside a
horizontal \`pager\` or a \`carousel\` is refused because their drag would compete.

### Pull-to-refresh

A vertical \`scroll\` may declare \`refresh: {stateKey, onRefresh}\` (needs
\`prototype_refresh_v1\`). \`stateKey\` names a boolean state key: the platform's refresh indicator
shows while it is true. A pull sets the key to true and runs \`onRefresh\` like a tap; the prototype
(an \`onRefresh\` \`setState\`, or the agent through \`patch\` on \`/state/<key>\` with a
\`baseRevision\`) sets it back to false to hide the indicator. Declare the key in \`state\` as a
boolean; a horizontal scroll with \`refresh\` is rejected. The pull is a swipe down from the top of
the scroll (\`swipeOn\` with the prototype layer) and \`observe\` reports the scroll as usual.

### Chat lists

A vertical \`scroll\` can be a conversation view (needs \`prototype_chat_scroll_v1\`, Android only for
now): \`reverse: true\` anchors it at the end of its content, so the newest row sits at the bottom;
\`stickToEnd: true\` follows rows appended while it is at the end; \`atEndKey\` names a declared
boolean state key the runtime keeps true while it is at the end (show a "new messages" pill with
\`visibleWhen {key, equals: false}\`); \`onStartReached\` runs each time the start is reached, to load
older history. \`scrollTo {scroll, to: "start" | "end" | {key: <repeat.key value>}, animated?}\` moves
the scroll whose \`id\` is \`scroll\` (exactly one); \`{key}\` scrolls to that repeat row. A composer is a
row with a \`textField\` (\`imeAction: "send"\`, \`onSubmit\`) and a send \`iconButton\`, with
\`safeAreaPadding {edges: ["bottom"], types: ["ime", "systemBars"]}\`. Rows off screen are absent from
\`observe\`; \`swipeOn lookFor\` still finds them.
`;

export const GUIDE_TEMPLATES = `## Starter templates

The repository ships eight validated multi-screen specs, each a \`stack\` with a \`testTag\` on every
interactive node. In a checkout, show one with \`specPath\` (an absolute path) from
\`test/fixtures/prototype-spec/valid/\`, or copy its shape when writing a spec:

- \`template-onboarding.json\`: welcome, sign-up form with \`checks\`, a button gated by
  \`enabledWhen {valid}\`, \`emit\` with \`requireValid\`, done.
- \`template-feed-detail.json\`: a \`repeat\` over \`{path: "/posts"}\` inside a refreshable \`scroll\`; a
  tap stores the row in state and \`push\`es the detail screen.
- \`template-tabbed-home.json\`: a \`pager\` driven by a \`bottomNav {pager}\`, plus a pushed screen.
- \`template-checkout.json\`: quantity stepper, form with \`select\` and \`datePicker\`, and a
  \`bottomSheet\` confirmation.
- \`template-settings.json\`: \`listItem\` switches, \`radioGroup\`, \`slider\`, \`dialog\`, \`snackbar\` and
  a \`storage\` block.
- \`template-search.json\`: docked \`searchBar\` whose child lists \`/results\` and shows an empty
  state with \`{data, empty: true}\`.
- \`template-chat.json\`: reversed \`scroll\` with \`stickToEnd\`, quick-reply chips that
  \`appendData\`, and a composer that \`emit\`s \`message_sent\` with the draft as context (Android only).
- \`template-dashboard.json\`: \`chart\` line, bar and ring over \`/data\`, and a \`startTimer\` clock.
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
Android Back and the iOS edge swipe pop a stack above depth 1. A stack's optional
\`transition: "platform" | "slide" | "fade" | "none"\` selects screen navigation animation
(default \`platform\`); \`push\` and \`replace\` can override it with their own \`transition\`.
Any explicit value needs \`prototype_stack_transitions_v1\`; pop/popToRoot take no override.
Transitions snap under \`motion: "none"\` or Android animator/transition scale 0, and fade under
\`motion: "reduced"\` or iOS Reduce Motion. A stack's
\`transition\` accepts only those four values and no longer animates the stack's own visibility
(earlier specs using \`expand\`, \`scale\`, \`slideStart\`, \`slideEnd\` or \`blurReplace\` on a stack
are now refused): wrap the stack in a \`box\` with \`visibleWhen\` and a visibility transition for
that. Each entry's scroll position is restored on pop. A stack cannot appear inside a repeat template.

On Android, \`show replaceOthers: false\` retains other prototype windows, up to four distinct ids
(requires \`prototype_multi_surface_v1\`); a fifth is refused listing the shown ids. A same-id show
with false replaces only that prototype; omitted or true replaces other ids. \`dismiss {id}\` removes
one, \`dismiss {all: true}\` removes all, and \`status\` lists every shown id. \`inspect\` reconciles
the full list. iOS refuses false and shows one prototype at a time.

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

\`textField.errorWhen\` accepts any condition and forces error styling immediately, independently of checks/validateOn. Optional nonempty \`errorText\` (max 256 UTF-16 units) requires errorWhen. Caption precedence while forced: errorText, currently shown check message, supportingText, then no caption. Both options require \`prototype_string_conditions_v1\`. They do not affect change-event validity, \`{valid}\` or \`requireValid\`, which remain checks-only. Fields without checks do not track validation blur.

A \`textField\` may also declare \`trailingIcon: {icon, label, onTap?}\` (a built-in icon, its
nonempty accessible \`label\` and optional 1-32 \`onTap\` actions, for example a clear button that
\`setState\`s the field's key to an empty string; without \`onTap\` it is decoration),
\`imeAction\` (\`done\`, \`next\`, \`search\`, \`send\` or \`go\`: the keyboard's action key) and
\`onSubmit\` (1-32 actions run when that key is pressed; without \`imeAction\` the key is
\`done\`). Multiline text has no IME action, so \`imeAction\` and \`onSubmit\` are refused with
\`multiline: true\`. These need \`prototype_text_field_actions_v1\`, with the same refusal.
\`leadingIcon\` is a built-in icon name drawn before the text (decoration, no actions; iOS maps it to
an SF Symbol) and needs \`prototype_text_field_leading_icon_v1\`, with the same refusal.

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

## Loading, empty and error states

State-key \`contains\`/\`startsWith\` compare UTF-16 substrings/prefixes, case-sensitive with no Unicode normalization. Literal operands are nonempty strings up to 256 UTF-16 units; repeat placeholders always bind as text (a numeric item renders as its text), and an empty substituted operand holds for every string. \`lengthGt\`/\`lengthLt\` compare UTF-16 length strictly against literal integers 0..100000 (\`😀\` has length 2). Missing or non-string state values fail all four. They are valid only with \`key\`, wherever a condition is accepted, and require \`prototype_string_conditions_v1\`.

(needs \`prototype_loading_states_v1\`) \`{data: "/feed", empty: true}\` holds when the value is
missing, \`[]\`, \`{}\` or \`""\`; \`empty: false\` is its inverse. It replaces the comparison, so
it cannot be combined with another comparison, and it applies to data
conditions only. Style \`shimmer: true\` on a \`box\`, \`row\`, \`column\` or \`card\` sweeps an
animated highlight over its background and reads "Loading" to accessibility; it stays at its rest pose under
\`motion: "reduced"\`, iOS Reduce Motion, \`motion: "none"\` or Android animator/transition scale 0. The canonical trio uses a request's \`statusKey\`:

- **Loading:** a column with \`visibleWhen: {key: "feedStatus", equals: "loading"}\` that repeats a
  few literal placeholder rows styled \`{shimmer: true, height: {dp: 56}, background:
  "surfaceVariant", cornerRadius: "medium"}\`.
- **Empty:** \`visibleWhen: {all: [{key: "feedStatus", equals: "success"}, {data: "/feed",
  empty: true}]}\`, with the "No posts yet" copy.
- **Error:** \`visibleWhen: {key: "feedStatus", equals: "error"}\`, with a retry button that runs
  the request again.

The rows themselves repeat over \`{path: "/feed"}\`. The iOS agent draws shimmer too.

## Style effects

(needs \`prototype_effects_v1\`; no connected device advertises it yet, so the host refuses a spec
with \`style.effects\` until a renderer ships) \`style.effects\` is 1 to 4 paint-only looks drawn in
order inside the node's own bounds: \`noise\`, \`gradientMesh\`, \`shimmer\`, \`glow\`,
\`vignette\`, \`blur\`, \`pixelate\`, \`chromaticAberration\`, \`wave\` and \`ripple\`, each with typed,
bounded params. Shader source is never accepted. Any effect may loop with \`animate:
{periodMs: 400-20000}\` and start at \`phase\` 0-1; a spec has at most 64 effects and 8 animated ones
across its expanded \`repeat\` tree, counting every \`styleWhen\` style's list too.

## Scroll-driven motion

(needs \`prototype_scroll_motion_v1\`) A node under a scroll, pager, carousel or repeat takes
\`scrollTransition: {axis: "horizontal" | "vertical", edge: {scale?, alpha?, rotation?}}\`.
It interpolates from the edge values to identity at the viewport centre. Any node can take
\`scrollLinked: {source: "feed", range: [0, 160], alpha: [1, 0], offsetY: [0, -40]}\`:
\`source\` names a scroll in the same screen; the input endpoints increase, and each output
is a two-number range. Outputs are \`alpha\`, \`scale\`, \`offsetX\`, \`offsetY\` and \`blur\`.
They interpolate linearly and clamp outside the input range. At most 16 bindings are allowed
across the expanded tree; each field counts once per instance. These effects change drawing,
not layout, hit targets or observed bounds. \`motion: "reduced"\` keeps alpha only;
\`motion: "none"\` keeps all scroll-driven outputs. Android blur requires Android 12 or later.

## Style effects

(needs \`prototype_effects_v1\`; no connected device advertises it yet, so the host refuses a spec
with \`style.effects\` until a renderer ships) \`style.effects\` is 1 to 4 paint-only looks drawn in
order inside the node's own bounds: \`noise\`, \`gradientMesh\`, \`shimmer\`, \`glow\`,
\`vignette\`, \`blur\`, \`pixelate\`, \`chromaticAberration\`, \`wave\` and \`ripple\`, each with typed,
bounded params. Shader source is never accepted. Any effect may loop with \`animate:
{periodMs: 400-20000}\` and start at \`phase\` 0-1; a spec has at most 64 effects and 8 animated ones
across its expanded \`repeat\` tree, counting every \`styleWhen\` style's list too.

## Motion profiles and shared elements

\`motion\` is \`standard\` (default), \`reduced\` or \`none\`. Explicit \`motion: "reduced"\`
requires \`prototype_reduced_motion_v1\`. iOS Reduce Motion selects the reduced profile;
Android animator scale or transition scale 0 selects off. Spec \`none\` or system off wins over
reduced. Reduced replaces spatial animation (slides, scale, container size, presses, swipe-row
settling, pager scrolling and shared morphs) with a crossfade or snap with fade. Shimmer and
other ambient/attention loops stop at rest and report no loop; color, alpha and fades still animate.
Off makes every change instant.

\`sharedKey\` requires \`prototype_shared_element_v1\` and \`visibleWhen\` on the same node.
Keys match \`[A-Za-z_][A-Za-z0-9_]{0,63}\`; each key labels exactly two nodes, at most 16 distinct
keys per spec. A pair cannot be ancestor/descendant, and neither a repeat carrier nor any node
inside its template may carry a sharedKey. Authors choose visibility conditions so the pair is
not visible together. Full motion morphs the pair's bounds between different content; reduced
uses ordinary visibility fades and off swaps instantly.

## Motion v2

(needs \`prototype_motion_v2\`) A node's \`animate: {durationMs?, easing?}\` (0-2000 ms, default
300; \`standard\`, \`emphasized\`, \`linear\` or \`spring\`) animates changes to its \`alpha\`,
\`offset\`, \`scale\`, \`rotation\`, \`background\` and \`color\`, typically from \`styleWhen\`; without
it they are instant. Style \`scale\` (0-4) and \`rotation\` (degrees, -360..360) draw about the
node's centre without moving siblings. \`transition\` also takes \`slideStart\` / \`slideEnd\`
(slide in from that edge, mirrored right to left: drawers) and \`scale\`. An \`image\` with
\`zoomable: {maxScale}\` (1-8) pinches, pans when zoomed and toggles 1x/2x on a double tap, with
accessibility zoom actions; it cannot also have \`onDoubleTap\`. Everything snaps under
\`motion: "none"\` or Android animator/transition scale 0. In the reduced profile spatial changes
snap or crossfade; color and alpha still animate. The iOS agent does not support Motion v2 yet (#14684).

## Choreography

(needs \`prototype_choreography_v1\`) On nodes other than stacks, \`transition\` also takes \`{type, delayMs?}\` (\`delayMs\` 0-600 ms, the wait
before the enter starts) besides the plain names, and \`blurReplace\`: a blur-and-fade enter and exit
(iOS \`.blurReplace\`; Android 12 and later blur, Android 11 and earlier fade only). A \`box\`, \`row\` or \`column\` takes \`stagger: {ms, order?}\` (\`ms\` 0-100 per child;
\`order\` \`forward\` (default), \`reverse\` or \`center\`): its direct children with \`visibleWhen\`
enter one after another in layout order, each \`ms\` apart, including the children a \`repeat\` makes.
A child's own \`transition.delayMs\` adds to its stagger wait, and no child may wait more than 600 ms
in all (a literal \`repeat\` is counted; a data-bound one is clamped on the device). Delays are zero
under \`motion: "none"\` or Android animator/transition scale 0. In the reduced profile spatial
transitions become fades. Delays apply to enters only. The iOS agent does not
support it yet.

## Lazy lists

\`list {repeat:{items:{path},as,key},children:[row],axis?,header?,footer?,spacing?,contentPadding?,onEndReached?,endThreshold?,refresh?,maxItems?}\`
is a lazy scrolling collection (needs \`prototype_lazy_list_v1\` and \`prototype_data_model_v1\`).
The path resolves to at most ${MAX_PROTOTYPE_LIST_ITEMS} objects; \`key\` is required, projected and unique. Empty arrays
are valid. Axis defaults to vertical; spacing/padding are nonnegative dp. One row template and
optional header/footer each count once toward node/image limits, while per-item binding and text
budgets still apply. Header/footer are ordinary nodes outside the row scope. Never nest lists,
put a list in a repeat, or put a same-axis scroll above/below a list. Rows cannot nest repeats/pagers.
Only composed rows are in \`observe\`; use \`swipeOn\` to reach more. Row keys preserve identity.
\`onEndReached\` fires for nonempty rows within \`endThreshold\` of the end (1–50, default 3), once
per \`(rowCount,lastRowKey)\` signature; empty/no-change pages never refire. Signature state survives
recomposition and resets on show. \`endThreshold\` needs \`onEndReached\`. Vertical \`refresh\` uses
scroll.refresh semantics and a declared boolean key (also needs \`prototype_refresh_v1\`).
\`maxItems\` (1–${MAX_PROTOTYPE_LIST_ITEMS}) requires initial data to fit; appending trims oldest rows atomically before
final data limits. The smallest cap among lists sharing the exact data path wins.
\`request.append:{from,to}\` (same lazy-list capability) extracts a response array from an object
member at \`from\`, extends the existing \`/data/...\` array \`to\`, and writes the remaining response
to optional \`into\`. These paths must not overlap. Any failure rolls back all writes and returns
\`invalid_response\`. Extend events precede into/meta/status/request/onSuccess events; change
payloads are \`{op:"append"|"extend"|"prepend",value,maxItems?,revision}\`. \`prependData {path,value}\` resolves one row and sends writer op \`prepend\` with \`value:[row]\`;
it requires the lazy-list, data-actions and data-model capabilities. It uses the smallest matching
list cap and trims from the end, keeping the first maxItems rows. A missing event value means the
page exceeded the byte budget and the host stops tracking the spec.
Renderers keep the first visible row key and offset across writes, even at the top; new rows sit
above it. Headers/footers are not anchors; a trimmed key uses the renderer default. Each stack
entry restores its list key/offset after push/pop; a missing key falls back to the nearest surviving
index or top. Prepend, anchoring and per-stack-entry list scroll restore are not device-verified
until the acceptance run; benchmark qualification remains unverified.

## Charts

\`{type: "chart", variant, series, yRange?, xLabels?, goal?}\` draws a \`line\`, \`area\`, \`bar\` or
\`ring\` chart (needs \`prototype_chart_v1\`). \`series\` holds 1-4 \`{path, x?, y, label, color?}\`
entries: \`path\` is a \`/data\` pointer to an array of objects (empty is valid, at most ${MAX_PROTOTYPE_DATA_ARRAY_ITEMS} items as
for any data array), \`y\` names each point's numeric member and \`x\` its optional label member;
\`color\` is a hex or theme role, or a \`{light, dark}\` pair. Points are drawn in array order, so
\`appendData\`, a \`request\` \`into\` or a \`/data\` patch re-renders the chart. \`yRange {min, max}\`
fixes the axis (max above min); otherwise it spans the values and the goal, and bars rise from zero.
\`xLabels\` is \`none\` (default), \`ends\` or \`all\` of the first series' x labels. \`goal\` draws a
dashed reference line; a \`ring\` takes exactly one series and a positive \`goal\`, and draws that
series' latest value against it. The chart is one accessible node labelled with its summary, such as
"Line chart, Heart rate, 24 points, min 58, max 141, latest 72" or "Ring chart, Steps, 6500 of
10000"; \`observe\` reports it, and an authored \`contentDescription\` replaces it. A literal path that
does not resolve to an array, a point that is not an object, or a point whose \`y\` is not a number
fails at \`<path>.series[i].path\` or \`.y\`. The iOS agent draws charts with Swift Charts.

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

### Linkify

\`linkify: {kinds, style?, onTap}\` on a text node with \`text\` (not \`spans\`) turns @mentions,
#hashtags and URLs in the resolved text (for example \`{item.body}\`) into links. \`kinds\` lists 1-3 of
\`mention\`, \`hashtag\`, \`url\`; \`style\` takes the span style fields. A match starts at the start of
the text or after whitespace: a mention is \`@\` + 1-30 of \`[A-Za-z0-9_]\` (\`ana@example.com\` is not
one), a hashtag \`#\` + up to 100 letters, digits or \`_\` (not all digits), a URL \`http(s)://\` up to
whitespace without trailing punctuation. Inside \`onTap\` only, \`{match: "text"}\` (the tapped
\`@ana\`) and \`{match: "kind"}\` work as a \`setState\` value, a \`setData\`/\`appendData\` value or an emit
context entry: \`[{type:"setState",key:"profileHandle",value:{match:"text"}},{type:"push",stack:"nav",screen:"profile"}]\`.
Repeat bindings are refused inside linkify \`onTap\`. URL taps never open a browser. Requires
\`prototype_linkify_v1\`.

## Saved prototypes

Use \`save\` with \`spec\`, optional \`assets\`, \`label\` (defaults to \`spec.id\`) and
\`icon\` (an asset id uploaded in \`assets\` in that same call). Android needs
\`prototype_saved_v1\`. On iOS this is simulator only and needs no prototype agent:
the viewer template is resolved from the verified release asset, or from
\`AUTOMOBILE_IOS_PROTOTYPE_VIEWER\` (build it with \`scripts/ios/prototype-viewer-build.sh\`).
Omit \`icon\` for the default app icon. Pinning returns \`pinned:"unsupported"\`; the iOS
app icon is already on the home screen. \`listSaved\` on iOS returns bundle ids accepted by
\`deleteSaved\`, with \`pinned:false\` and no \`savedAt\` (the save time cannot be recovered).
\`deleteSaved\` also accepts the authored id; it removes the iOS app icon, so
\`removeIcon:true\` is ignored with a warning.

On Android or an iOS simulator with the ProtoViewer app installed, \`save\` without \`pin\` or \`icon\` imports
the prototype into the ProtoViewer library instead, and does not need CtrlProxy or
\`prototype_saved_v1\`. It returns \`viewer\` \`{app, libraryId, label}\`; every save is a new
library entry, which \`listSaved\` and \`deleteSaved\` do not see. ProtoViewer treats the entry
as imported: its requests stay off until the user allows network in ProtoViewer, and it is not
attached to this host (no \`awaitEvent\`, \`patch\` or \`inspect\`). \`{action:"open",id}\` with
that \`libraryId\` launches it on Android or an iOS simulator. It needs ProtoViewer installed.
If ProtoViewer is absent, too old for this route, or its inbox cannot be used, \`save\`
keeps the platform save path. A timeout after delivery may still have saved the entry; check
ProtoViewer before retrying.

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

## Frosted backdrop

\`window.backdrop\` is \`{material, blur?, tint?}\` and blurs what is behind the window on any
placement (not the prototype's own content). \`material\` is one of \`ultraThin\`, \`thin\`,
\`regular\`, \`thick\` or \`glass\` (Liquid Glass, iOS 26+ only). \`blur\` is an optional whole radius in
dp (points on iOS), 0-150. \`tint\` is one hex or role colour, not a light/dark pair. The host refuses
the show on a device without \`prototype_backdrop_v1\`. Where the platform cannot blur, the device
draws a tonal fill (\`tint\` at 85% alpha, else the \`surfaceContainer\` role at 85%) and \`lastResult.backdrop\` is
\`fallback\`; otherwise it is \`blur\`.


## Tooltip and drawer

\`tooltip\` requires \`prototype_tooltip_v1\`, boolean \`openWhen: {key, equals}\`, nonblank \`text\`, and exactly one of \`anchorTo\` (a unique node id in the same spec, other than itself) or \`anchor\` (the existing element selector or bounds anchor). Element anchors are resolved by the host to a target rect; native renderers hoist the tooltip as an overlay, not ordinary anchored content. IDs are literal: repeated targets with multiple instances and duplicate component-instance ids are ambiguous and rejected; a repeat with no items supplies no target.

Optional \`caret\` is \`auto\` (default), \`top\`, \`bottom\`, \`start\` or \`end\`: it names the bubble edge pointing at the target, so \`top\` places the bubble below the target. Auto chooses a side with room; auto and explicit sides flip to the opposite side when needed to stay inside the window. Optional strict \`spotlight: {padding?, cornerRadius?}\` draws the scrim role with a rounded hole around the target: integer dp 0..64, defaults 8 and 12 respectively. Without spotlight there is no scrim. Tapping outside the bubble on the spotlight scrim, or tapping the bubble without \`onTap\`, writes \`!equals\` to the open key, then runs optional \`onDismiss\` (1..32 actions). Bubble and scrim tags are \`<testTag>\` and \`<testTag>.close\`. Use one boolean per step for a coach-mark tour; a step's \`onTap\` uses \`setState\` to close its key and open the next step's key. Numeric equality is not supported by \`openWhen\`.

\`drawer\` requires \`prototype_drawer_v1\`, \`edge: "start"|"end"\`, boolean \`openWhen: {key, equals}\` and a \`child\` node. Start/end follow layout direction. The renderer fixes panel width; there is no width field. Optional \`scrim\` accepts the same color value (including mode pairs) as bottomSheet and defaults to the scrim role. Optional \`dismissOnSwipe\` defaults to true, as for bottomSheet. Both nodes accept the common node fields, including \`onTap\`, but no long-press or double-tap handlers.

## Menu and select

\`menu\` and \`select\` require \`prototype_menus_v1\`; the host refuses them before showing or uploading assets when the connected renderer lacks it.

A \`menu\` requires \`openWhen: {key, equals}\` with a boolean equality and 1–16 strict \`items\`. Each item is \`{label, icon?, trailingText?, enabled?, onTap?}\` or exactly \`{type:"divider"}\`. Labels and trailing text are nonempty, icons use the existing icon names, and \`onTap\` has 1–32 existing actions. A disabled item is dimmed, cannot be tapped and does not close the menu. Dividers are neither focusable nor tappable. The elevated surface is anchored to its parent’s bottom end and clamped inside the window; it opens above its anchor when it does not fit below. An enabled item or outside tap writes \`!equals\` to the open key; item actions run after closing.

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

A \`carousel\` (\`prototype_carousel_v1\`) is a horizontally scrolling row of items, one per child
(at least one), that snaps to items and may declare \`repeat\` like \`row\`. \`itemWidth\` (dp, > 0)
is required. \`variant\` is \`multiBrowse\` (default; items change width as they scroll, Android
Material), \`hero\` (centered large item) or \`uncontained\` (fixed-width items). \`itemSpacing\`
is dp >= 0. iOS draws every variant as fixed-width snapping items.
A pager's optional \`stateKey\` binds a declared nonnegative integer number key both ways
(requires \`prototype_pager_state_key_v1\`). Swipes write the key and emit \`page_changed\`
and \`change\`; state writes and patches move the pager, clamped to its page range, animated
unless \`motion: "none"\`. Initial/replacing-show state wins over retained pages. Use the
same key on a tabBar/bottomNav for simple shared selection, and read it in \`styleWhen\`
on a row of dot boxes outside the pager. Two pagers cannot share a key; binding inside
repeat templates is refused. \`setPage\` writes the same selection.
A pager may also declare
\`indicator: "dots"\` (default \`none\`): page dots below the pages, with the current page filled;
they need the same capability. A carousel has no page index, event or \`setPage\` target; use a
\`pager\` when the page matters.

A \`box\`, \`row\`, \`column\`, \`flow\`, \`grid\` or \`carousel\` may declare \`repeat: {items, as}\`. Its \`children\` are the template and
are instantiated once per item, in order, as siblings inside the same container (the container
itself is not repeated). For eagerly composed rows use a \`column\` with \`repeat\`; for lazy rows use the \`list\` node.

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
  Anything else, including a \`{key}\` state placeholder and other braces, is left untouched. A show or patch lists a placeholder
  in such a field as \`placeholderFindings\` (for example \`chip.label\` or \`badge.text\`).
  (\`equals\`/\`notEquals\`/\`contains\`/\`startsWith\` strings, including inside \`errorWhen\`) and \`textField.errorText\`, \`setState.value\` and \`emit.name\`. \`emit.payload\` is not bound.
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

export const GUIDE_EMIT_CONTEXT = `### Emit context

Use a stable \`emit.name\` such as \`pick\` and \`context: {id: {item: "id"}}\` to report a
repeat item's id, instead of encoding the id into the event name. \`emit.payload\` stays literal
and uninterpolated; context is resolved on the device when the emit action runs, after earlier
actions in the same atomic \`onTap\` list. For example, setState then emit reads the new state.

Each nonempty context name has a strict binding object with exactly one key:

- \`{state: key}\` reads state; repeat placeholders such as \`liked_{item.id}\` bind to concrete keys.
- \`{item: field}\` reads a typed repeat field; \`{index: true}\` reads its zero-based numeric index.
  Both require a repeat template. The field must exist in every item; data-path repeats use the
  same scalar projection as text placeholders. Expansion replaces these bindings with \`{value: ...}\`.
- \`{page: pagerId}\` reads an existing pager's current numeric page.
- \`{data: pointer}\` reads any JSON value via the existing data pointer syntax and
  \`MAX_PROTOTYPE_DATA_POINTER_LENGTH\`; it also requires \`prototype_data_model_v1\`.
- \`{value: json}\` is literal JSON, subject to the emit payload depth limit.

Missing state keys and data paths resolve to null. \`MAX_PROTOTYPE_EMIT_CONTEXT_ENTRIES\` bounds the
number of entries. The resolved object's compact JSON UTF-8 bytes
are bounded by \`MAX_PROTOTYPE_EMIT_PAYLOAD_BYTES\`; this runtime count includes multibyte strings
and compact JSON numbers, rather than the payload validator's conservative numeric cost.
If over budget, sort entries by ascending name (byte-wise UTF-8 order), keep the longest prefix
that fits and omit all remaining entries. An oversized first entry produces \`{}\`. The tap succeeds.

A show or patch replacement using \`emit.context\` requires \`prototype_emit_context_v1\`; older
devices are refused before upload, display or patch dispatch. The \`prototype_event\` wire has \`context\` next to the unchanged
\`payload\` only if the emit declared context (including an empty object). It has
\`contextTruncated: true\` only when truncated; otherwise the field is omitted, never false.
\`awaitEvent\` and host status preserve these fields.

`;

export const GUIDE_DATA_ACTIONS = `### Data actions

A tap can change \`/data\` on the device without the agent answering it. Three actions write a
member of \`data\`; each \`path\` is \`/data\` plus a non-empty data pointer (the same syntax and
\`MAX_PROTOTYPE_DATA_POINTER_LENGTH\` as \`{data: pointer}\`), so the whole document cannot be
written:

- \`{type: "setData", path, value}\` creates or replaces an object member, or replaces an existing
  array element. A missing parent is an error.
- \`{type: "appendData", path, value}\` appends to the existing array at \`path\`.
- \`{type: "prependData", path, value}\` inserts one row at the start; list maxItems trims from the end.
- \`{type: "removeData", path}\` removes an existing member or element; later elements shift down.

\`value\` uses the emit.context binding forms except \`page\`: \`{value: json}\` is the literal,
\`{state: key}\` reads state, \`{data: pointer}\` reads data, and \`{item: field}\` and
\`{index: true}\` read the repeat row (repeat only). A written value must be data: strings, booleans,
finite numbers, arrays and objects, without null. Inside a repeat, a whole \`{index}\` segment of
\`path\`, as in \`/data/cart/{index}\`, is bound to the current row; \`{index}\` anywhere else, or
\`{alias.field}\`, is rejected.

The host validates pointer syntax and \`{index}\` use, rejects a literal value data cannot hold, and
rejects an \`appendData\` or \`prependData\` whose target resolves in the spec's own \`data\` to something other than an
array. A target that only exists after earlier writes is checked by the device. A write that would
leave \`data\` over \`MAX_PROTOTYPE_DATA_WRITE_BYTES\` (or over a depth or array limit), or whose
target is missing or not an array, changes nothing.
Actions run in order, so a later action sees an earlier write.

Each write is a \`change\` event with \`name\` the written \`/data/...\` path and \`payload\`
\`{op: "set"|"append"|"remove", value?, revision}\`; \`awaitEvent\` with \`kind: "change"\` returns it.
\`revision\` is the device revision after the write, the same counter as a patch result's. The host
applies each write to its own copy of the spec and to \`status\` data, so both stay current. The
agent's \`/data\` patches and a device's writes never silently lose each other: once the device
has written a prototype's data, a patch with \`/data\` ops needs \`baseRevision\` (the latest
\`revision\` the agent has seen) and is refused with \`conflict: {revision, state, data}\` when a write
newer than that revision touched an overlapping path (\`data\` lists those paths). A \`show\` makes its
own \`data\` authoritative again and clears the history.

Data actions require \`prototype_data_actions_v1\`. A show or patch result that contains one is
refused on a device without it, before anything is shown or sent.

`;

export const GUIDE_STORAGE = `### Storage

A show resets \`state\` and \`data\` to the spec's values, so what the user typed or a data action
changed is lost on the next show, and saved prototypes keep the spec but no user data. A root-level
\`storage\` block keeps chosen values on the device, for example
\`"storage": {"version": 1, "keys": ["state:darkMode", "data:/cart"]}\`.

\`version\` is an integer from 1; \`keys\` holds 1 to \`MAX_PROTOTYPE_STORAGE_KEYS\` unique entries.
\`state:<key>\` names a key declared in \`state\`. \`data:<pointer>\` is an RFC 6901 pointer to a member of
\`data\` (the pointer is relative to \`data\`: \`data:/cart\` is \`/data/cart\`, the path a data action
uses; the whole document is refused). Listing a pointer and its ancestor or descendant is rejected,
and the values the spec itself holds for the listed keys must fit \`MAX_PROTOTYPE_STORAGE_BYTES\`
(counted as the UTF-8 bytes of each storage key plus its compact JSON value).

The device saves each listed key, keyed by the spec \`id\`, after every write: a user edit, a device
data action or a request response. A write that would take the stored total over
\`MAX_PROTOTYPE_STORAGE_BYTES\` still applies on screen but is not stored (\`skippedKeys\` in inspect).
Stored values survive a dismiss, a process restart and a saved prototype's relaunch.

Precedence on the next show of the same \`id\` (the adopted decision of #12522):

- Stored values replace the spec's values for the listed keys. The spec's \`state\` is otherwise still
  authoritative.
- A different \`storage.version\` than the values were stored under discards all of them: the spec's
  values stand. Bump \`version\` when you change what a key means.
- A stored key the spec no longer lists is dropped, and a show without a \`storage\` block drops every
  stored value of that id.
- A stored value that no longer fits the spec is dropped and the spec's value stands: a \`state\` value
  whose type (string, number, boolean) differs from the spec's, a state key the spec no longer
  declares, a \`data\` value of another JSON kind than the spec's value at that pointer, or one that
  cannot be written there (missing parent, a data limit).
- Restoring happens before the first draw and emits no \`change\` event. After a show, read the real
  values with inspect: the show result and the host's cached copy carry the spec's values.
- A host \`patch\` against a stored key wins: it applies under the usual \`baseRevision\` conflict rules
  and the device then stores the new value.

\`inspect\` reports \`storage: {version, keys: [{key, bytes}], totalBytes, skippedKeys?}\` per prototype
for the keys that currently hold a stored value, or omits it when the device does not report it.
\`{action: "clearStorage", id}\` wipes the stored values of an id (the next show starts from the spec;
the result has \`cleared\`, the number of keys removed). \`deleteSaved\` also clears that id's storage.
\`storage\`, \`clearStorage\` and the report need \`prototype_storage_v1\`: a spec with \`storage\` is refused
before anything is shown, and \`clearStorage\` before anything is sent, on a device without it.


`;

export const GUIDE_REQUEST = `### Requests

\`{type: "request", url, method?, headers?, query?, body?, into?, statusKey?, via?, timeoutMs?, onSuccess?, onError?}\`
calls an HTTP endpoint from a tap and writes the answer into \`/data\`, so a prototype can load and
post real content without the agent answering each tap. It requires \`prototype_network_v1\`
(\`prototype_network_device_v1\` as well for \`via: "device"\`); a show or patch result containing
one is refused on a device without them.

- \`url\` is an absolute \`http\` or \`https\` URL (at most 2048 characters). Host requests apply an
  egress policy: local destinations and daemon ports on private addresses are not permitted.
  It takes the text placeholders of any text field (\`{key}\` state, \`{data:/pointer}\`, repeat \`{item.field}\` / \`{index}\`). Without a
  placeholder it must parse as an http(s) URL; with one, it must start with a literal \`http://\` or
  \`https://\`. (\`{state:key}\` is not a placeholder: write \`{key}\`.)
- \`method\` is GET (default), POST, PUT, PATCH, DELETE or HEAD. A GET or HEAD cannot have a \`body\`.
- \`headers\` and \`query\` (up to 16 entries each) map a name to a literal string or to a value
  binding: \`{state: key}\`, \`{data: pointer}\`, \`{value: scalar}\`, \`{item: field}\` / \`{index: true}\`
  (repeat only). A bound value must be a string, number or boolean. \`query\` entries are set on the URL
  in order (a key already in the URL is replaced). Literal header and query strings take the same
  text placeholders as \`url\`.
- \`body\` is a value binding, so a literal body is \`{value: json}\`; \`{state: key}\` sends the state
  value and \`{data: pointer}\` the data subtree. A non-string body is sent as JSON with
  \`Content-Type: application/json\` unless a header sets one; a string body is sent as is.
- \`into\` is a \`/data/<pointer>\` path with the data-action rules (a whole \`{index}\` segment inside a
  repeat); it must name an object member, not an array element, and its parent must exist. Without
  \`into\` nothing is written to data.
- \`statusKey\` names a declared **string** state key. The device sets it to \`"loading"\` when the
  request starts and to \`"success"\` or \`"error"\` when it ends, so \`visibleWhen\` can show a spinner
  (\`{key: "feedStatus", equals: "loading"}\`) or an error. Do not bind it to a control with fixed options.
- \`via\` is \`"host"\` (default: the host runs the call and the device sends only the resolved request
  frame) or \`"device"\` (the device makes the call itself, which on Android reaches localhost through
  \`adb reverse\`, see below).
- \`timeoutMs\` is optional, 1 to \`MAX_PROTOTYPE_REQUEST_TIMEOUT_MS\`; the default is
  \`DEFAULT_PROTOTYPE_REQUEST_TIMEOUT_MS\`.
- \`onSuccess\` and \`onError\` are action lists (1 to 32) run after the request ends, for example
  \`setState\`, \`push\` or another \`request\`. Requests nest up to \`MAX_PROTOTYPE_ACTION_DEPTH\` levels.

**Response.** A 2xx response is parsed: JSON is written to \`into\` exactly as \`setData\` would write it,
anything else as a string, an empty body (and a HEAD) as \`""\`. The response must be data (no null,
within the data limits) or the request fails with \`invalid_response\`. Metadata goes to \`<into>__meta\`,
a sibling whose key is the last segment of \`into\` plus \`__meta\` (\`/data/feed\` writes
\`/data/feed__meta\`): \`{status?, headers?, durationMs, error?: {code, message}}\`. \`status\` and
\`headers\` (names lower-cased) are present once a response arrived; \`error\` is present for every
failure. A non-2xx status leaves \`into\` untouched, writes the metadata with
\`error: {code: "http_error", message: "HTTP 404"}\` and counts as an error. If the metadata would not fit
the data write limit, \`headers\` is dropped. Other \`error.code\` values: \`timeout\`, \`too_large\`,
\`connection_refused\`, \`blocked_destination\` (the destination is not permitted), \`cancelled\`, \`invalid_url\`, \`invalid_request\`, \`network\`, \`too_many_in_flight\`,
\`invalid_response\`.

**Order.** On completion the device writes \`into\`, then \`<into>__meta\`, then \`statusKey\`, then sends the
request event, then runs \`onSuccess\` or \`onError\`. Each \`/data\` write is a \`change\` event as for data
actions. The request event is an \`emit\` with \`name\` \`prototype_request\` (reserved: an authored
\`emit\` cannot use it) and \`payload\`
\`{requestId, method, url, via, into?, outcome: "success"|"error", status?, durationMs, error?: {code, message}}\`,
where \`url\` is the resolved URL cut to 2048 characters. Await it with
\`awaitEvent {kind: "emit", eventName: "prototype_request"}\`.

**Limits.** A response body over \`MAX_PROTOTYPE_RESPONSE_BYTES\` fails with \`too_large\` (the value never
exceeds \`MAX_PROTOTYPE_DATA_WRITE_BYTES\`, so an accepted response fits one \`/data\` write). At most
\`MAX_PROTOTYPE_REQUESTS_IN_FLIGHT\` requests run per device; another fails with \`too_many_in_flight\`.
A request to an \`into\` that already has one in flight cancels the first: the latest request wins. The
cancelled one writes nothing, does not touch \`statusKey\`, runs no follow-up and reports a
\`cancelled\` event. Dismissing the prototype cancels all its requests.

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
- A condition uses exactly one of \`key\`, \`data\`, \`platform\`, \`valid\`, \`all\`, \`any\`, \`not\`. A data condition has exactly
  one comparison: \`equals\` (same scalar type and value), \`notEquals\` (its inverse, including missing
  or non-scalar), \`gt\` or \`lt\` (numbers only, otherwise false), or \`empty\` (data only). \`equals\`/\`notEquals\` operands are
  literals; repeat placeholders there are rejected. Key forms also accept \`contains\`, \`startsWith\`, \`lengthGt\` or \`lengthLt\` (see string conditions). \`bottomSheet.openWhen\` remains boolean state.

The host validates data and repeat paths; the device resolves bindings once per show before
repeat expansion. All data uses require \`prototype_data_model_v1\`; an older device is refused
before uploads or show, with an update/relaunch hint. \`status\` reports the last successful show's
data next to state; \`inspect\` reports and adopts device data. Absent data is omitted; dismiss
clears it. Events carry data only as the value of a device data write (see Data actions).
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

export const GUIDE_APPEARANCE = `## Style polish

Layered style.shadows (1-3 strict {color,radius,spread?,offset?,inner?}, radius 0-1000 dp, spread and offset axes -1000..1000; omitted spread/offset/inner mean 0/{x:0,y:0}/false), style.cornerStyle circular|continuous (default circular), style.border {width,color? ,gradient?} with exactly one of color or gradient, scroll.fadeEdges {top?,bottom?,start?,end?} (0-1000 dp, at least one), and image.filter {saturation?,tint?} (saturation 0-2, at least one) require prototype_style_polish_v2. shadows excludes elevation and shadowColor. Fades appear only where scrolling remains; start/end mirror in RTL. Colour pairs in shadows and tint, and pairs or role names in border gradient stops also require prototype_theme_modes_v1.

Rendering order: transform, press scale, size, alpha, drop shadows (shadows/elevation before the clip), clip (cornerRadius + cornerStyle), background, gradient, shimmer, border (color or gradient), inner shadows.

## Light and dark mode

Theme design: \`theme.design\` accepts \`material\` or \`platform\` (default). Explicit platform
requires \`prototype_design_platform_v1\`; omission silently keeps today's drawing on older renderers.
Android platform look is Material. On iOS button, slider, datePicker and timePicker already use
native controls; layout/content nodes are neutral and other nodes retain Material drawing.
Explicit platform requests report \`design.fallback\` notes for those nodes (first 20 paths, plus
\`total\` beyond); omitted design and material do not. See the contract's \`designCoverage\` table.

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

Input and state changes (text input, toggles, sliders etc.) arrive as kind \`emit\` with \`eventName\` \`change\` (there is no separate \`change\` kind), with payload \`{key,value}\` for one changed key or \`{keys,values}\` for several.
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
- **Reserved \`testTag\` prefix.** A \`testTag\` cannot start with \`automobile-\`: the host's own dismiss
  controls use \`automobile-prototype-dismiss\`, and a spec that takes one is rejected with the node's path.
  \`tapOn\` keeps its point off those controls, or fails naming one that covers the whole target.
- **Long lists.** A \`scroll\` node builds all of its children up front on both platforms, so a
  long list inside \`scroll\` pays for every row when it is shown. *Being changed on Android
  (#12139).* \`repeat\` expands to real nodes that count against the node limit.
- **\`motion: "none"\`.** It removes the visibility animations, size animations and press springs
  (changes become instant) and a hidden \`visibleWhen\` node is simply absent, so it is the right
  choice for automated checks. Motion is also off when Android animator or transition scale is 0. The reduced profile
  keeps fades and color/alpha animation while removing spatial movement and ambient loops.
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
| \`Requires key or data or platform\` | Supply one condition source with exactly one comparison. |
| \`Repeat path cell limit exceeded\` | Reduce path-bound repeats or the scalar members projected per item; see \`MAX_PROTOTYPE_REPEAT_PATH_CELLS\`. |
| \`Substituted text total limit exceeded\` | Reduce bindable fields, replacement lengths or repeat items; see \`MAX_PROTOTYPE_SUBSTITUTED_TEXT_TOTAL\`. |
| \`Repeat placeholder in a data condition operand is not supported\` | Use a literal operand; state conditions still bind repeat operands. |
| \`Unknown repeat field "x"\` | Every item needs the field the placeholder names. |
| \`Missing component prop "x"\` / \`Unused component prop\` | Pass exactly the props the component's \`{props.*}\` placeholders name. |
| \`Expanded node limit exceeded\` | Fewer items or a smaller template; ordinary repeats count every instance; lazy list templates count once. |
| \`maxRuns requires everyMs\` | Supply everyMs or remove maxRuns. |
| \`Too many distinct timer ids\` | Use at most eight distinct startTimer ids, including nested actions and components. |
| a \`stateKey\` rejected | The key must be initialised in \`state\` with the type the node binds (string, boolean, number). |
| an unknown property | Nodes and actions are strict: only the fields listed above are accepted. |

Paths in errors (for example \`root.children[0].text\`) point at the offending value in the spec.
`;

export const GUIDE_PATCH = `### Patch (#11675)

Use \`show\` for a new screen or a window, theme or root change. Use \`patch\` for
content (\`/data\`), state (\`/state\`) or one node by id (\`replaceNode\`). Android CtrlProxy advertises
\`prototype_patch_v1\` and applies patches in place; the iOS prototype agent advertises it too
(a relaunched app loads the current agent), so an older agent still needs the whole spec with \`show\`.

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
containing only data ops and \`replaceNode\` ignore \`baseRevision\`, until the device has
written the prototype's data with a data action (\`prototype_data_actions_v1\`): from then on a
\`/data\` op also needs \`baseRevision\` and conflicts with newer overlapping device writes (see
Data actions). Any state op, including \`test\`, requires \`baseRevision\`. A device supporting the capability
must refuse the whole patch with \`conflict\` if the user changed a touched state
key since that revision, returning the current revision and those keys' values.

There are at most ${MAX_PROTOTYPE_PATCH_OPS} ops, the frame is capped at ${MAX_PROTOTYPE_SPEC_BYTES / (1024 * 1024)} MiB, and the resulting whole
spec must satisfy every spec/data limit, including node count and depth. The
host tracks a cloned copy of each id's device spec from its last acknowledged show,
with components expanded and anchors resolved. It applies ops to a copy and
runs the full validator before sending. Errors preserve deterministic paths.
The host validates state ops against the agent-declared state and leaves value
comparison for \`/state\` \`test\` to the device; its copy cannot know user edits.

Patches are FIFO per device, with one in flight at a time. A pending show makes
patch refuse as busy. Shows are not delayed by patches. If a dispatched show
and an acknowledged patch overlap, their device-side order is unknown: the host
forgets its spec, warns, and requires a further successful show before patching.
A failed dispatched show, dismissed event, successful dismiss, session release,
device removal or unbinding also ends tracking. Inspect retains each reported tracked id
and drops missing ids; adopted siblings do not end its tracking. A fifth-surface refusal
with \`replaceOthers: false\` also retains the acknowledged specs. A transport failure after
patch dispatch is indeterminate and requires a new show. An atomic device
refusal leaves the tracked copy unchanged. A successful patch refreshes shown
status data without changing \`lastResult\`, timestamps or event snapshots.
`;

export const GUIDE_CHECKS = `## Checks

Devices advertising \`prototype_checks_v1\` evaluate declarative checks locally. The host refuses
show and patch results using this feature on older devices. Inputs \`textField\`, \`slider\`,
\`checkbox\`, \`switch\`, \`radioGroup\`, \`datePicker\` and \`timePicker\` accept \`checks\` (1–8 entries)
and \`validateOn: "change" | "blur" | "submit"\` (omitted means blur). Each check contains a
nonempty \`message\` and exactly one rule. \`validateOn\` controls error display, never validity.
The first failing message is displayed.

- \`required: true\`: trimmed nonempty text, true for checkbox/switch, nonempty selection for
  radioGroup/datePicker, present number for slider/timePicker.
- \`minLength\` / \`maxLength\`: nonnegative integer UTF-16 lengths, textField only.
- \`min\` / \`max\`: finite numeric inclusive bounds, slider and pickers only. Text fields hold
  strings and have no numeric subtype. Date state remains YYYY-MM-DD; bounds are UTC epoch
  milliseconds. Time pickers retain hourKey/minuteKey; checks apply independently to both keys.
- \`format\`: textField only, one of email, phone, digits, decimal, url.
- \`pattern\`: textField only, the restricted grammar below, at most 128 UTF-16 units.

Empty string, null or missing value passes all rules except required. Whitespace is only empty
for required. Pattern and format matching use at most 4096 UTF-16 units. Required and length checks inspect the complete value.
Every validity reference must name declared state with at least one check. Multiple checked
controls sharing a key must all pass. Numeric/length lower bounds must not exceed upper bounds.

Formats use these exact whole-value expressions (ASCII digits):

- email: \`[^\\s@]+@[^\\s@]+\\.[^\\s@]+\` (Unicode names allowed).
- phone: optional leading +, then 7–15 characters from ASCII digits, space, hyphen and parentheses;
  at least seven digits. The leading + is outside the character count. Punctuation need not balance.
- digits: \`[0-9]+\`.
- decimal: \`-?[0-9]+(\\.[0-9]+)?\` (no exponent or leading +).
- url: \`https?://[^\\s/?#]+([/?#]\\S*)?\` (lowercase scheme, Unicode hosts allowed).

Format whitespace follows JavaScript whitespace (including NBSP); no format trims its value.
Patterns use ASCII \`\\d\`, \`\\w\`, \`\\s\` and their complements \`\\D\`, \`\\W\`, \`\\S\`; \`\\w\` is
\`[A-Za-z0-9_]\` and \`\\s\` is space, tab, CR, LF, FF, VT. Dot matches one Unicode scalar except
CR, LF, U+2028 and U+2029. Matching consumes the entire value, even with a final newline.
Allowed: literals, dot, classes \`[abc]\` / \`[^abc]\`, literal ranges, those six shorthand escapes,
escaped metacharacters, anchors ^ $, groups \`(…)\` / \`(?:…)\`, alternation |, and quantifiers
\`? * + {n} {n,} {n,m}\`. Every written bound is <=100 and n<=m; open upper bounds are unbounded.
Reject backreferences, lookahead/behind, named groups, lazy/possessive quantifiers, Unicode
properties, inline flags, word boundaries \`\\b\` / \`\\B\`, and every other escape (including
\`\\n\`, \`\\x\`, \`\\u\`; use literal characters). Empty classes are rejected. A group repeated more
than once cannot contain alternation or any variable quantifier (maximum > minimum), transitively.
At most two variable quantifiers are allowed in the entire pattern: ? * + {n,} and {n,m} when
m>n. Fixed {n} quantifiers inside repeated groups remain allowed.
Thus \`(a|b)+\`, \`(a+)+\`, \`(a*)*\` and \`((ab)+)+\` are rejected. Optional groups remain allowed.
These exact rules and error substrings are pinned in the language-neutral checks fixtures.

Conditions \`{valid: "email"}\` and \`{valid: ["email", "password"]}\` mean all referenced keys
are valid, including fields whose errors are not yet shown. They compose with all/any/not in
visibleWhen, styleWhen and enabledWhen. enabledWhen is supported on the seven input types plus
button, iconButton, fab, chip and listItem; false disables the control and skips its onTap.
\`emit\` may specify \`requireValid: ["email", "password"]\` (1–8 keys). Any failing key aborts the
whole action list atomically, shows errors on every listed field, and sends
\`{kind:"validation_failed", keys:[…]}\` naming only the failing keys. \`change\` events carry
\`validity: {key:boolean}\` for checked keys. Both event kinds retain the usual event envelope.
`;
