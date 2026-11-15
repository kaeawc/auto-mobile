# Prototype spec: lint, rejection and examples

Part of [the agent-authored prototype specification](prototype-ux.md).

## Placeholder lint (#15444)

A successful `show` or `patch` returns `placeholderFindings` when a repeat or state placeholder sits
in a field that does not bind it, so it would be drawn literally. It is advisory, host-only and
never refuses a show. Each finding names the field `path` (for example `root.children[0].label`),
the `placeholder` as authored and a `detail`. The output keeps 50 findings, and
`placeholderFindingsTotal` reports the full count when it is capped.

- A repeat placeholder (`{index}`, or `{alias.field}` for an enclosing `repeat.as`) in a text field
  that is not in the bindable set, such as `chip.label` or `badge.text`. Fields that bind
  (`button.label`, `topAppBar.title`, `searchBar.placeholder`, and `text` nodes) are not reported.
- A `{key}` state placeholder naming a declared `state` key in `chip.label`, `badge.text`,
  `textField.placeholder` or `searchBar.placeholder`. Only a `text` node reads `{key}` from state.
  Other fields are left alone because a renderer may bind them beyond the contract.

To show a bound value there, use a `text` node next to the field.

## Accessibility lint (#14126)

A successful `show` or `patch` returns `accessibilityFindings`: an advisory, host-only lint of the
component-expanded spec sent to the device. It never refuses a show and needs no device capability.
Each finding names a `rule`, the node `path` and a `detail`. The output keeps 50 findings, and
`accessibilityFindingsTotal` reports the full count when it is capped.

| Rule                              | Finds                                                                                                                                                                                                                                                                                                                                                                 |
| --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `unlabeled-control`               | A node with `onTap`, `onLongPress` or `onDoubleTap`, or an `iconButton`, `fab`, `switch`, `checkbox`, `slider` or `select`, with no `contentDescription`, `label`, `text`, `spans`, `headline` or `title` on itself or a descendant.                                                                                                                                  |
| `unlabeled-image`                 | An `image` or `icon` with a `testTag` but no `contentDescription`. An untagged, non-tappable one without a description is decorative: the renderers hide it from accessibility, so it is not reported.                                                                                                                                                                |
| `unlabeled-text-field`            | A `textField` or `searchBar` with no `label`, `placeholder` or `contentDescription`.                                                                                                                                                                                                                                                                                  |
| `low-contrast`                    | A `text` node with an authored `style.color` below WCAG AA against the nearest background the host can resolve: 4.5:1, or 3:1 for large text (`textSize` 24 or more, 18.66 or more at `fontWeight` 700, or a `display`/`headline` `textStyle`). It is checked in light and dark, or only the mode `theme.mode` pins; `mode` names the failing one, `value` the ratio. |
| `small-touch-target`              | A tappable node or control whose authored `width`, `height`, `maxWidth` or `maxHeight` is under 48dp (44pt on iOS); `value` is the smallest side. Sizes left to layout are not checked.                                                                                                                                                                               |
| `transition-without-visible-when` | A non-stack node with a `transition` but no `visibleWhen`: nothing ever enters or exits, so the transition never runs.                                                                                                                                                                                                                                                |

Colours resolve on the host as the renderers do: a hex value, a `{light, dark}` pair, or a role
from the Material 3 baseline scheme with `theme.colors` overrides (flat, then per mode). A
`theme.colors.seed` or `source: device` makes the device derive its own scheme, so only the roles
the spec overrides are known then, and text using any other role is not checked. The background
starts at the `surface` role and follows authored `style.background` values, compositing
translucent ones. Under a `gradient`, a `style.alpha`, or a component that paints its own surface
(`card`, `dialog`, `bottomSheet`, `snackbar`, `topAppBar`, `bottomNav`, `tabBar`, `button`, `fab`,
`chip`) the background is unknown and contrast is not checked. `styleWhen` overrides are not
evaluated.

### Pseudo-locale (#14126)

