# Prototype spec: nodes

Part of [the agent-authored prototype specification](prototype-ux.md).

## Nodes

| `type`            | Node-specific properties                                                                                                                                                                                                                               |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `box`             | Required `children` array, possibly empty; children stack. Optional `repeat` (see List templates below).                                                                                                                                               |
| `row`             | Required `children` array, possibly empty; horizontal layout. Optional `repeat` (see List templates below).                                                                                                                                            |
| `column`          | Required `children` array, possibly empty; vertical layout. Optional `repeat` (see List templates below).                                                                                                                                              |
| `text`            | Required `text` string, possibly empty.                                                                                                                                                                                                                |
| `image`           | Required opaque `asset` string; optional `contentScale`: `fit` (default), `crop`, `fill`.                                                                                                                                                              |
| `icon`            | Required built-in `name` below; optional `variant` (`filled`, `outlined`, `rounded`, `sharp`, `twoTone`).                                                                                                                                              |
| `spacer`          | No node-specific properties; size comes from style.                                                                                                                                                                                                    |
| `adaptive`        | Native-width panes and navigation; see Adaptive layouts.                                                                                                                                                                                               |
| `textField`       | Required `stateKey` naming an initialized string state value; optional `placeholder` string, default empty; `label`, `variant`, `supportingText`, `keyboardType`, `secure`, `multiline`, `minLines`, `maxLines`, `maxLength` (see Text field options). |
| `switch`          | Required `stateKey` naming an initialized boolean state value; optional nonempty `label`.                                                                                                                                                              |
| `checkbox`        | Required `stateKey` naming an initialized boolean state value; optional nonempty `label`.                                                                                                                                                              |
| `button`          | Required nonempty `label`; optional `variant`: `filled` (default), `tonal`, `elevated`, `outlined`, `text`; optional leading `icon` (built-in name). Taps run `onTap`.                                                                                 |
| `radioGroup`      | Required `stateKey` naming an initialized string state value; required `options`, 2 to 16 `{value, label}` entries with nonempty, unique `value`s.                                                                                                     |
| `listItem`        | Required nonempty `headline`; optional nonempty `supporting`, optional `leadingIcon` (built-in name), optional `trailing`: `{type: switch\|checkbox, stateKey}` bound to an initialized boolean, or `{type: icon, name}`. Taps run `onTap`.            |
| `slider`          | Required `stateKey` naming an initialized number within `min`..`max`; required finite `min` < `max`; optional `step`, optional nonempty `label`.                                                                                                       |
| `chip`            | Required nonempty `label`; optional `variant`: `assist`, `filter`, `input`, `suggestion`; optional `stateKey` naming a boolean (a filter chip only).                                                                                                   |
| `card`            | Required `children` array; optional `variant`: `filled` (default), `elevated`, `outlined`.                                                                                                                                                             |
| `iconButton`      | Required built-in `icon`; optional `variant`: `standard` (default), `filled`, `tonal`, `outlined`. Taps run `onTap`.                                                                                                                                   |
| `fab`             | Required built-in `icon`; optional nonempty `label` (an extended FAB); optional `size`: `small`, `regular` (default), `large`, only without a `label`. Taps run `onTap`.                                                                               |
| `segmentedButton` | Required `stateKey` naming an initialized string state value; required `options`, 2 to 5 `{value, label}` entries with nonempty, unique `value`s. Single select.                                                                                       |
| `topAppBar`       | Required nonempty `title`; optional `variant`: `small` (default), `centerAligned`, `medium`, `large`; optional `navigationIcon` and 1 to 3 `actions`, each `{icon, label, onTap?}`.                                                                    |
| `divider`         | Optional `orientation`: `horizontal` (default), `vertical`.                                                                                                                                                                                            |
| `badge`           | Optional nonempty `text` (a count or short label); without it a small dot.                                                                                                                                                                             |
| `progress`        | Optional `variant`: `linear` (default), `circular`; optional `stateKey` naming an initialized number within 0..`max` (determinate); optional `max` > 0, default 1, only with `stateKey`. Unbound is indeterminate.                                     |
| `chart`           | Required `variant` (`line`, `area`, `bar`, `ring`) and 1 to 4 `series` `{path, x?, y, label, color?}` over a `/data` array; optional `yRange`, `xLabels`, `goal`. See Charts.                                                                          |
| `dialog`          | Required `openWhen` and `confirm`; optional nonempty `title` and `text`, optional `icon`, optional `dismiss`, optional single `child`. Buttons are `{label, onTap?}`.                                                                                  |
| `snackbar`        | Required `openWhen` and nonempty `text`; optional `action` button `{label, onTap?}` and `durationMs` (1 to 600000, self-closing).                                                                                                                      |
| `timePicker`      | Required distinct `hourKey` and `minuteKey` naming initialized integers 0..23 and 0..59; optional `is24Hour` boolean, default the device setting.                                                                                                      |
| `datePicker`      | Required `stateKey` naming an initialized `YYYY-MM-DD` string, a real date in years 1900..2100.                                                                                                                                                        |
| `scroll`          | Required single `child`; optional `axis`: `vertical` (default), `horizontal`. Free scrolling, with no page snapping.                                                                                                                                   |
| `pager`           | Required `id` and nonempty `children` array. Each child is one page; defaults to horizontal, full-size paging. Optional `axis`, `pageSpacing`, `peek`, `pageSize` (see Pager options below).                                                           |
| `tabBar`          | Required `items`; exactly one `pager` or `stateKey`; optional `scrollable` boolean, default false.                                                                                                                                                     |
| `bottomNav`       | Required 2–5 `items`; exactly one `pager` or `stateKey`. Author positions it, typically last in a column.                                                                                                                                              |
| `bottomSheet`     | Required single `child`, `openWhen`, and `detents`; optional `scrim`, `dragHandle`, `dismissOnSwipe`.                                                                                                                                                  |

