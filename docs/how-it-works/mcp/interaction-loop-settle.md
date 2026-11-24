# Settle comparison

The [settle gate](interaction-loop.md) and an `observe` `stable` wait compare consecutive reads
with the same diff. This page covers what that comparison leaves out and how an unsettled result
names what kept changing.

## Android status bar

The comparison leaves out the SystemUI status bar, because its clock, battery and signal rows
change on their own. Two rules apply:

- A known status-bar root (`status_bar_container`, `status_bar`,
  `status_bar_launch_animation_container`) is left out with its whole subtree.
- A status-bar-shaped id found anywhere else is left out with its subtree only when nothing in
  that subtree is clickable, long-clickable, checkable or scrollable. Such ids are the shared
  status-bar allowlist (`clock`, `battery*`, `wifi_*`, `statusIcons`, …) and the cell-signal rows
  (`mobile_*`, `signal_cluster*`).

The second rule keeps SystemUI rows that reuse those ids but take input. An example is a toggle
row in the Internet dialog: its `checked` change keeps the screen unsettled and shows in the
action diff. The patterns live in `src/utils/androidStatusBar.ts`.

## unsettledBy

A settle or `stable` wait that ends with `settled: false` on a screen that kept changing carries
`unsettledBy`. It holds up to 3 `{elementId, label, field}` entries from the last pair of
same-screen reads that differed:

- changed nodes first, with `field` set to the first attribute that changed
- then added and removed nodes, with `field` set to `added` or `removed`
- then changed top-level fields, such as `rotation`, as entries with only `field`

## Background

- [Stable wait timeout is a result, not an error](../../devlog/2026-11-24-stable-wait-timeout-not-error.md)