`show` takes `pseudoLocale: true`. The device receives a copy of the spec in which every `text`,
`label`, `placeholder`, `headline`, `title`, `supporting`, `supportingText`, `trailingText`, check `message` and span `text` is
accented, padded by about 40% and wrapped in `[ ]`, so truncation and clipping are visible without a
translation. `{key}`, `{data:/pointer}` and `{item.field}` bindings are left intact, as are
`contentDescription`, state, data, request bodies, `emit` context and payload, `repeat` and option `value`s. The authored
spec is what status, `patch` and the accessibility lint see, so `patch` ops (other than a
`replaceNode`) edit the device copy and a `replaceNode` sends authored text. A `linkify` text keeps its mention, hashtag and URL tokens as written and takes no `[ ]`
wrapper, so links stay detectable. Stack screen and component names are never treated as spec
fields. Each show states the
option afresh.

Every starter template passes this lint with zero findings, pinned by the template gallery test.
`test/fixtures/prototype-a11y/` holds one fixture per rule beside a clean spec.

### On-device audit and RTL (#14126)

The `wcag` engine of `accessibilityAudit` (`WcagAudit`) reads the accessibility tree the Compose renderer projects, so it
sees prototype nodes through that projection, not the spec:

- A text field's `label` is a child text node with no class, drawn inside the `EditText`. The audit
  counts a classless text node as a label candidate, so a labelled field is not reported.
- A tappable container with no children keeps its node kind as `content-desc` ("box"), and an icon
  button reads as its icon name. These are selector handles (see `prototypeContentDescription`), so
  `WcagAudit` cannot tell an authored label from the fallback: it reports neither a missing label
  on such a node nor a missing `contentDescription` on an icon button. The `unlabeled-control` lint
  is the check for them.
- An untagged or non-tappable `image` or `icon` is not interactive, so `WcagAudit` does not report a
  missing description; the `unlabeled-image` lint does.
- Compose enforces a 48dp minimum interactive size, so a tappable node authored smaller still
  measures 48dp on the device and `WcagAudit` reports no small target. Only `small-touch-target`
  sees the authored size.
- Low contrast and an unlabeled `EditText` are reported on device as in a native app.

Under `changeLocalization` with `textDirection: "rtl"` for the host app, an Android `row` of
weighted and unweighted children lays out right to left. On iOS the audit is the XCUITest
`accessibilityAudit`.

## Rejection paths and deterministic first error

Paths omit a leading `$` for ordinary root members: `root.children[1].style.color`.
Array indices use brackets. Non-identifier keys use JSON-quoted brackets, e.g.
`root["bad.key"]`; top-level equivalents start with `$["bad.key"]`. A whole
input, malformed JSON, or spec byte error uses `$`. Missing/unknown discriminator
errors end in `.type`. Paths identify the rejected input, before any defaults.

Both walkers use the same sequence:

1. Raw UTF-8 byte limit, then strict JSON parsing (syntax error at `$`).
2. Depth-first structural walk. At a node entry, check node count, node depth,
   then image-use count. Nav image uses are checked at item entry. Container depth is checked at
   container reference entry. At a tagged
   object, check its discriminator first.
3. At each object, visit the union of present and declared keys in ascending
   UTF-16 lexicographic order, independent of JSON insertion order. Unknown keys
   fail at their own path; missing required keys fail there too. Arrays visit
   increasing indices, with length checked first and uniqueness after each item.
   Selection binding exclusivity is checked after its fields, at `.pager` for
   both/neither. An empty selector fails at `.selector`. Container exclusivity fails at
   `.elementId` after its fields are checked.
4. After structure passes, find duplicate pager IDs in node preorder (second
   ID fails at `.id`); then resolve node pager references in preorder, then action
   pager references in encounter order. Finally check initialized text/nav state
   binding types in node preorder, then existing sheet state types in node
   preorder.
5. Decode typed models. Any schema/model disagreement is an internal contract
   failure at `$`, never successful partial content.

Only the rule table is shared; walkers and model decoders are independent. Neither implementation parses
Zod or kotlinx.serialization exception messages. Human error messages describe
the failure; exact path parity is the shared contract.

JSON supplied as an already-decoded TypeScript value is measured as compact
JSON, while string input measures original bytes. Only JSON-representable values
are accepted. Duplicate JSON object keys must be avoided by authors; standard
JSON decoders retain the last value. They are not unknown fields.

## Worked examples

### Full-screen variants with pager tabs

