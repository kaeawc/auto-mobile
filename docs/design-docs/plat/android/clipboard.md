# Clipboard tool

<kbd>✅ Implemented</kbd> <kbd>🧪 Tested</kbd>

> **Current state:** `clipboard` MCP tool routes Android operations through the AutoMobile Accessibility Service. On API 35, `cmd clipboard` returns "No shell command implementation", so Android `get` reports accessibility-service read restrictions directly instead of treating ADB as a recovery path. See the [Status Glossary](../../status-glossary.md) for chip definitions.

## Goal

Provide clipboard copy/paste/clear/get for Android 29/35 emulators and
best-effort support on devices.

## MCP tool

```typescript
clipboard({
  action: "copy" | "paste" | "clear" | "get",
  text?: string
})
```

## Android implementation

Primary path:

- CtrlProxy handles `copy`, `paste`, `clear`, and `get` via the AutoMobile
  Accessibility Service.
- `copy` and `clear` are direct `ClipboardManager` writes from CtrlProxy.
- `paste` uses accessibility paste actions against the focused editable node.
- `get` returns an explicit failure when Android reports the clipboard as
  unreadable from the background on Android 10+.

Android 10+ read model:

- Direct clipboard reads work only for the focused foreground app, the default
  IME, or privileged/system services.
- CtrlProxy is a background accessibility service, so it cannot reliably read a
  target app's clipboard with `ClipboardManager.getPrimaryClip()`.
- If target-app code is available, read from the target app while its activity
  has input focus.
- If an automation IME is available and selected as the default keyboard, read
  through that IME.
- For black-box automation, focus an editable field, paste, then read the field
  contents via accessibility. This reads what would be pasted, not the raw
  clipboard independently.

Legacy ADB path:

- `cmd clipboard` is guarded as unsupported when Android returns
  "No shell command implementation".
- Android `get` does not use `cmd clipboard` as a recovery path.
- `dumpsys clipboard` is not a reliable content read path on current emulator
  images.

Do not retry these as clipboard-read fixes:

- Background helper apps or foreground services without actual input focus.
- Accessibility services calling `ClipboardManager.getPrimaryClip()` and
  treating `null` as empty.
- `adb shell cmd clipboard get` on modern builds that report
  "No shell command implementation".

Failure reporting:

- Android 10+ restricts clipboard reads for background apps. CtrlProxy cannot
  distinguish a denied background read from an empty clipboard when
  `ClipboardManager.getPrimaryClip()` returns `null`, so it reports that state
  as unreadable/restricted instead of successful empty content.

## ADB validation (API 35)

Status:

- API 29 not validated yet (no local AVD available).

Attempted commands:

- `adb -s <device> shell cmd clipboard set "Hello AutoMobile"`
- `adb -s <device> shell cmd clipboard get`
- `adb -s <device> shell cmd clipboard clear`
- `adb -s <device> shell cmd clipboard get`

Observed results:

- `cmd clipboard` returns "No shell command implementation" on API 35.
- `dumpsys clipboard` returns empty output.

Notes:

- ADB-only clipboard manipulation appears unsupported on this emulator/API
  level.

## Plan

1. Add a node-based paste-then-read path for focused editable fields where
   possible.
2. Explore foreground target-app or IME-assisted reads for cases that require
   actual ClipboardManager content.

## Risks

- Clipboard reads may be blocked on physical devices without foreground UI.
- Service call clipboard APIs are unstable across OEMs.
