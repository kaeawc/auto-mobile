# `shareSheet`

| Tool                       | What it does                                                                             | Platforms                                                                                                                                                   | Needs                             |
| -------------------------- | ---------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------- |
| 🫱 <code>shareSheet</code> | List visible targets, select a target, or dismiss the share sheet after the app opens it | <span class="tool-platforms"><span role="img" aria-label="Android" title="Android">🤖</span> <span role="img" aria-label="iOS" title="iOS">🍎</span></span> | <span class="tool-needs">—</span> |

`shareSheet` drives the system share sheet after the app under test opens it.
It handles the Android 14+ sheet, the older Android chooser and the iOS
share sheet. Opening the sheet is the app's job (tap its Share button first).

## Actions

- `list` returns the visible targets as `{label, kind, appId?}` and the sheet
  type. The `sheetKind` field is one of `android-intentresolver`,
  `android-legacy` or `ios-activity-view-controller`. The `kind` field is
  `app`, `direct` or `action` (for example Copy). Android includes `appId` only
  when it could verify the package.
- `select` taps one target. Pass exactly one of `label` or `appId` (Android
  only). Android scrolls the list when the target is not visible yet. iOS
  identifies targets by label only and refuses `appId`.
- `dismiss` closes the sheet.

An ambiguous label is refused with the candidates listed, rather than tapping
the first match. Use a unique label or the `appId`. If no sheet is showing, the
call fails and asks you to open it from the app first.

## Testing share flows

Each check below starts from an open sheet. Selecting a target closes the
sheet, so tap the app's Share button again before the next check.

- Select the Playground share sink (`AutoMobile Share Sink` on Android,
  `Playground` on iOS) and read the fields it shows with `observe`.
- Select the `Copy` target, then read the clipboard.
- For prototypes, wait for the `share.open` platform event.