```json
{
  "id": "variants",
  "window": { "placement": { "type": "fullscreen", "scrim": "#80000000" }, "opacity": 80 },
  "state": { "query": "", "open": false },
  "root": {
    "type": "column",
    "safeAreaPadding": { "edges": ["top", "bottom"], "types": ["systemBars", "cutout", "ime"] },
    "children": [
      {
        "type": "tabBar",
        "pager": "pages",
        "items": [
          { "label": "Original", "icon": "home" },
          { "label": "Edited", "image": "variant-b" }
        ]
      },
      {
        "type": "pager",
        "id": "pages",
        "children": [
          {
            "type": "scroll",
            "axis": "vertical",
            "child": { "type": "text", "text": "Page {page} of {pageCount}" }
          },
          { "type": "image", "asset": "variant-b", "contentScale": "fit" }
        ]
      },
      { "type": "textField", "stateKey": "query", "placeholder": "Feedback" },
      {
        "type": "text",
        "text": "Next",
        "onTap": [{ "type": "setPage", "pager": "pages", "page": "next" }]
      },
      {
        "type": "bottomSheet",
        "openWhen": { "key": "open", "equals": true },
        "detents": ["half", "full"],
        "child": { "type": "text", "text": "Details" }
      }
    ]
  }
}
```

### Bottom window sheet with state navigation and horizontal scrolling

```json
{
  "id": "choices",
  "window": { "placement": { "type": "sheet", "edge": "bottom", "height": 240 } },
  "state": { "selected": 0 },
  "root": {
    "type": "column",
    "children": [
      {
        "type": "scroll",
        "axis": "horizontal",
        "child": {
          "type": "row",
          "children": [
            {
              "type": "text",
              "text": "Save",
              "onTap": [{ "type": "emit", "name": "save", "payload": { "variant": "A" } }]
            },
            { "type": "spacer", "style": { "width": { "dp": 16 } } },
            {
              "type": "icon",
              "name": "favorite",
              "onTap": [{ "type": "setState", "key": "selected", "value": 1 }]
            }
          ]
        }
      },
      {
        "type": "bottomNav",
        "stateKey": "selected",
        "safeAreaPadding": { "edges": ["bottom"], "types": ["systemBars"] },
        "items": [
          { "label": "Home", "icon": "home" },
          { "label": "Favorites", "icon": "favorite" }
        ]
      }
    ]
  }
}
```

### Floating anchored replacement

```json
{
  "id": "button-preview",
  "window": {
    "placement": { "type": "floating", "gravity": "topStart", "offset": { "x": 24, "y": 120 } },
    "opacity": 50
  },
  "root": {
    "type": "box",
    "anchor": { "type": "element", "selector": { "testTag": "buy" }, "alignment": "cover" },
    "style": { "background": "#2255CC", "cornerRadius": 12 },
    "children": [{ "type": "text", "text": "Buy now", "onTap": [{ "type": "dismiss" }] }]
  }
}
```

The committed `doc-example-3` fixture is this example verbatim. The renderer refuses an unresolved
element anchor, so the screenshot gallery substitutes a fixed resolved `bounds` anchor (same
alignment) before rendering; only the host resolves selectors.

## Shared fixtures

The TypeScript and Kotlin suites enumerate the same `test/fixtures/prototype-spec/valid` and `invalid`
files, assert nonempty directories and require coverage of every node, action and placement. Invalid files
wrap `{spec, expectedPath}`. The byte limit has no fixture: each suite generates its own input and checks
the exact byte boundary (whitespace included) and the emit payload boundary. Fixture and contract files are
pinned to LF for Windows; no binary assets are included. The worked examples above are committed as
`doc-example-N.json` fixtures and `test/parity/prototypeSpec.test.ts` asserts they match this page.

Reference concept slices live in `test/fixtures/prototype-concepts/<concept>/`: `today.json` (a
whole concept app written only with capabilities Android and iOS both advertise, with literal `data`
in place of a mock backend), `concept.json` (`{issue, name, capabilities}`, the gate capabilities the
three strict policies must derive) and a `README.md` listing every required capability and each
workaround or dead end with its spec path. The TypeScript, Kotlin and Swift suites load every concept
directory; TypeScript also requires a `testTag` on every interactive node, a spec `id` of
`<concept>-today` and zero static accessibility lint findings.
