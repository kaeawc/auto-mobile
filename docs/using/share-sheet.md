# `shareSheet`

| Tool                       | What it does                                              | Platforms                                                                                                                                                   | Needs                             |
| -------------------------- | --------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------- |
| 🫱 <code>shareSheet</code> | List, select or dismiss targets on the system share sheet | <span class="tool-platforms"><span role="img" aria-label="Android" title="Android">🤖</span> <span role="img" aria-label="iOS" title="iOS">🍎</span></span> | <span class="tool-needs">—</span> |

`shareSheet` drives the system share sheet after the app under test opens it.
It handles the Android 14+ sheet, the older Android chooser and the iOS
share sheet. Opening the sheet is the app's job (tap its Share button first).

## Actions

- `list` returns the visible targets as `{label, kind, appId?}` plus `sheetKind`
  (`android-intentresolver`, `android-legacy` or `ios-activity-view-controller`).
  `kind` is `app`, `direct` or `action` (for example Copy). `appId` appears on
  Android only when the package could be verified.
- `select` taps one target. Pass exactly one of `label` or `appId` (Android
  only). Android scrolls the list when the target is not visible yet. iOS
  identifies targets by label only and refuses `appId`.
- `dismiss` closes the sheet.

An ambiguous label is refused with the candidates listed, rather than tapping
the first match. Use a unique label or the `appId`. If no sheet is showing, the
call fails and asks you to open it from the app first.

## Testing share flows

1. Assert what was shared by selecting the Playground share sink
   (`AutoMobile Share Sink` on Android, `Playground` on iOS) and reading the
   fields it shows with `observe`.
2. Select the `Copy` target, then read the clipboard.
3. For prototypes, wait for the `share.open` platform event.
