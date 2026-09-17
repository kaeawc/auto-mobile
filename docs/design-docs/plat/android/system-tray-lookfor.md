# System tray lookFor

<kbd>✅ Implemented</kbd> <kbd>🧪 Tested</kbd>

> **Current state:** `systemTray` is implemented with
> open/close/list/find/tap/dismiss/clearAll actions. Collapsed notification groups
> are automatically expanded before tapping.

## Goal

Enable agents to open the notification shade and wait for a matching
notification by text.

## MCP tool

```typescript
systemTray({
  action: "open" | "close" | "list" | "find" | "tap" | "dismiss" | "clearAll",
  notification?: {
    title?: string,
    body?: string,
    appId?: string,
    tapActionLabel?: string
  },
  awaitTimeout?: number
})
```

## List notifications for an app

On Android, use `systemTray({ action: "list", notification: { appId: "com.google.android.apps.messaging" } })`.
The command collapses and reopens the shade to reset its scroll position, reads its initial contents, then swipes upward at most three times to collect more rows. It stops early when the rows no longer change and closes the shade before returning, so follow-up actions reopen at the top. Cancellation stops further package batches, swipes, and observations.

The response contains `notifications`, `swipes`, `unattributedRows`, and `order: "encounter"`. Each notification includes `id` (when Android exposes a unique row ID), `appId`, `appLabel`, `title`, `body`, `actions`, `texts` (including custom-layout text), `inGroup`, and `ownership` (the evidence class that attributed the row: `"header"` or `"dumpsys"`). Missing title/body fields are `null`; only text exposed by the hierarchy is available. Child notifications can inherit their group's app header. Overlapping rows on consecutive pages are reconciled by their unique row IDs when available, otherwise by ordered row positions. Stable IDs or unchanged neighboring rows anchor the scroll displacement, so a row can update its title/body without becoming a duplicate. Without usable IDs or a continuity anchor, rows are retained separately. This positional fallback is best effort: replacement or reordered rows without native IDs cannot always be distinguished. Explicit end-of-scroll metadata stops the scan before unnecessary repeat observations.

App filtering uses the notification's app header, not mentions in message text. Before scanning, the command verifies that this label is unique across a fresh installed-package inventory. Duplicate labels, incomplete inventories, or unavailable label metadata return an error instead of attributing ambiguous notifications. Encounter order is the shade's order, not a guarantee of posting time. This bounded scan may omit notifications beyond three swipes. `list` requires `notification.appId`; existing `find`, `tap`, and `dismiss` criteria requirements are unchanged.

### Ownership evidence for header-less rows