### Adaptive layouts

`adaptive` requires `prototype_adaptive_v1` and a closed `kind`. The `listDetail` kind takes `list` and `detail` node slots plus a declared string `selectionKey`; empty string means no selection. The `navigationSuite` kind takes 1–8 unique `{value,label}` items, a declared string `stateKey` naming an item, and `content`. `supporting` takes `main`, `supporting`, and a declared boolean `openKey`. Slots are ordinary node subtrees.

Material adaptive scaffolds use native window classes: two panes at expanded, one below; navigation uses bar/rail/drawer at compact/medium/expanded. Compact list selection shows detail; Back clears the key. There is no shared breakpoint or `minWidth`. iOS uses compact/regular, and successful shows report the difference in `platformNotes`.

Each nav item is `{label, icon?, image?}`. Label is nonempty; icon uses the same
closed list as icon nodes; image is an opaque asset ID. Both icon and image may
be supplied; the image takes visual precedence, with icon as fallback. This
counts as one image use, regardless of whether the icon fallback renders.

Pager binding (`pager: "variants"`) follows and sets that pager's local selected
page. `stateKey: "selected"` follows and sets an initialized nonnegative integer
state value. The selected value is clamped to the available item/page range by
the future renderer. Nav item count need not equal pager page count; authors
should match them when each item represents a page. Per-pager selection starts
at zero without a binding and is changed by `setPage`.

Optional `pager.stateKey` binds a declared nonnegative integer number key in both directions
(`prototype_pager_state_key_v1`). The host refuses older renderers before sending the show.
Initial and replacing-show state is authoritative; unbound pagers preserve their previous page
on same-id replacement. Settled swipes write the key and emit `page_changed` plus `change`
in one interaction. State actions and `/state/<key>` patches move the pager; integer values
clamp to the page range, with animation unless `motion: "none"`. Settling the same page is
silent. `setPage` and pager-bound navigation write the same key. A nav bar may use the same
`stateKey` (the simplest wiring). Two pagers cannot share a key, and bindings inside repeat
templates are refused at the pager's `stateKey`.

An authored indicator can live outside the pager:

```json
{
  "id": "pager-state-key",
  "window": {
    "placement": {
      "type": "fullscreen"
    }
  },
  "state": {
    "page": 0
  },
  "root": {
    "type": "column",
    "children": [
      {
        "type": "row",
        "children": [
          {
            "type": "box",
            "style": {
              "width": {
                "dp": 8
              },
              "height": {
                "dp": 8
              },
              "background": "#888888"
            },
            "styleWhen": [
              {
                "when": {
                  "key": "page",
                  "equals": 0
                },
                "style": {
                  "background": "#0066FF"
                }
              }
            ],
            "children": []
          },
          {
            "type": "box",
            "style": {
              "width": {
                "dp": 8
              },
              "height": {
                "dp": 8
              },
              "background": "#888888"
            },
            "styleWhen": [
              {
                "when": {
                  "key": "page",
                  "equals": 1
                },
                "style": {
                  "background": "#0066FF"
                }
              }
            ],
            "children": []
          }
        ]
      },
      {
        "type": "pager",
        "id": "deck",
        "stateKey": "page",
        "children": [
          {
            "type": "text",
            "text": "First"
          },
          {
            "type": "text",
            "text": "Second"
          }
        ]
      },
      {
        "type": "button",
        "label": "Next",
        "onTap": [
          {
            "type": "increment",
            "key": "page"
          }
        ]
      },
      {
        "type": "tabBar",
        "stateKey": "page",
        "items": [
          {
            "label": "First"
          },
          {
            "label": "Second"
          }
        ]
      }
    ]
  }
}
```

