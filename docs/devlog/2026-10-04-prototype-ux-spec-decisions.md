# Prototype spec shape and host-escape decisions

- Kind: decision
- Date: 2026-10-04
- Source: moved from `how-it-works/plat/android/prototype-ux.md`; #9296, #9295, #9300, #9307,
  #9316, #9535, #10261, #10262, #10488, #10489, #10941, #10954, #12064, #12071, #12200, #12522,
  #15053, #15444, #15491, #15515, #17718
- Shaped: [Agent-authored prototype specification](../how-it-works/plat/android/prototype-ux.md)

## Context

The prototype issue (#9296, child of #9295) proposed a spec vocabulary. The owner fixed its shape on
2026-10-04 and later decisions adjusted the host escape, foreground scoping, the keyboard and several
smaller contract points. Each is recorded here; the current contract is the shaped page.

## Options

- Anchors: #9316 specified semantics but not field names. First or random selection was possible
  but contradicted its ambiguous-anchor rejection.
- Dismiss control: #9307 proposed a non-removable dismiss control as the default.
- Focus: an older proposal made every prototype window focusable.
- Saved prototype activity: exporting it with a signature permission (an unnecessary external entry
  point) or with an intent filter alone (any app could enumerate and launch saved entries).
- Tool schema size: per-action tools instead of one `prototype` tool.
- Variants: a `showVariants` carousel with an on-device pick.
- Effects budget freeze: a new `prototype_event` kind to push it.

## Decision

2026-10-04 decisions, superseding the issue's earlier proposals:

- Envelope `{ id, window, data?, state?, root }` with no `specVersion`; an older or newer shape is
  rejected rather than migrated.
- Every object is strict: unknown properties, unknown node/action types, explicit null for optional
  fields and wrong types reject the entire spec with a path.
- Scroll supports both axes. Pager defaults to horizontal full-page paging; #12071 later added
  `axis`, `pageSpacing`, `peek` and `pageSize` behind `prototype_pager_options_v1`. Indicator and
  carousel were deferred at the time.
- Navigation includes `tabBar` and author-positioned `bottomNav`, bound to a pager or a number state
  key.
- Windows are edge-to-edge; safe-area padding is an explicit node opt-in.
- A `sheet` window and a modal `bottomSheet` node are separate concepts.
- Built-in icons come from a closed list (the bundled Material icon set); other artwork uses image
  assets.

Earlier decisions that still apply: the renderer is Compose; sizes and positions use dp; prototype
opacity is a percentage; app-element anchoring is supported; observe includes prototype nodes by
default; existing tap/text tools target prototype nodes; screenshots come from observe, with no
separate screenshot tool. Focus management belongs to the window host: accessibility set-text does
not require focus, human keyboard input does (the device findings in #9300 superseded the blanket
focusability proposal).

Later decisions:

- Anchors use chosen strict `bounds` and `element` shapes and accept only `selectionStrategy:
  "unique"`.
- Both validators visit object keys in ascending UTF-16 order, which avoids dependence on property
  insertion order or library union error ordering. The shared rule table reduces vocabulary
  duplication while walkers and model decoders stay independent.
- 2026-10-09 (#10261): a session prototype is tied to the app it was shown over and hides while that
  app is not in front.
- 2026-10-09 (#10262): a bottom sheet moves above the keyboard whenever it is shown and returns to
  the screen edge when it hides.
- #12064 reversed the #9307 default: chromeless fullscreen is the default and the bar is opt-in.
- #12522: the storage precedence rules were an adopted decision (the issue's proposal became the
  decision).
- The saved prototype activity is `exported=false` with no intent filter.
- The `showVariants` helper and its on-device pick were removed (#10489, #10488); alternatives are
  shown one at a time or as pager pages.
- Per-action tools were not adopted: `show`, `save`, `share` and `screenMap` take the whole spec and
  `patch` `replaceNode` takes any node, so each would carry the same node schema (#17718).
- Effects frozen by the frame budget get no new `prototype_event` kind, since that closed list is a
  contract change shared with the TypeScript host and iOS; the freeze shows on the next `inspect`.
- Whether to widen placeholder binding to `chip.label`, `badge.text`, `textField.placeholder` and
  `searchBar.placeholder` is a separate contract decision (#15444); `placeholderFindings` reports
  them meanwhile.

## Consequences

The validators, the shared contract and the native renderers implement these rules. Changing any of
them is a contract change across TypeScript, Kotlin and Swift.
