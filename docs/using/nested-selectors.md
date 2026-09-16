# Target repeated controls with nested containers

Use the existing tools' `container` argument to select strict descendants.
For example, `remove` inside `item_42` inside `cart_A` is different from the
identically named button in `cart_B`. Anonymous layout wrappers do not matter.
Use `selectionStrategy: "unique"` for intentional targeting.

## Discover, then act

These MCP arguments work on Android and iOS. First acquire a session with
`getAndroid` or `getApple` and supply its `sessionUuid` on each call. The Android
Playground exposes the fixture under Discover → Selectors; the iOS Playground
has a Selectors tab. Android resource IDs/Compose tags and iOS accessibility
identifiers use the same `elementId` slot.

Discover the intended row with `observe`:

```json
{
  "scope": {
    "focus": {
      "query": {
        "elementId": "item_42",
        "container": { "elementId": "cart_A" },
        "selectionStrategy": "unique"
      }
    }
  }
}
```

The default skeleton contains only that subtree. `raw: true` returns its full
hierarchy. In both forms, `observeScope.focus` preserves the query and the
outer-to-inner `levels`: selector, match count, selected index, and identity,
label, type and bounds where available. Scoping never changes the full
observation used internally for subsequent actions.

Use that ancestry with `tapOn`:

```json
{
  "selector": { "elementId": "remove" },
  "container": {
    "elementId": "item_42",
    "container": { "elementId": "cart_A" }
  },
  "selectionStrategy": "unique",
  "action": "tap"
}
```

`action: "longPress"`, `"doubleTap"` and `"focus"` resolve the same descendant.
Clickable parent/sibling retargeting stays inside the selected scope.

For text, `sendKeys` focuses the scoped field before executing commands:

```json
{
  "selector": { "elementId": "quantity" },
  "container": {
    "elementId": "item_42",
    "container": { "elementId": "cart_A" }
  },
  "selectionStrategy": "unique",
  "commands": [{ "action": "clear" }, { "action": "type", "text": "3" }]
}
```

The legacy `inputText` tool accepts the same `selector`, `container`,
`selectionStrategy` and `index` alongside `text`. Enable this normally disabled
tool with `enableTools: ["inputText"]` during acquisition if needed. Input retains
its existing insertion semantics; clear first to replace an existing value.
A scope without a target selector is rejected. Failed focus sends no text.

Each `dragAndDrop` endpoint has its own query:

```json
{
  "source": {
    "elementId": "item_42",
    "container": { "elementId": "cart_A" }
  },
  "target": { "elementId": "cart_B" },
  "selectionStrategy": "unique"
}
```

Both endpoints are resolved from the same capture before dispatch. `pinchOn`
accepts an equivalent recursive `container`. With `swipeOn`, `container`
identifies the scroll surface and `lookFor` searches only its descendants.
Any `lookFor.container` chain further narrows that scope. Automatic scroll
selection similarly searches inside the chosen scroll container.

## Matching and cardinality

- Every level has exactly one nonempty `elementId`, `text`, or `testTag`.
  `testTag` is Android-specific. Recursive queries are limited to 32 levels.
- Resource/accessibility IDs match exactly. A qualified Android ID can fall
  back to the bare Compose name only when no exact qualified match exists.
  IDs are never substring matches. Existing synthetic view-ID ambiguity guards
  still apply; prefer application-owned identifiers for changing rows.
- Text uses the same case-insensitive, quote-normalized matching at every level.
  Exact text matches take precedence over partial text matches.
- `unique` applies to every unindexed level. Two matching parents are an error
  even if only one contains the requested child.
- `index` is zero-based within that level's scoped candidate set, in capture
  traversal order. It overrides uniqueness only at that level. Unavailable
  occurrences fail; indexing never escapes to the global tree.
- Existing `first` and `random` defaults remain available. Action leaves retain
  the smallest visible match preference for `first`; indices retain traversal
  order. Observation candidates can be nonactionable; action candidates must
  have usable bounds and satisfy visibility/enabled/hittability checks.

A container need not be clickable, have bounds, or have its center on-screen.
Containment means hierarchy ancestry, not rectangle overlap. A scope cannot
match itself as its own descendant, and an ancestor chain cannot cross windows.
The existing device/window hierarchy determines the applicable search roots;
distinct matches in different roots remain ambiguous. Repeated references,
native identities within a scope, and supplementary iOS SDK mirror nodes do not
inflate cardinality. Scope cannot expose descendants missing from the native
automation hierarchy.

## Waits, refreshes and failures

The additive `waitFor.query` form supports `appear`, `clickable`, and `disappear`:

```json
{
  "waitFor": {
    "for": "disappear",
    "query": {
      "elementId": "remove",
      "container": {
        "elementId": "item_42",
        "container": { "elementId": "cart_A" }
      }
    },
    "timeoutMs": 2000
  }
}
```

Absence is satisfied only when each ancestor resolves uniquely (or by its
explicit index) and the leaf is absent there. A missing/ambiguous ancestor
continues waiting and eventually times out. To wait for the row itself to
disappear, query `item_42` inside `cart_A`. Legacy wait forms retain their
existing behavior; do not mix `query` with legacy selectors.

Every poll, scoped tap refresh/retry, and scroll iteration resolves the complete
chain again. Scoped gestures retain coordinates from the selected capture;
tap, drag and swipe pass its frame identity to supporting native runners, which
can reject stale input. A native rejection never retries through an unscoped
identifier or ADB fallback. Ordinary `tapOn` never scrolls implicitly.

Failures distinguish `container_not_found`, `container_ambiguous`,
`target_not_found`, `target_ambiguous`, `index_out_of_range`, and
`target_not_actionable`. Diagnostics include the outermost-zero-based failing
level, match count, and at most five candidates. Observe waits expose
`queryResult`; failed waits use MCP `isError`. Action errors carry the same
diagnostic through the existing failure envelope.

Scoped tap/focus and nested TalkBack scrolling require coordinate input; they
fail when screen-reader dispatch would replace scope with a global label/ID.
Semantic accessibility-link activation rejects nested or unique container queries
because its native owner lookup cannot preserve that ancestry.
VoiceOver scrolling retains its existing unsupported result. Scoped iOS pinch
requires a runner advertising `exact_center_pinch`; upgrade/rebuild the runner
when requested. It fails if coordinate synthesis is unavailable, before the
legacy fallback could pinch at the screen center.

## Platform verification

On 2026-09-15 the public registered MCP tools were exercised against the Android
Pixel_9 emulator and an iPhone 16 / iOS 26.5 simulator using the Playground
fixtures in this change. The server used an isolated database and real native
CtrlProxy/XCTest dispatch.

| Check                                                     | Android | iOS    |
| --------------------------------------------------------- | ------- | ------ |
| Scoped skeleton preserves `cart_A/item_42` ancestry       | Passed  | Passed |
| Scoped input and clear change only the requested quantity | Passed  | Passed |
| Scoped tap removes only `cart_A/item_42/remove`           | Passed  | Passed |
| Peer `cart_A/item_73` and `cart_B/item_42` stay unchanged | Passed  | Passed |
| Scoped absence resolves existing ancestors                | Passed  | Passed |

The shared conformance/property tests additionally cover nested noninteractive
ancestors, wrappers, overlapping peers, windows, indices, ambiguity, missing
nodes, refreshed scroll containers, and row recycling before dispatch.
