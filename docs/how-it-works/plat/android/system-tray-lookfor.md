# System tray lookFor

`systemTray` opens the notification shade and finds, lists, taps or dismisses notifications by
text. Collapsed notification groups are expanded before tapping.

## MCP tool

```typescript
systemTray({
  action: "open" | "close" | "list" | "find" | "tap" | "dismiss" | "clearAll",
  notification?: {
    title?: string,
    body?: string,
    appId?: string,
    tapActionLabel?: string
    replyText?: string // Watch-only inline reply for tap; defaults the action label to Keyboard input
  },
  awaitTimeout?: number
})
```

## List notifications for an app

On Android, use `systemTray({ action: "list", notification: { appId: "com.google.android.apps.messaging" } })`.
The command collapses and reopens the shade to reset its scroll position, reads its initial contents, then swipes upward at most three times to collect more rows. It stops early when the rows no longer change and closes the shade before returning, so follow-up actions reopen at the top. Cancellation stops further package batches, swipes, and observations.

The response contains `notifications`, `swipes`, `unattributedRows`, and `order: "encounter"`. Each notification includes `id` (when Android exposes a unique row ID), `appId`, `appLabel`, `title`, `body`, `actions`, `texts` (including custom-layout text), `inGroup`, `ownership` (the evidence class that attributed the row: `"header"` or `"dumpsys"`), and `tag` when the row maps to a prototype notification (see below). Missing title/body fields are `null`; only text exposed by the hierarchy is available. Child notifications can inherit their group's app header. Overlapping rows on consecutive pages are reconciled by their unique row IDs when available, otherwise by ordered row positions. Stable IDs or unchanged neighboring rows anchor the scroll displacement, so a row can update its title/body without becoming a duplicate. Without usable IDs or a continuity anchor, rows are retained separately. This positional fallback is best effort: replacement or reordered rows without native IDs cannot always be distinguished. Explicit end-of-scroll metadata stops the scan before unnecessary repeat observations.

App filtering uses the notification's app header, not mentions in message text. Before scanning, the command verifies that this label is unique across a fresh installed-package inventory. Duplicate labels, incomplete inventories, or unavailable label metadata return an error instead of attributing ambiguous notifications. Encounter order is the shade's order, not a guarantee of posting time. This bounded scan may omit notifications beyond three swipes. `list` requires `notification.appId`; `find`, `tap` and `dismiss` keep their own criteria requirements.

### Ownership evidence for header-less rows

SystemUI renders the **Silent** (low-importance) section without the per-row
app-name header, so those rows carry no ownership evidence in the shade. The header is
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

The dump is read when the shade contains a header-less row, or a header row for
the requested app (to name prototype tags below); `clearAll` skips the latter
read. A redacted dump (`--noredact` unsupported or refused) prints value lengths rather
than values, so it yields no correlation evidence: such rows stay unattributed
instead of being guessed at. Every row no evidence class can attribute is
counted in `unattributedRows` and named in the response message, so
`Listed 0 notifications` is distinguishable from "this app has no
notifications".

### Prototype notification tags

Prototype apps post every notification with a `proto:` tag, which the dump
prints as the fourth field of the record key (`<user>|<pkg>|<id>|<tag>|<uid>`).
After a row is attributed by either evidence class, it carries `tag` when
exactly one of the requested package's non-summary records could have rendered
the row (shares its text, or has no readable extras) and that record is
`proto:`-tagged and matches by the same extras rule used for ownership. Every
record of the package competes, tagged or not, so a same-text twin or a
record whose body a collapsed row hides leaves `tag` absent. Group summary
records are ignored, so a grouped pair maps each child to its own tag. An
unreadable dump, or a record already cancelled while its row lingers, also
leaves `tag` absent; it never changes attribution.

## Tap observation result

After dispatching a notification or action-button tap, the tool polls for a
fresh screen change and a 1-second quiet period, with a 2.5-second polling
budget. A settled result includes `settled: true` and the final observation,
so inline Reply returns its input field rather than the pre-tap shade.

If the effect cannot be confirmed within that budget, the response keeps
dispatch-level `success: true`, sets `settled: false`, and omits the
observation. Re-observe before continuing; do not interpret an unsettled
result as proof that the tap failed or retry the tap automatically.

## Dismiss outcome (Android)

A `dismiss` swipe says nothing about whether the row left the shade: an ongoing
(foreground-service, media) notification snaps back. After the swipe the tool
compares the swiped row with the post-swipe observation it already takes. The
row is identified by its non-volatile texts (title, body, app label); the count
of rows reading exactly that way must drop. A row that survives with a changed
body (download progress, a timer, a media position) still counts as present when
a row with the same title and app label remains within one row height of the
swiped position, because CtrlProxy exposes no notification key. A same-titled
row with different text far from that position, or a differently titled row, is
a different notification. If the row is still present the tool waits one
swipe settle (400 ms), observes once more, and returns `success: false` with
`isError: true` when the row is still there. The message names
"ongoing/non-clearable" only when the matched row lists accessibility actions
without `dismiss` (SystemUI adds that action only to swipeable rows); otherwise
it says the notification is still present. When the post-swipe observation is
not the shade the outcome is indeterminate and the existing success result is
kept. A confirmed dismiss costs no extra device call; a stuck row costs one sleep
and one observe. iOS does not run this check.

## Clear-all outcome (Android)

