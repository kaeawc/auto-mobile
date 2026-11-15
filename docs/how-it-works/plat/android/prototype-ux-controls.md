# Prototype spec: rich text, menus, overlays and checks

Part of [the agent-authored prototype specification](prototype-ux.md).

## Rich text

A text node has exactly one of `text` or `spans`; plain `text: ""` remains valid.
Spans are strict `{text, style?, onTap?}` objects with nonempty, untrimmed text; whitespace is valid.
Span style accepts only color, fontWeight, fontStyle, textDecoration, textSize, letterSpacing,
fontFamily and background, with the same ranges as node style; background is a colour, never a gradient.
There are no span ids, testTags, visibility conditions, nested spans or URLs.
Each span uses the same state `{key}`, data `{data:/pointer}`, repeat `{item.field}` / `{index}`
and component `{props.x}` binding as node text; span actions bind like node onTap actions.
The resolved texts concatenate in order without separators: observe and accessibility show the
full plain text (an explicit node contentDescription still overrides its accessible label).
Spans do not count as nodes and require `prototype_rich_text_v1`; older devices are refused before show.
A tappable span is part of the text node, not a separate accessibility node, and runs actions without opening URLs.
On Android, activate it with `tapOn {accessibilityLink:"<span text>"}` or
`tapOn {text:"<full plain text>", subtext:{text:"<span text>"}}` without `layer`:
these selectors act across windows because `tapOn` refuses layer with accessibilityLink/subtext (#9305).
Use `tapAt` on the span bounds as the fallback.
On iOS, links are drawn as links and tap-through is by `tapAt` only; show reports the
`rich-text-links` platform note for tappable spans because there are no separate accessibility elements or semantic links.

### Linkify (#14233)

`linkify: {kinds, style?, onTap}` on a text node with `text` (not `spans`) turns @mentions,
#hashtags and URLs in the resolved text into links, for content from data such as `{item.body}`.
`kinds` lists 1 to 3 of `mention`, `hashtag` and `url`; `style` takes the span style fields; a tap on
a match runs `onTap` (1 to 32 actions). The grammar is fixed and shared by every runtime
(`test/fixtures/prototype-spec/linkify/cases.json`): a match starts at the start of the text or
after whitespace; a mention is `@` and 1 to 30 of `[A-Za-z0-9_]` (so `ana@example.com` is not one);
a hashtag is `#` and up to 100 letters, marks, digits or `_`, not all digits; a URL is `http://` or
`https://` up to the next whitespace with trailing `.,;:!?'")]}` removed. Inside `onTap` only,
`{match: "text"}` reads the tapped match (`@ana`) and `{match: "kind"}` its kind: as a `setState`
value, a `setData` / `appendData` value or an emit context entry, for example
`setState profileHandle {match: "text"}` then `push profile`. `{match}` anywhere else is refused.
Inside a repeat, `onTap` also binds `{item: "field"}`, `{index: true}`, `{alias.field}` and `{index}`
per row, including state keys such as `liked_{item.id}`. Repeat binding preserves `{match}` for
tap-time resolution; emit payloads and `{value: ...}` literals remain opaque. A URL tap never opens a browser; that is the `links.open`
platform call. Matches are links like tappable spans (Android `tapOn {accessibilityLink}`, iOS
`tapAt`) and require `prototype_linkify_v1`.

The shared contract caps spans at 64 per text node.

## Menu and select

`menu` and `select` require `prototype_menus_v1`; the host refuses them before showing or uploading assets when the connected renderer lacks it.

A `menu` requires `openWhen: {key, equals}` with a boolean equality and 1–16 strict `items`. Each item is `{label, icon?, trailingText?, enabled?, onTap?}` or exactly `{type:"divider"}`. Labels and trailing text are nonempty, icons use the existing icon names, and `onTap` has 1–32 existing actions. A disabled item is dimmed, cannot be tapped and does not close the menu. Dividers are neither focusable nor tappable. The elevated surface aligns to its parent’s bottom end. When it cannot fit below and fits above, it opens above the parent; otherwise it keeps its below placement clamped inside the window. Horizontal alignment is unchanged. An enabled item or outside tap writes `!equals` to the open key; item actions run after closing.

While a menu is open, the page behind it is removed from the accessibility tree, like a dialog; the menu items and outside-dismiss layer remain exposed. Closing restores the page. An expanded select leaves the page in the accessibility tree.

A `select` requires a string `stateKey` and 2–32 `{value,label}` options with unique nonempty values and nonempty labels; its optional label is nonempty. It shows the current option’s label, or empty text when no option matches, and a trailing expand indicator. Expansion is local view state. Choosing an option writes the string key, emits the same `change` payload as `radioGroup`, and collapses the list. Tapping the field again or outside also collapses it. Both nodes support repeat templates and reusable `use` components: state keys, menu item labels/trailing text/actions and select labels/option labels bind placeholders.

Rendering stays inside the prototype window on both platforms so `observe` and `tapOn` reach the normal hierarchy. Android uses an in-window surface rather than a separate DropdownMenu/Popup window. iOS uses an in-window list rather than system SwiftUI Menu/Picker popups; successful iOS shows report this substitution in `platformNotes`. Menu icons use the existing SF Symbols mapping on iOS.

The select field and menu surface carry the node `testTag`. Select option rows use `<testTag>.<value>`; menu item rows use `<testTag>.<index>`, with zero-based positions including dividers. Android adds row tags only when `testTag` is set; iOS falls back to `(testTag ?? id).<value>` or `(testTag ?? id).<index>`.

## Tooltip and drawer

`tooltip` requires `prototype_tooltip_v1`, nonblank `text`, boolean `openWhen: {key, equals}`,
and exactly one of `anchorTo` or `anchor`. `anchorTo` names exactly one node id after component
and repeat expansion; self references and absent targets report `Unknown anchorTo id`, and
multiple instances report `Duplicate anchorTo id`, at the tooltip's `.anchorTo` path. Bounds
anchors use the host-resolved screen rectangle plus offset. Tooltips are hoisted overlays, not
ordinary anchored layout children. An unlaid-out target draws no bubble or scrim and keeps state.

The pure `placePrototypeBubble` function places tooltips inside the window with an 8 dp gap and
margin. `caret` names the bubble edge pointing at the target: `top` places it below, `bottom`
above, and `start`/`end` mirror with layout direction. `auto` prefers below. An unavailable side
flips to its opposite; auto can use horizontal space when neither vertical side fits. If neither
side fits, the larger available side wins and the origin is clamped. The caret tracks the target
center, clamped away from the bubble corners. Menu placement shares this calculation.

Optional `spotlight` draws the themed scrim at 40% with an even-odd rounded cutout around the
target: `padding` defaults to 8 dp and `cornerRadius` to 12 dp, both integers from 0 through 64.
The bubble exposes text and the node test tag to accessibility; the scrim uses `<testTag>.close`.
With a spotlight the page semantics are cleared, focus moves to the bubble and returns to the
`anchorTo` target on dismissal. Without a spotlight the page stays interactive and exposed.
Scrim taps and bubble taps without `onTap` write `!equals`, then run optional `onDismiss` actions.
A bubble with `onTap` runs only those actions, allowing state-driven tours.

`drawer` requires `prototype_drawer_v1`, `edge: start|end`, boolean `openWhen`, and one `child`.
The logical edge mirrors in RTL. Its surface fills the safe-area height and is
`min(320dp, window width - 56dp)` wide. Optional `scrim` uses the themed color-value rules;
omission uses the scrim role at 40%. The scrim's `<testTag>.close` tap writes `!equals`.
`dismissOnSwipe` defaults to true: dragging toward the panel's edge beyond half its width
uses the bottom-sheet settle rule to dismiss. Opening is state-driven only.

Drawers clear the page's accessibility semantics, move focus into the panel, restore the page's
previous focus on close, and take Back/Escape before stack navigation or window dismissal.
The last open panel remains composed through exit, including removal from the author tree.
Panel motion is a 300 ms edge slide with a fading scrim; `motion: none` or animator scale zero
settles instantly. `LocalPrototypeReducedMotion` replaces the slide with a cross-fade. Drawer
transitions report through `ReportPrototypeMotion` until settled; the renderer does not supply
the reduced-motion preference itself.

## Checks

`textField.errorWhen` controls presentation only; validity and emitted validation results remain checks-only.

Devices advertising `prototype_checks_v1` evaluate declarative checks locally. The host refuses
show and patch results using this feature on older devices. Inputs `textField`, `slider`,
`checkbox`, `switch`, `radioGroup`, `datePicker` and `timePicker` accept `checks` (1–8 entries)
and `validateOn: "change" | "blur" | "submit"` (omitted means blur). Each check contains a
nonempty `message` and exactly one rule. `validateOn` controls error display, never validity.
The first failing message is displayed.

- `required: true`: trimmed nonempty text, true for checkbox/switch, nonempty selection for
  radioGroup/datePicker, present number for slider/timePicker.
- `minLength` / `maxLength`: nonnegative integer UTF-16 lengths, textField only.
- `min` / `max`: finite numeric inclusive bounds, slider and pickers only. Text fields hold
  strings and have no numeric subtype. Date state remains YYYY-MM-DD; bounds are UTC epoch
  milliseconds. Time pickers retain hourKey/minuteKey; checks apply independently to both keys.
- `format`: textField only, one of email, phone, digits, decimal, url.
- `pattern`: textField only, the restricted grammar below, at most 128 UTF-16 units.

Empty string, null or missing value passes all rules except required. Whitespace is only empty
for required. Pattern and format matching use at most 4096 UTF-16 units. Required and length checks inspect the complete value.
Every validity reference must name declared state with at least one check. Multiple checked
controls sharing a key must all pass. Numeric/length lower bounds must not exceed upper bounds.

Formats use these exact whole-value expressions (ASCII digits):

- email: `[^\s@]+@[^\s@]+\.[^\s@]+` (Unicode names allowed).
- phone: optional leading +, then 7–15 characters from ASCII digits, space, hyphen and parentheses;
  at least seven digits. The leading + is outside the character count. Punctuation need not balance.
- digits: `[0-9]+`.
- decimal: `-?[0-9]+(\.[0-9]+)?` (no exponent or leading +).
- url: `https?://[^\s/?#]+([/?#]\S*)?` (lowercase scheme, Unicode hosts allowed).

Format whitespace follows JavaScript whitespace (including NBSP); no format trims its value.
Patterns use ASCII `\d`, `\w`, `\s` and their complements `\D`, `\W`, `\S`; `\w` is
`[A-Za-z0-9_]` and `\s` is space, tab, CR, LF, FF, VT. Dot matches one Unicode scalar except
CR, LF, U+2028 and U+2029. Matching consumes the entire value, even with a final newline.
Allowed: literals, dot, classes `[abc]` / `[^abc]`, literal ranges, those six shorthand escapes,
escaped metacharacters, anchors ^ $, groups `(…)` / `(?:…)`, alternation |, and quantifiers
`? * + {n} {n,} {n,m}`. Every written bound is <=100 and n<=m; open upper bounds are unbounded.
Reject backreferences, lookahead/behind, named groups, lazy/possessive quantifiers, Unicode
properties, inline flags, word boundaries `\b` / `\B`, and every other escape (including
`\n`, `\x`, `\u`; use literal characters). Empty classes are rejected. A group repeated more
than once cannot contain alternation or any variable quantifier (maximum > minimum), transitively.
At most two variable quantifiers are allowed in the entire pattern: ? * + {n,} and {n,m} when
m>n. Fixed {n} quantifiers inside repeated groups remain allowed.
Thus `(a|b)+`, `(a+)+`, `(a*)*` and `((ab)+)+` are rejected. Optional groups remain allowed.
These exact rules and error substrings are pinned in the language-neutral checks fixtures.

Conditions `{valid: "email"}` and `{valid: ["email", "password"]}` mean all referenced keys
are valid, including fields whose errors are not yet shown. They compose with all/any/not in
visibleWhen, styleWhen and enabledWhen. enabledWhen is supported on the seven input types plus
button, iconButton, fab, chip and listItem; false disables the control and skips its onTap.
`emit` may specify `requireValid: ["email", "password"]` (1–8 keys). Any failing key aborts the
whole action list atomically, shows errors on every listed field, and sends
`{kind:"validation_failed", keys:[…]}` naming only the failing keys. `change` events carry
`validity: {key:boolean}` for checked keys. Both event kinds retain the usual event envelope.
