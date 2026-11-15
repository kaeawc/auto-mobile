# Prototype spec: saved prototypes

Part of [the agent-authored prototype specification](prototype-ux.md).

## Saved prototype activity

`SavedPrototypeLaunch.intent(context, id)` targets the explicit
`SavedPrototypeActivity` component with data `automobile-saved-prototype:/<id>`
(the single path segment is encoded with `Uri.Builder`) and
`FLAG_ACTIVITY_NEW_DOCUMENT`. No extras are read: intents select only an id,
never a spec or assets. `documentLaunchMode="intoExisting"` matches component and
data via `Intent.filterEquals`, giving each id its own task while reusing the
same id's task. Shortcut publishing may add flags; shortcut removal is limited to
`disableShortcuts` (see "Saved prototypes on the Android home screen").

A document relaunch calls `onNewIntent`, updates the activity's intent and reloads
the saved entry. It closes the previous runtime without emitting a dismissal,
then renders the latest snapshot or the corresponding typed error screen if the
entry was deleted or cannot be opened. A different id delivered to the activity
also reloads. Handled configuration changes preserve the live runtime state.

The activity is `exported=false` with no intent filter: app-owned launches (including our pinned shortcut intents) can open it, other apps cannot render saved content or probe ids. Explicit app-owned intents also avoid Android 15's stricter intent matching.

Saved entries live under `savedPrototypeRoot(context)`, the credential-encrypted
app-private `filesDir/saved-prototypes` directory. Locked storage is checked
before constructing or calling the store. Missing ids, deleted entries, corrupt
content, unsupported format versions and locked storage have typed screens;
raw storage messages and paths never reach the UI.
The Locked screen is defensive: the app is not `directBootAware`, so this
activity cannot start before the device's first unlock. The storage check also
covers unavailable credential storage, such as a locked work profile.

The existing runtime and Compose renderer run in an activity window without
accessibility service state, overlay ownership, idle timeout, disconnect
dismissal or foreground-app scoping. Back, authored dismiss and HostDismiss
finish the activity and emit exactly one `dismissed` event with reason `user`.
A system process kill emits nothing. Offline events enter the process-level
`SavedPrototypeEvents.buffer`; a registered delivery consumes an event only when
it returns true. Sequence numbers are allocated per prototype id for the process
lifetime and continue across activity recreation and document relaunch. Future
replay must synchronize on the buffer while draining or
restoring it. The bounded buffer is in memory and does not survive process death.

### Multiple surfaces

On Android, `show` with `replaceOthers: false` adds another prototype window, requiring
`prototype_multi_surface_v1`. Up to four distinct ids can be shown; a fifth is refused with the
ids already shown, leaving them unchanged. Showing an existing id with `replaceOthers: false`
replaces only that prototype. Omitted or `true` replaces the other prototypes.
`dismiss {id}` removes only that id; `dismiss {all: true}` removes all. `status` lists every
shown prototype by id, and `inspect` reconciles the full device list. State, patches and
`awaitEvent {id}` remain independent per prototype.

Not supported: `stateGroup` / shared state groups, `window.z`, selective
observe exclusion, cross-window focus, iOS multi-window parity, or `prototype_state_groups_v1`.

## Saved prototypes on the Android home screen

`prototype` `save` (needs `prototype_saved_v1`) stores the validated spec and its assets in
CtrlProxy's app-private storage. With `pin:true` the host then sends `pin_saved_prototype`, and
CtrlProxy calls `ShortcutManager.requestPinShortcut` with the stored label and an adaptive icon
(uploaded `icon` asset, else the label's first letter). The shortcut's intent selects only the
prototype id; tapping it opens `SavedPrototypeActivity`, which needs no host.

- Android never pins silently: the default launcher always shows its confirmation dialog, so a
  fresh pin is reported `pending`. Declining delivers no callback. `autoConfirm` taps the dialog's accept
  button by label and reports `pinned` only after `listSaved` confirms (#12266; launcher dialogs differ, see below).
- A launcher caches its workspace, so a new or updated shortcut can stay invisible (#14887). After a
  `pinned` result, or a save whose shortcut was `updated`, the host looks for the label on the home
  screen, swiping through the following workspace pages (Pixel Launcher puts a new pin on page 2)
  until the label appears, a page repeats, or ten pages are checked. If it is missing, it resolves
  the default launcher (`cmd package resolve-activity`), and when that package is a known launcher
  runs `am force-stop` plus a HOME intent once, waits for the launcher's tree to go quiet, and scans
  again from the reset page. The result reports `launcherRestarted` and `shortcutVisible`; an
  unknown launcher is left alone with a warning. It is on by default on emulators and physical
  devices; `restartLauncher:false` opts out. It never runs on a pending pin (no shortcut exists
  yet) and runs at most once per call.
- Guards: the save is a control call, so the device-ownership layer refuses it on a device another
  session, daemon or binding holds. The check never swipes or restarts when the foreground app is
  not a launcher; it reports the shortcut unconfirmed instead. In-process saves take a per-device
  ownership; a second concurrent save only checks the current page and never swipes or restarts
  under the first.
- An unsupported launcher keeps the save and reports `pinned:"unsupported"`. With the screen off,
  `requestPinShortcut` throws `IllegalStateException` and the call reports `device_locked`; the save
  remains and a retry is safe. An awake device showing the keyguard accepts the request, and the
  dialog waits behind the keyguard (`pending`).
- The app cannot remove a pinned icon: `deleteSaved` disables the shortcut. `removeIcon:true`
  runs `cmd shortcut clear-shortcuts` from the host, but only when no saved prototype remains,
  because the command clears all CtrlProxy shortcuts.
- Uninstalling or clearing CtrlProxy deletes saved prototypes and every pinned shortcut; the host
  mirror (#12268) restores the saved content, never the icons.
- The accessibility-bound CtrlProxy may call `requestPinShortcut` with no activity visible (its
  process is a bound foreground service).
- The dialog is `AddItemActivity` (`QuickstepAddItemActivity` on API 37 Pixel Launcher) and its
  shape differs by API and launcher: a platform AlertDialog with "ADD AUTOMATICALLY" (AOSP
  Launcher3), a bottom sheet with an "Add to home screen" `Button` (Pixel Launcher before API 37),
  or a Compose sheet whose labels are plain text under a clickable parent (Pixel Launcher, API 37).
  The accept match is by label and covers all three (fixtures in
  `test/fixtures/android-pin-dialog/`); a launcher with another label is reported
  (`unrecognized` or a timeout) and Cancel is never tapped.
- The launcher badges the pinned icon with CtrlProxy's icon, and often places it on workspace
  page 2 even when page 1 has room.
- `clear-shortcuts` removes the icons from the workspace, not only the shortcut records.
