# Device mutation journal: keep-booted baseline cleaning

Part of [the device mutation journal](session-broker-device-mutation-journal.md).

Keep-booted resets run baseline cleaning unconditionally when journal checks allow
it. Fallback-prefixed opaque rows force baseline fallback. Unrevertible journal
rows also force fallback unless baseline cleaning already restores their effects.
On Android this covers packages, clipboard, rotation, screen reader, keep-awake,
raw global/system/secure settings, verified display rows (`density`, `nightMode` and `display:*`),
opened URLs and launched preinstalled apps (below), and screen state via the next `wakeAndUnlock`.

Package cleaning lists only `pm list packages -3`, so a preinstalled app keeps its data
across a plain clean. Android `launchApp` and `measureStartup` therefore journal a
non-fallback `opaque` launch row (`["launched-app", appId]`). Before it mutates anything,
cleaning collects the session's started apps: every launch row's app, the target of a
`package:` URL, and, per user, every activity `cmd package query-activities --components`
lists for an `android.intent.action.VIEW` of any other opened URL (the handler that opened
it is not journaled, so all candidates count; a browser is the usual one). Candidates the
baseline holds for that user without a third-party package identity are preinstalled.
Each is force-stopped and `pm clear --user`ed after package cleaning; anything but a
`Success` reply fails cleaning. A preinstalled candidate on the unclearable list
(`ANDROID_UNCLEARABLE_PACKAGES`: framework, SystemUI, content providers, telephony,
Bluetooth, NFC, Google Play services and framework, Play Store, installer and permission
UI, launchers, input methods, AutoMobile's own packages), unreadable handler output or a
malformed launch row fails cleaning, which escalates to the baseline fallback. `pm clear`
returns the app to its factory state, not to data the baseline image may have held for it.
Session-installed apps are uninstalled instead, and third-party apps the baseline held keep
their data. Apps started without a journaled launch (tapping a launcher icon or a
notification, an intent a started app sends) are not seen. Data writes into any
baseline-held app (preferences, key-value stores, app-container files, SQL) keep forcing
fallback as described below. Settings-backed adapter
keys (`fontScale`, `timeFormat`, `textDirection` and accessibility display preferences)
require a journal revert or fallback; the Android port reverts them by writing back (or
deleting) their raw settings rows when the journaled prior is readable. The Android
`textDirection` prior is the raw `global:debug.force_rtl` and `global:force_rtl` rows.
`calendarSystem` forces fallback: its prior is the derived calendar (the locale's, or
`gregory` for an unset `calendar_type` row), which device-setting defaults also read, so
it does not say what the row held. `changeLocalization`'s
per-app locale row (`["app-locale", appId]`) journals `{ userId, locales }`, read with
`cmd locale get-app-locales` for the user the tool resolves; the port writes the list
back with `set-app-locales` (an empty list clears the override) and reads it back. Below
Android 13, with more than one running user (successive calls could resolve different
users under the one app-keyed row), or when the user or list cannot be read, the prior is
unobservable and the row forces fallback, as does the device-wide locale. A failed non-critical Android settings restore escalates
unless a single post-loop re-read of its namespace confirms the baseline value; any
differing key forces fallback. Critical settings restore failures force fallback immediately.
Preferences are skipped by replay and require fallback unless their JSON key
identifies an app absent from the readable baseline inventory, which cleaning
uninstalls with its data. The exception is a `setPreference` `systemProperty` row
(no appId): replay runs `setprop` with the journaled prior and succeeds only when
`getprop` reads it back. `setprop` cannot delete a property, so an absent prior is
restored as `""`, which `getprop` reads the same as absent (a `persist.*` name also
writes that empty value to disk). An unreadable prior, a name outside
`[A-Za-z0-9_][A-Za-z0-9_.:-]*`, `ro.*` (unchangeable once set), `ctl.*` and
`sys.powerctl` have no revert and force fallback, as does a failed read-back.

Android cleaning ends by comparing three baseline observations the session may change
outside the journal. The time zone (`persist.sys.timezone`) is restored in place with the
`clock:timezone` revert, `cmd alarm set-timezone` followed by a property read-back that
must match; a baseline without a zone, or a failed read-back, fails cleaning. The same
verified revert replays a journaled `clock:timezone` row (`changeLocalization` `timeZone`)
whose prior was readable. The device locale (`persist.sys.locale`) has no in-place restore
(cleaning a raw `system_locales` row does not apply it), so any difference fails cleaning.
AccountManager accounts are observed per user as a SHA-256 of the sorted `Account {...}`
rows `dumpsys account` lists (names never reach the journal); an unrooted shell can neither
remove nor re-add accounts, so a user whose set differs, an account list that cannot be
read at capture or reset, or a baseline without per-user account digests fails cleaning.
The check runs after package cleaning, because uninstalling a session-installed
authenticator removes its accounts; a user absent from the baseline compares against an
empty set.

Android volume rows hold live audio levels, which raw settings cleaning cannot
reach (AudioService persists `volume_*` rows but never reloads them), so they
require their journal revert. `mediaSession` volume journals `volume:<stream>`
(music, ring or alarm); a `pressButton` volume key journals `volume:key-press`,
the levels of every stream a key can adjust (voice call, system, ring, music,
alarm, notification, Bluetooth SCO, TTS (9), accessibility (10), assistant), because the
adjusted stream follows audio focus and call state. Priors come from
`cmd media_session volume --get` before the tool acts; any unreadable stream
makes the row unobservable. Older key-press journals missing TTS are rejected;
its prior level is never inferred. The revert attempts to set each stream back,
including accessibility, aliasable streams before the stream they alias, in one
device shell and succeeds only when every stream reads its level back. Sets use
`cmd audio set-volume <stream> <index>`, falling back to
`cmd media_session volume --set` only on an unsupported command, service or usage
response; permission and transport failures are not retried. Android may deny
the shell's accessibility write; its read-back must still match or the revert escalates.
A prior level of 0 is not restorable, because a muted stream reads 0 and a ring
level of 0 also changes the ringer mode; a positive ring level implies the normal
ringer mode, which setting it restores. Settings cleaning afterwards writes the
same `volume_*` values when the first journaled prior matches the baseline.
iOS volume presses keep a fallback intent. The app-owned interaction breadcrumbs
`preference:tool:setUIState` and `preference:focused-field` make no store claims.
Permission rows require a journal revert or fallback, including for apps absent
from the baseline: notification-policy access can persist for a never-installed
package. Android `setAppPermissions` runtime grants and revokes are the exception:
before the call, the host resolves the user the tool will act on (an explicit
`userId`, or the sole running primary user) and journals
`runtime:<user>:<package>:<permission>` with the grant read from `dumpsys package`,
which the port reverts with `pm grant`/`pm revoke --user`. `notificationsEnabled`
joins them as `POST_NOTIFICATIONS` only on a read API level of 33 or higher. An
ambiguous user, an unreadable API level or grant, the app-op path below API 33,
notification-policy access, the exact-alarm app-op and device-wide `reset` keep
escalating rows. Runtime rows for an app absent from the readable baseline
inventory are not journaled: cleaning uninstalls that app and its permission state.
An Android `postNotification` naming its `appId` journals `notification:posted:<package>`,
which the port reverts by force-stopping that app for every user (the system cancels
all of the app's notifications, including any it showed before the session) and
reading `cmd notification list` back: the revert succeeds only when every line is a
notification key and none names the package. Posting also persists a notification
channel (the caller's `channelId`, or the SDK default `automobile_test_notifications`),
which a force-stop keeps and the shell cannot delete, so the call also journals
`notification:channel:<package>:<channelId>`. Its prior is read before the post by asking
the app's SDK receiver (`NOTIFICATION_CHANNEL_QUERY`, an explicit `am broadcast` that
answers result 3 absent or 4 present). Only an `absent` prior is revertible: the port
broadcasts `NOTIFICATION_CHANNEL_DELETE`, sends the query again and requires both to
answer absent, then force-stops the app. A channel the app already had (the post may
have renamed it), an unreadable prior (including an SDK without the channel actions,
which answers 0) or a failed read-back escalates. Android keeps a deleted channel's
record and restores it if the app recreates the same id; no app-visible state differs.
The channel row is dropped when the session installed an app the baseline did not
hold, since uninstalling it removes its channels. A channel id outside
`[A-Za-z0-9_.-]{1,200}` journals the escalating `postNotification` app fallback
instead. A call without an `appId`, or with an `imagePath` (the image
upload can overwrite a baseline file under `/sdcard/Download/automobile`, which file
cleaning does not restore), keeps an escalating row.

On iOS, sanitize covers session-installed apps and app groups through inventory
cleaning, absolute keychain/permission/location/status-bar/clipboard resets,
certificate inspection that refuses surviving user-trusted roots, appearance,
content size, increase contrast and global locale/language/calendar/time-format
settings. Photo residue is inspected and forces erase when changed; keyboard and
increase-contrast defaults are restored and verified. `reduceMotion`, `boldText` and
unknown settings have no sanitize coverage. `shared-file` (`putAppFile`) app-container
writes into apps absent from a complete baseline installed-app inventory are covered
by sanitize uninstalling those apps and removing their private data. Other shared-file
rows still force erase. `opened-url` (`openLink`) also forces erase: it names no app,
and simctl listapps provides no URL-scheme handler ownership proof. So do the
frequent `rotate`, VoiceOver (`accessibility`), `postNotification`, keep-awake and
`windowMode` rows, whose effects persist. This deliberately fails closed until a
narrower proof exists.
Other non-revertible effects require erase. Non-fallback opaque rows and the app-owned
interaction breadcrumbs are exempt; non-revertible store preferences are covered
only for apps absent from the baseline inventory, whose data sanitize removes.

On Android, `putAppFile` app-container rows get the same proof: an app absent from
the readable baseline inventory is uninstalled by cleaning with its data. Android
`user_files` rows (writes, `namespace-reset` and the `indexMedia` `media` row) are
covered when they target user 0 (an omitted userId resolves to the current user,
so it counts only when the baseline lists user 0 alone) and the baseline's
`shared-file:download-entries` inventory of direct `/sdcard/Download` entries lacks
the namespace path. The session then cannot have overwritten or deleted baseline
files there: the public-root sweep deletes every file under the namespace, each
deletion media-rescanned, and cleaning then removes the namespace's file-free
directory tree with `rmdir`, failing cleaning when anything else remains. A
baseline without that inventory, another user, or a namespace present at baseline
escalates.
Production shared-file intents outside these proofs have JSON-array keys and
require a journal revert;
the public-root file sweep does not cover those intents. CtrlProxy keyboard rows
(`keyboard:tool:keyboard` and `keyboard:profile`) are not restored by settings
cleaning and require a revert. Power controls also require their verified journal
revert; baseline cleaning never covers `power:*`.

SMS, phone calls, SQL writes or unclassified queries, app-log deletion,
secondary-display rotation, iOS volume presses, Android manufacturer
profiles with kill/display facets (or unknown ids), and `deviceSnapshot` restore record
fallback opaque intents. Read-only SQL records nothing. iOS keep-booted also escalates to erase on the `fallback:` intents
recorded by volume presses, `sqlQuery` writes, `resetAppLogs`, `sendSms`, `phoneCall` and
`deviceSnapshot` restore.
A data-kept uninstall always retains its fallback intent, including for
a session-installed app, because the clean's package inventory cannot see removed
packages whose data remains. Plain uninstalls of session-installed apps absent
from the baseline remain covered; installs over baseline-held apps escalate.
Non-fallback opaque rows remain diagnostic breadcrumbs only where reset coverage
or transient effects justify them, including network mocks and iOS power/action
presses. Rejected, aborted/timed-out or hung release-time cleared-state pushes,
a missing CtrlProxy client, and iOS `noCapability`/`superseded` outcomes mark the
session recording gap before cleanup settles, escalating keep-booted reset. An
unconfirmed runner reply counts as delivered; Android delivery means the socket
write succeeded, with no device acknowledgement. Remaining residuals: a failed
in-session `clearMockNetwork` push leaves nothing owned at release, so nothing is
pushed or marked, and the gap map is in memory and keyed by session only.
Missing inventory coverage alone
does not block Android cleaning; uncovered journaled effects cannot silently
survive a clean reset (#15105).

**Recorder failure policy**: broker recorder binding/recovery failures, scope
mismatches and journal I/O failures warn and let the action proceed, but mark the
recorder owner's broker session as having an incomplete journal. Derived-label
sessions resolve their own recorder first, then recover the base recorder to learn
its device. When the base recorder resolves to a different device, the call needs
no recording and no gap. Failed base recovery still marks a gap on the base UUID,
even for a call on another device: deliberate fail-closed over-escalation.
Keep-booted reset must then use erase or Android baseline fallback. A matching
recorder also attempts a fallback opaque row, independently warning if that write
fails. The in-memory gap is keyed by session UUID and is lost on daemon restart;
the best-effort `recording-failed` row survives when the journal is writable.
Only a confirmed clean fallback clears the mark. Gaps for sessions that never
reach a keep-booted reset remain until process exit. A missing recorder for a non-broker session is expected
(no warning or gap).
Success keeps first-write-wins and record-before-act ordering; an aborted call
signal still prevents the action. Prior-value read failures warn and record
`unobservable` priors; reset applies its usual revert or baseline-coverage checks.

**Accepted residual**: the in-memory recording gap is not persisted, so an iOS session whose
journal was unwritable and whose daemon restarted before reset loses its gap mark
([why](../devlog/2026-10-23-session-broker-device-mutation-journal-unpersisted-gap.md)).
The best-effort `recording-failed` fallback row survives restart when the journal is writable,
and Android loses its in-memory baseline on restart and fails closed.
