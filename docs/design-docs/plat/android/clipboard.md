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
- `get` returns an explicit failure when Android reports the clipboard as
  unreadable from the background on Android 10+.

Legacy ADB path:

- `cmd clipboard` is guarded as unsupported when Android returns
  "No shell command implementation".
- Android `get` does not use `cmd clipboard` as a recovery path.

Notes:

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
  level; a helper APK fallback is likely required.

## Plan

1. Add a node-based read path for focused editable fields where possible.
2. Explore foreground/IME-assisted reads for cases that require actual
   ClipboardManager content.

## Risks

- Clipboard reads may be blocked on physical devices without foreground UI.
- Service call clipboard APIs are unstable across OEMs.
