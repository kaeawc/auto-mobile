# Action diffs summarize added and removed nodes

- Kind: decision
- Date: 2026-11-24
- Source: #19122, #19142, #19146, #11637
- Shaped: [Interaction loop](../how-it-works/mcp/interaction-loop.md)

## Context

#11637 dropped the `added` and `removed` lists from action diffs. The
`skeleton` sent with every diff already lists each actionable node. #19122
found three cases where `changed` then did not say what a tap did. Turning Wi-Fi
off collapsed the network list, which resized the list and re-keyed every row
under it. The #11638 guard refuses label-less state flips, so the label-less
Wi-Fi switch could not be re-paired. Its `checked` change was hidden as a
dropped remove and add. Closing a dialog removed a few buttons and revealed
about 30 rows. That never met the replacement rule's `min(added, removed) >= 3`,
so the client got a diff with `changed: []`. Closing a bottom sheet paired the sheet's
window root with the app's window root (both full-screen, no id or text, sibling
index 0), so the only change was `windowId`.

## Options

- Restore `added` and `removed` on the wire. Rejected in #11637: it repeats the
  skeleton.
- Send a count and a few labels for each side, and fix the pairing and
  replacement rules so `changed` and `mode` are right in these cases.
- Match `changed` entries by element id before the positional key, as #19122
  suggested. A generic id such as `switchWidget` is shared by many rows, which
  is the #11638 false pairing.

## Decision

- Action diffs carry `addedSummary` and `removedSummary` (`{count, labels?}`,
  at most 5 labels) in place of the dropped lists.
- A same-screen diff that added at least 3 nodes, removed at least 1, and whose
  added nodes are at least half the current skeleton is sent as a full
  observation. Pure expansions and scrolls stay diffs.
- A label-less control is re-paired by content identity when its id is unique
  on both sides and its bounds did not change. The #11638 guard still refuses a
  pair that moved.
- A node with an integer `windowId` uses it in its positional key in place of
  its sibling index, so nodes in different windows never pair.

## Consequences

The wire diff schema gains two optional fields and `schemas/tool-definitions.json`
is regenerated. Positional keys of Android window roots now contain `w<windowId>`,
so a window that is re-created with a new id reads as removed and added rather
than changed. Clients that need the full node attributes of what appeared still
read the `skeleton`.

#19146 later required a re-paired label-less control to keep its row title as
well as its bounds, and capped each summary label at 60 characters.