Android `clearAll` expands collapsed groups before swiping individual rows and
verifies each dismissal. If a post-swipe read finds the shade closed, it reopens
the shade before another fresh read, throttled to once per second within the
current notification's deadline. An unreadable shade or a read/reopen timeout after a
swipe returns a partial result with `stalled: true` and a separate `swipeCount`;
unverified swipes do not count as dismissals. App-filtered `dismissedCount`
continues to use the before/after notification inventory. Cancellation still
aborts the operation, and an unreadable shade before any swipe remains an error.

Before the first swipe, every step that a loaded host can make slow is retried
instead of failing the call: the initial shade read, the app-filtered listing
(a collapse that times out, a shade read mid-render that no notification record
explains) and the notification-count `dumpsys`. Each step gets up to three
attempts with a short exponential backoff (250 ms, then 500 ms); the shade
readiness attempts each use the full `awaitTimeout`, so an unreadable shade fails
after about three budgets. Device errors and cancellation are never retried. The
listing leaves the shade collapsed and the drain expands it directly, skipping a
second collapse/expand cycle and two probe reads.

The initial shade read uses the initial `awaitTimeout` budget per attempt. Each verified
dismissal starts a fresh per-notification budget for expansion, swiping and
verification, so a progressing drain can exceed `awaitTimeout` overall. A row
that does not leave within its budget stalls the drain without another swipe on
that row; the inventory swipe limit, 25-swipe safety cap and cancellation still
bound the operation.

## Android implementation

- Open/close (preferred): `adb -s <device> shell cmd statusbar expand-notifications` / `cmd statusbar collapse` (also `systemTray` action `close`). Fallback: swipe down from the status bar when `cmd statusbar` is unavailable.
- Find: read the `com.android.systemui` node tree via the AccessibilityService, match text or resource ID, and return bounding box plus hierarchy path for follow-up taps.

### App filter attribution

`find`, `tap`, `dismiss` and `clearAll` compare `notification.appId`'s label (and
the id itself) only against a row's attribution element, so another app's name
in a title or body never attributes the row to that app. On Android that is the
`app_name_text` header label; a group child is attributed by its group's header.
On iOS no separate label exists: a stacked row's `NotificationShortLookView`
accessibility label leads with the app's display name
(`"MESSAGES, Grouped, now, <title>, <body>"`), and only that leading name is
compared. A lone banner's label starts at its time (`"now, <title>, <body>"`)
and names no app, so it is attributed only when `postNotification` posted its
exact title and body (the alert iOS displays, after any raw `aps` override) for
that app, and no other app, on that device in this server process; otherwise
the not-found error says the banner cannot be attributed. Each row is
attributed by its own evidence, never by another row's. An Android row that
renders no attribution element (for example a header-less Silent row) falls
back to matching the app filter against all of its text.

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
   expand→settle→re-match phase has its own bounded budget starting after the
   expand tap, so tap latency cannot consume the full settle period plus one
   poll window. It can overrun the original timeout by at most tap latency plus
   one settle period plus one poll interval.
5. **Tap** — The specific notification row is tapped, triggering its
   deep-link intent (e.g. launching a specific flow rather than opening the
   app generically).

#### Approaches that do not work

- **Tapping text nodes inside collapsed groups**: Android routes the tap to the group header, which
  opens the app generically instead of triggering the notification's deep-link intent.
- **Swiping on the group** to expand: `adb shell input swipe` does not reliably expand collapsed
  groups.
- **Tapping the expand button** without first identifying the correct group node: the parent
  notification row intercepts the tap.
- **Matching without expansion**: even with correct text matching inside a collapsed group, the tap
  target is not clickable until the group is visually expanded.

#### `find` does not auto-expand; `tap` and `dismiss` do

`find` can match text inside a collapsed group (through the visibility
bypass below) but is read-only and does not expand it. Both `tap`
and `dismiss` expand a collapsed group before acting, so expansion is a visible
side effect when either action targets a notification inside one. If `dismiss`
cannot isolate the specific notification after expansion, it throws rather than
swiping the group and clearing every notification in it.

#### CtrlProxy `isVisibleToUser` bypass

Collapsed notification groups mark child text nodes as
`isVisibleToUser=false` in the accessibility tree, even though they are
present in the shade. The extractor does not filter on `isVisibleToUser`
for any package (see
`android/control-proxy/src/main/kotlin/dev/jasonpearson/automobile/ctrlproxy/ViewHierarchyExtractor.kt`),
so collapsed notification-group children remain matchable. Notification candidate
collection filters nodes through resource ID hints and exclusions, so other
system UI nodes (status bar, quick settings) are not collected as candidates.

The occlusion filter runs only with more than one window (`windowEntries.size > 1`
guard): within a single system UI window, peer subtrees (e.g. `notification_panel`
and `keyguard_message_area_container`) would otherwise strip each other's content.

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

## ADB commands (confirmed on API 35)

`cmd statusbar expand-notifications`, `cmd statusbar collapse` and
`cmd statusbar expand-settings` (quick settings) work as expected, and a
`uiautomator dump` of the open shade contains notification text suitable for
matching. API 29 is not validated.

## Limits

- OEM System UI layouts vary; emulator support may be the reliable baseline.
- Requires AccessibilityService access to System UI nodes.
- Collapsed group expansion depends on the "Expand" button being present in
  the accessibility tree with predictable `content-desc` and `resource-id`
  values. Non-standard OEM notification UIs may use different patterns.

## Background

- [System tray: header-less Silent rows](../../../devlog/2026-09-13-system-tray-lookfor-headerless-rows.md)
