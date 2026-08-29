# System tray lookFor

<kbd>✅ Implemented</kbd> <kbd>🧪 Tested</kbd>

> **Current state:** `systemTray` is implemented with
> open/close/find/tap/dismiss/clearAll actions. Collapsed notification groups
> are automatically expanded before tapping.

## Goal

Enable agents to open the notification shade and wait for a matching
notification by text.

## MCP tool

```typescript
systemTray({
  action: "open" | "close" | "find" | "tap" | "dismiss" | "clearAll",
  notification?: {
    title?: string,
    body?: string,
    appId?: string,
    tapActionLabel?: string
  },
  awaitTimeout?: number
})
```

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
   the best match has a `groupNode`. If so, the notification is inside a
   collapsed group.
3. **Expand** — `expandNotificationGroup` finds the "Expand" button inside
   the group header (matched by `content-desc: "Expand"` or `resource-id`
   containing `expand_button`) and taps it via ADB.
4. **Re-match** — After a 500 ms settle, the tool re-observes the hierarchy
   and re-matches the now-expanded notification.
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

#### `find` and `dismiss` do not auto-expand

Only `tap` auto-expands collapsed groups. `find` can match text inside a
collapsed group (thanks to the visibility bypass below), but it does not
expand the group — it is read-only. `dismiss` similarly matches without
expanding. This keeps side effects limited to the action that needs them.

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
