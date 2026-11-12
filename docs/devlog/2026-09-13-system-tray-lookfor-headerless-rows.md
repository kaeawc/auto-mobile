# System tray: header-less Silent rows

- Kind: decision
- Date: 2026-09-13
- Source: moved from `how-it-works/plat/android/system-tray-lookfor.md`; #6875, #6883
- Shaped: [System tray lookFor](../how-it-works/plat/android/system-tray-lookfor.md)

## Context

SystemUI renders the **Silent** (low-importance) section without the per-row app-name header. A
header-only ownership rule therefore reported `Listed 0` for those rows (#6875).

## Options

Not recorded.

## Decision

Keep the header as the primary evidence and correlate header-less rows against
`adb shell dumpsys notification --noredact`, attributing a row only when its text matches the
requested package's notification extras and no other package's record (`ownership: "dumpsys"`).

## Consequences

Rows no evidence class can attribute are counted in `unattributedRows`, so `Listed 0 notifications`
is distinguishable from "this app has no notifications".
