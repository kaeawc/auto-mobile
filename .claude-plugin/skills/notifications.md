---
description: Interact with notifications and system tray
allowed-tools: mcp__auto-mobile__systemTray
---

Interact with the notification shade and system tray.

## Open Notification Shade

Pull down the notification shade:

```
systemTray with action: "open"
```

## Close Notification Shade

Collapse the shade (safe no-op if already closed). Prefer this over `pressButton` for deterministic cleanup between tests:

```
systemTray with action: "close"
```

## Find Notification

Search for a specific notification:

```
systemTray with action: "find", notification: {title: "New message"}
systemTray with action: "find", notification: {body: "You have 3 new emails"}
systemTray with action: "find", notification: {appId: "com.example.app"}
```

Search criteria:

- `title`: Notification title text
- `body`: Notification body text
- `appId`: Source app package name

## Tap Notification

Tap on a notification or its action button:

```
systemTray with action: "tap", notification: {title: "New message"}
systemTray with action: "tap", notification: {title: "New message"}, tapActionLabel: "Reply"
```

## Dismiss Notification

Swipe away a notification:

```
systemTray with action: "dismiss", notification: {title: "New message"}
```

## Clear All Notifications

Remove all notifications:

```
systemTray with action: "clearAll"
```

## Common Workflows

**Check and act on notification:**

```
systemTray "open" → systemTray "find" → systemTray "tap"
```

**Clear notifications before test:**

```
systemTray "open" → systemTray "clearAll" → systemTray "close"
```

**Verify notification appeared:**

```
(trigger notification) → systemTray "open" → systemTray "find"
```

## Collapsed Notification Groups

When an app posts 2+ notifications, Android collapses them into a single
group. The `tap` action handles this **automatically** — no special
parameters needed:

1. Matches the notification text inside the collapsed group
2. Detects that the match is inside a collapsed group
3. Taps the "Expand" button on the group header (matched by
   `content-desc: "Expand"` or `resource-id` containing `expand_button`)
4. Re-observes the hierarchy after expansion
5. Taps the specific individual notification (triggering its deep-link)

This is critical because tapping a notification inside a collapsed group
without expanding first will open the app generically instead of triggering
the notification's specific intent/deep-link.

## Tips

- Always `open` the system tray before other actions
- Use `pressButton "back"` or `homeScreen` to close the shade
- Notifications may take a moment to appear after triggering
- Collapsed notification groups are expanded automatically when tapping —
  no extra parameters or steps required