When a pager settles on another page the device sends one `page_changed` event whose
`name` is the pager id and whose `payload` is the new zero-based page index. This is the same
shape as the iOS agent (#11409). The event `pages` map still carries every pager.

`bottomSheet.openWhen` is `{key, equals}` with a **boolean** equals value. Its
state key may be absent (sheet closed); an existing value must be boolean. A
swipe dismissal with `dismissOnSwipe: true` writes `!equals` to that key, making
the condition false. Defaults: `dragHandle: true`, `dismissOnSwipe: true`. Setting
both false is permitted; the host escape remains outside author control (the
dismiss bar, or a two-finger long press on a device advertising
`prototype_window_chrome_v1`, #12064). Detents are unique values: positive `{dp: n}`,
`"half"`, or `"full"`. They preserve author order. Half/full refer to the prototype
window's height. Sheet node scrim applies inside that window, not beyond a
floating or sheet window's bounds. A modal sheet intercepts touches inside the
window while open; a sheet placement is only a window placement.

Component behavior (Material 3). Each component is one accessibility node with a native role and its label
as text, reserves a 48 dp minimum touch target, and is reached by `observe` / `tapOn` through `testTag` or
label.

- **Bound controls emit `change`.** `switch`, `checkbox`, `radioGroup`, `segmentedButton`, filter `chip`,
  `slider`, `textField`, pickers and `stateKey` selection write the bound key and emit `change` only when the value moved. The payload is `{key, value}`, or
  `{keys, values}` for several. They then run the node's own `onTap`. A `setState`
  that would make a bound value the wrong type is rejected like any binding type change.
- `button` runs `onTap`; without one it is drawn but inert. `tonal` and `elevated` are filled-tonal and
  elevated; a leading `icon` draws before the label.
- `switch` / `checkbox`: a tap anywhere, label included, flips the boolean; roles `Switch` / `Checkbox` with
  checked state.
- `slider`: the bound number must already lie within `min`..`max`; `step`, if given, must be positive and
  divide `max - min` evenly (the thumb snaps, else continuous). Dragging or an accessibility set-progress
  stores the snapped value. Reports a progress range (current, `min`..`max`, steps).
- `chip`: with `stateKey` a filter chip (toggles the boolean, `Checkbox` role); without, an assist chip
  (`Button`, runs `onTap`). `variant: filter` requires `stateKey`; `assist`, `input` and `suggestion`
  forbid it (`input` / `suggestion` only run `onTap`).
- `card`: Material container whose `children` lay out as a column; `variant` filled/elevated/outlined;
  `style.background` overrides the colour; `onTap` makes the whole card clickable; no accessibility label
  of its own.
- `radioGroup`: one radio row per option; a tap sets the string to the option `value`. A value matching no
  option leaves all unselected. Each row is a `RadioButton` node, tagged `<testTag>.<value>` when the group
  has a `testTag`.
- `segmentedButton`: like a radio group, each segment selectable and tagged `<testTag>.<value>`; single
  select only (use filter chips for multi).
- `listItem`: one node whose text is headline plus supporting line. A trailing switch/checkbox makes the row
  toggleable (`Switch` / `Checkbox` role; a tap anywhere flips the boolean, emits `change`, then runs
  `onTap`); otherwise a row with `onTap` is a `Button`, without is inert. A trailing `icon` is decorative.
- `iconButton`, `fab`: `Button` nodes running `onTap`, labelled by `contentDescription`, else an extended
  FAB's `label`, else the icon name.
- `topAppBar`: title text resolves state placeholders; navigation icon and actions are icon `Button`s
  labelled by `label`, tagged `<testTag>.navigation` and `<testTag>.actions.<index>`, each running its own
  `onTap`. It draws no system-bar inset; add `safeAreaPadding`.
- `divider` has no node unless tagged. `badge` reads as its `text`. `progress`: bound is determinate
  (`value / max` as a range over 0..1), unbound is indeterminate.
- `dialog` and `snackbar` open while `openWhen` holds (an existing key must be boolean) and draw above the
  whole author tree inside the prototype window, never as a separate window. A dialog is modal: a scrim tap
  or either button closes it; while open the page behind is removed from the accessibility tree
  (`clearAndSetSemantics`), so `observe` sees only the dialog. Closing writes `!equals` to the key and emits
  `change`, then a button runs its `onTap`. Title is its text, `text` a separate text node, `child` sits
  between text and buttons; buttons are tagged `<testTag>.confirm` / `<testTag>.dismiss`. A snackbar sits at
  the window bottom and is not modal (the page stays in the tree). It stays until closed unless
  `durationMs` (1..600000, wall-clock, not scaled by the animator) closes it by writing `!equals`. Its
  `action` (`<testTag>.action`) closes it, then runs `onTap`. Title, text and snackbar text resolve state
  placeholders.
- `timePicker`: Material dial bound to two integer keys; a change stores both and emits one `change`
  (`{keys, values}`, or `{key, value}` if one moved). `datePicker`: Material calendar bound to a
  `YYYY-MM-DD` string. Both report their value as accessibility state (`07:30` in 24-hour form,
  `2026-10-08`) and move when a re-show or `setState` rebinds. Both reject a `setState` that would put an
  out-of-range hour, minute or date in a bound key.

Text interpolation is a renderer concern: `{page}`, `{pageCount}`, and state
keys may appear in text. No expressions or interpolation parsing occurs during
validation. Pager context is the nearest enclosing pager; outside a pager those
two reserved placeholders remain literal. State keys `page` and `pageCount` are
permitted but the pager placeholders take precedence within a pager.

A number renders the same in a `{key}` placeholder and in a `repeat` binding (#11408),
and as the TypeScript host renders it (`renderScalar`):

- An integral number prints every digit with no decimal point and no exponent at any
  magnitude (`12345678`, `1000000000000000000000`), and negative zero prints `0`.
- Any other number prints as JavaScript's `String(number)`: the shortest decimal digits
  that read back as the same double, in plain notation down to `0.000001`
  (`0.30000000000000004`, `0.00001`) and as `<digits>e-<exponent>` below that (`1e-7`,
  `2.5e-7`). Android computes the digits itself, so the result does not depend on the
  device's `Double.toString`.

Known divergence: the iOS agent formats a non-integral number with Swift's own
description, which switches to an exponent earlier and pads it (`0.00001` shows as
`1e-05`). Integral numbers agree on all three. Prefer integral state for numbers a
prototype shows, or keep display text in a string key.

## Text field options

`textField` binds an initialized string state key. Optional `label` is a nonempty floating
label. The `variant` field is `filled` (default) or `outlined`. A nonempty `supportingText` appears below
the field. The `keyboardType` field is `text` (default), `number`, `decimal`, `email`, `phone`, `url`,
or `password`. The `secure` flag masks text; `multiline` enables multiple lines. Both `minLines` and
`maxLines` are integers in 1..20, permitted only with `multiline: true`; `minLines` cannot
exceed `maxLines`. Multiline text cannot use `secure: true` or `keyboardType: "password"`.
The `maxLength` field is an integer in 1..10000 and shows a character counter; the initial bound
value cannot exceed it (UTF-16 length).

All these options require `prototype_text_field_options_v1`. A device without the capability
is refused before uploads or show; nothing is shown. Update CtrlProxy, or relaunch the iOS
app with `launchApp prototype: true`, or drop the textField options.

`textField.errorWhen` accepts any condition form and immediately forces error styling when true, independently of `checks` and `validateOn`. Optional `errorText` requires `errorWhen` and is nonempty, at most 256 UTF-16 units. The caption is `errorText`, else the currently shown check message, else `supportingText`; with no caption the error styling still appears. Both fields require `prototype_string_conditions_v1`. Forced errors do not change validity in change events, `{valid}` or `requireValid`; those remain checks-only. A field without checks does not track blur validation.

A `textField` may also declare three optional fields:

- `trailingIcon: {icon, label, onTap?}`: a built-in icon, its
  nonempty accessible `label` and optional 1-32 `onTap` actions. An example is a clear button that
  `setState`s the field's key to an empty string. Without `onTap` it is decoration.
- `imeAction` (`done`, `next`, `search`, `send` or `go`): the keyboard's action key.
- `onSubmit`: 1-32 actions that run when the user presses that key. Without `imeAction` the key is
  `done`.

Multiline text has no IME action, so validation refuses `imeAction` and `onSubmit` with
`multiline: true`. These need `prototype_text_field_actions_v1`, with the same refusal.

Android draws `trailingIcon` as an `IconButton` in the field's trailing slot. Its `label` is the content description and its tag is
`<testTag>.trailingIcon`. Android maps `imeAction` to Compose
`ImeAction` with `KeyboardActions`; `next` also moves focus. iOS maps `imeAction` to `submitLabel`
and `onSubmit`, and draws the trailing icon as an SF Symbol button inside the field.

`leadingIcon` is a built-in icon name drawn in the field's leading slot (decoration, no actions; an
SF Symbol on iOS), gated by `prototype_text_field_leading_icon_v1`.

A `secure` field's value is not redacted: it lives in state, `change` events and `inspect`.