SystemUI renders the **Silent** (low-importance) section without the per-row
app-name header, so those rows carry no ownership evidence in the shade at all
and a header-only rule reported `Listed 0` for them (#6875). The header stays
the primary evidence; rows that carry none are correlated against
`adb shell dumpsys notification --noredact`, which is authoritative about the
posting package. A header-less row is attributed to the requested app only when
the text it renders matches that package's notification extras
(`android.title` / `android.text` and their big/sub/summary variants) and no
other package's record matches the same text — ambiguity is reported as
unknown, never resolved by preference. Rows attributed this way carry
`ownership: "dumpsys"`; header-attributed rows carry `ownership: "header"`.

Only text the posting app supplied is correlated: the labels SystemUI renders
itself — action buttons, expand/dismiss/snooze controls, the post timestamp and
a running chronometer — are reported in `texts` but never used as ownership
evidence. A record whose extras carry no readable text at all (a custom
`RemoteViews` notification, or a redacted dump) could have posted any
header-less row, so it keeps every such row ambiguous rather than letting a
different package's matching extras claim it.

The dump is only read when the shade actually contains a header-less row. A
redacted dump (`--noredact` unsupported or refused) prints value lengths rather
than values, so it yields no correlation evidence: such rows stay unattributed
instead of being guessed at. Every row no evidence class can attribute is
counted in `unattributedRows` and named in the response message, so
`Listed 0 notifications` is distinguishable from "this app has no
notifications".

## Tap observation result

After dispatching a notification or action-button tap, the tool polls for a
fresh screen change and a 1-second quiet period, with a 2.5-second polling
budget. A settled result includes `settled: true` and the final observation,
so inline Reply returns its input field rather than the pre-tap shade.

If the effect cannot be confirmed within that budget, the response keeps
dispatch-level `success: true`, sets `settled: false`, and omits the
observation. Re-observe before continuing; do not interpret an unsettled
result as proof that the tap failed or retry the tap automatically.

## Android implementation

Open/close the tray (preferred, emulator):

- `adb -s <device> shell cmd statusbar expand-notifications`
- `adb -s <device> shell cmd statusbar collapse` (also exposed as `systemTray` action `close`)

Fallback (gesture):

- Swipe down from status bar if `cmd statusbar` is unavailable.

Finding notifications:

- Use AccessibilityService to read the System UI node tree.
- Search for a node with matching text or resource ID in
  `com.android.systemui`.
- Return bounding box + hierarchy path for use in follow-up taps.

### Collapsed notification group handling

When an app posts 2+ notifications, Android collapses them into a single
group header. The `tap` action handles this automatically:

1. **Match** — `collectNotificationCandidates` traverses the hierarchy. When
   it encounters a notification group (a node whose children include a
   `notification_children_container`), it descends into the group's children
   and tags each child candidate with a `groupNode` reference.
2. **Detect** — After matching, `isMatchInCollapsedGroup` checks whether
   the best match has a `groupNode`; this means the notification belongs to a
   group, whether collapsed or expanded. `isNotificationGroupExpanded` first
   identifies an expanded group structurally when a per-child
   `expandableNotificationRow` contains `status_bar_latest_event_content`.
   This structural signal is decisive. When it is absent, child-row geometry
   corroborates the state using row height and position relative to the group
   header's own height and bounds, rather than fixed pixel thresholds, so the
   result is density-independent. An explicit header button content description
   of exactly `Expand` or `Collapse` decides when geometry is inconclusive and
   overrides geometry when they disagree. Unrecognized shapes remain unknown:
   taps conservatively attempt expansion, while dismiss refuses to swipe.
3. **Expand** — `expandNotificationGroup` finds the "Expand" button inside
   the group header, preferring a `resource-id` containing `expand_button` and
   falling back to a `content-desc` equal to "Expand" (case-insensitive), and
   taps it via ADB.
4. **Re-match** — After a 500 ms settle, the tool re-observes the hierarchy
   and re-matches the now-expanded notification. Once a match is found, this
   expand→settle→re-match phase has its own bounded budget, so a notification
   found late in a short `awaitTimeout` is not abandoned merely because settling
   consumed the caller's remaining timeout. It can overrun the original timeout
   by at most one settle period plus one poll interval.
5. **Tap** — The specific notification row is tapped, triggering its
   deep-link intent (e.g. launching a specific flow rather than opening the
   app generically).

#### What didn't work (lessons learned)

- **Tapping text nodes inside collapsed groups** — Android routes the tap to
  the group header, which opens the app generically instead of triggering
  the notification's specific deep-link intent.
- **Swiping/gesturing on the group** to expand — `adb shell input swipe`
  did not reliably expand collapsed groups.
- **Tapping the expand button directly** without first identifying the
  correct group node — the tap was intercepted by the parent notification
  row.
- **Matching only** without expansion — even with correct text matching
  inside collapsed groups, the tap target was not clickable until the group
  was visually expanded.

#### `find` does not auto-expand; `tap` and `dismiss` do

`find` can match text inside a collapsed group (thanks to the visibility
bypass below), but it does not expand the group — it is read-only. Both `tap`
and `dismiss` expand a collapsed group before acting, so expansion is a visible
side effect when either action targets a notification inside one. If `dismiss`
cannot isolate the specific notification after expansion, it throws rather than
swiping the group and clearing every notification in it.

#### CtrlProxy `isVisibleToUser` bypass

Collapsed notification groups mark child text nodes as
`isVisibleToUser=false` in the accessibility tree, even though they are
present in the shade. `ViewHierarchyExtractor.kt` bypasses this filter for
all `com.android.systemui` nodes (not scoped to the notification shade
specifically). The broader scope is safe because notification candidate
collection already filters nodes through resource ID hints and excludes —
extra system UI nodes (status bar, quick settings) are not collected as
notification candidates.

Additionally, the occlusion filter is skipped for single-window scenarios
(`windowEntries.size > 1` guard). Within a single system UI window, peer
subtrees (e.g. `notification_panel` and `keyguard_message_area_container`)
were incorrectly stripping each other's content. Multi-window occlusion
filtering is unaffected.

### Key resource IDs

Matching:

- `NOTIFICATION_ROW_RESOURCE_ID_HINTS`: `notification_row`,
  `expandablenotificationrow`, `status_bar_notification`,
  `notification_container`, `notification_content`,
  `notification_main_column`, `notification_template`

Exclusions (container nodes that must not be collected as individual
notification candidates):

- `notification_children_container` — the container holding grouped child
  notifications
- `notification_container_parent` — broad parent wrapping all notifications
- `shared_notification_container` — another broad wrapper with full-screen
  bounds

## ADB validation (API 35)

Status:

- API 29 not validated yet (no local AVD available).

Confirmed commands:

- Expand/collapse notification shade:
  - `adb -s <device> shell cmd statusbar expand-notifications`
  - `adb -s <device> shell uiautomator dump /sdcard/notification_dump.xml`
  - `adb -s <device> shell cat /sdcard/notification_dump.xml`
  - `adb -s <device> shell cmd statusbar collapse`

Observed results:

- Notification shade expands and collapses on command.
- uiautomator dump contains notification text suitable for lookFor matching.

Notes:

- `adb shell cmd statusbar expand-settings` is also available to expand quick
  settings when needed.

## Risks

- OEM System UI layouts vary; emulator support may be the reliable baseline.
- Requires AccessibilityService access to System UI nodes.
- Collapsed group expansion depends on the "Expand" button being present in
  the accessibility tree with predictable `content-desc` and `resource-id`
  values. Non-standard OEM notification UIs may use different patterns.
