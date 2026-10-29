# Device mutation journal and baseline reset contract

## Delivery boundary

Contract, persistence, planning and tool-recording slice of #14359 under #14358.
It does not change keep-booted reset admission; iOS (#14361) and Android (#14364)
own platform cleaning and reset wiring.

`DEVICE_MUTATION_TOOL_COVERAGE` assigns every control tool one status:
`journaled` (production dispatch attempts record-before-act), `pending-adapter`
(no production adapter yet), `notJournaled` (intentional host-only or transient
UI/prompt exemption). Pending/exempt entries carry reasons; a registry
enumeration test (including mixed, hidden and SDK tools) rejects a new control
tool without a justification. Neither `pending-adapter` nor `notJournaled` implies
journaling.

- Journaled data/provider adapters include `setKeyValue`,
  `removeKeyValue`, `clearKeyValueFile`, `setPreference`, `sqlQuery`,
  `mockNetwork`, `clearMockNetwork`, `sendSms`, `phoneCall`, `resetAppLogs`,
  `deviceSnapshot`.
- Appearance adapters journal `statusBar` overrides and Android `manufacturerProfile`
  application. Keyboard-only personas record `keyboard:profile`; kill/display facets
  also record a fallback opaque intent because their in-memory restore receipts
  bypass the recorded dispatcher. Missing or unknown persona ids defensively record
  fallback intent too; the tool schema enum normally rejects them. Intent is recorded
  before the handler runs, so an `apply` later refused (for example
  `route_to_real_device`) still falls back; this is an accepted cost.
- Recording and reset use one typed `mutationIncarnation` constructor. Android
  uses `[resourceId, stableDeviceId, bootId]`; iOS retains
  `[scopeKey, allocationIndex, stableDeviceId]`. Android binds an interim null
  boot ID at readiness, then rebinds the recorder with the captured boot ID before
  applying the device profile. Session UUIDs isolate successive session rows.
- Reset checks for journal rows from the same device and session under different
  incarnations and fails closed, including legacy Android generation-shaped rows.
  No migration is needed: daemon restart loses the Android in-memory baseline and
  already fails closed; resource retirement prunes old tuples by element zero.

Keep-booted resets run baseline cleaning unconditionally when journal checks allow
it. Fallback-prefixed opaque rows force baseline fallback. Unrevertible journal
rows also force fallback unless baseline cleaning already restores their effects.
On Android this covers packages, clipboard, rotation, screen reader, keep-awake,
raw global/system/secure settings, verified display rows (`density`, `nightMode` and `display:*`),
opened URLs and launched preinstalled apps (below), and screen state via the next wakeAndUnlock.

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
it does not say what the row held. changeLocalization's
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
uninstalls with its data.

Android cleaning ends by comparing three baseline observations the session may change
outside the journal. The time zone (`persist.sys.timezone`) is restored in place with the
`clock:timezone` revert, `cmd alarm set-timezone` followed by a property read-back that
must match; a baseline without a zone, or a failed read-back, fails cleaning. The same
verified revert replays a journaled `clock:timezone` row (changeLocalization `timeZone`)
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

**ACCEPTED-RESIDUAL**: the in-memory recording gap is not persisted. The only durable
store is the same SQLite registry the journal uses: a marker table would fail with
an unwritable journal and require a registry migration, advancing the schema
boundary older daemons refuse. The best-effort `recording-failed` fallback row
already survives restart when the journal is writable. Android loses its in-memory
baseline on restart and already fails closed. The residual is an iOS session whose
journal was unwritable and whose daemon restarted before reset.

## Identity and persistence

`SqliteBindingRegistry.deviceMutationJournal()` shares the host registry SQLite
connection. Migration `2026_10_21_012_device_mutation_journal` adds
`device_mutation_journal` and `device_mutation_baselines` to the store's static
migration set (not the per-daemon database migrations).

- Identity is `(sessionUuid, deviceId, incarnation)`. The incarnation must be a
  durable native resource generation that survives restarts and changes when the
  device is replaced; a process-local counter or reusable serial is insufficient.
  Baselines are shared across sessions of one incarnation, never across
  replacements.
- `applyJournaledMutation` is a standalone helper with no production dispatch
  caller. First write per `(scope, kind, key)` wins. `appliedAt` stamps intent, not
  device acknowledgement. SQLite's sequence gives deterministic reverse order
  regardless of clock. Failed/ambiguous mutations keep their intent so recovery
  can retry.
- Prior value is a tagged JSON value: `{ state: "absent" }` is distinct from JSON
  null and the string `"absent"`. Unknown kinds stay durable and are
  non-revertible in the planner (schema evolution must not discard them).

## Platform port obligations

- `DeviceMutationResetPort.canRevert` qualifies kind, key and prior payload.
  `revert` sets the original absolute state, tolerates already-absent resources,
  and is idempotent on replay. Compound priors may carry app-group identities or
  legacy restore metadata; adapters preserve platform-required ordering inside a
  step and may map steps to apply/verify/revert profiles (#14067). The contract
  contains no platform commands.
- Every device I/O dispatch awaits `context.assertOwned()` immediately before
  acting and honors `context.signal`, including after queued or delayed awaits.
  The runner checks ownership before each phase/step and after verification, and
  enforces one total budget via the injected Timer and an abort signal. A timeout
  does not stop an uncancellable native command: the adapter must fence or drain it
  before physical reuse.
- Keep-booted bounds journal capture to the 30 s cleaning budget (or remaining
  preparation deadline if shorter); other strategies and fallback capture get the
  remaining preparation deadline. Fallback has its own budget and abort signal.
  After timeout/cancel the owner awaits cleaning/fallback settlement with a separate
  2 s drain; an adapter that never settles exhausts it and fails without starting
  snapshot fallback, permitting destruction. Resource pruning is best-effort:
  database failures warn without retaining in-memory sessions or skipping teardown.
- The standalone runner returns `non_clean` for unknown kinds, incomplete state,
  missing baselines, ownership failures, timeout, failed writes or failed readback.
  It is not a keep-booted gate and does not replace or prevent platform cleaning.

## Baseline capture and verification

Capture with `captureFirstDeviceBaseline` under the reset ownership fence before the
first session uses a newly admitted pool device; first-write-wins, never replacing a
trusted baseline with an already-mutated device's state. Callers bound initial
capture like other admission work.

- A snapshot holds `(kind, key, value)` observations, `completeKinds`, and explicit
  `unobservable` reasons. A complete inventory is exhaustive (omitted key = absent,
  not unknown). For the standalone runner every `DEVICE_MUTATION_KINDS` entry must
  be complete or explicitly unobservable; omission, missing/changing inventories,
  duplicate keys and unobservable state prevent its certification even when values
  match. Apart from the Android time zone, locale and account checks above, none of
  this gates or forces fallback in keep-booted resets.
- Complete device settings cover all default-setting keys plus locale/appearance.
  Adapters must report blind spots (app data/containers, changes induced by UI, raw
  commands or the app under test) rather than call a partial scan complete; a cheap
  snapshot is not a complete erase substitute.
- The diff detects changes outside the tool surface. Only an app absent from the
  baseline and an originally empty clipboard have generic revert rules (still
  needing a qualified port); all other unjournaled changes are dirty. Journal
  entries replay in reverse durable order, then generic steps; the standalone runner
  returns `clean` only when a fresh authoritative snapshot equals the baseline (a
  write receipt is not enough).

## Legacy adapters and remaining wiring

- `importLegacySessionMutations` imports the six legacy cache restore payloads
  without clearing slots. The iOS network payload keeps the app rule's
  owner-generation/revision metadata; its adapter must allocate a newer reset
  revision via the provider protocol, not replay an old one. Import is
  terminal-only: callers stop admission, drain session mutations and provide
  `assertQuiesced` under the lifecycle fence, awaited before snapshotting and
  before every write. A conflicting reimport throws rather than keep stale metadata
  in a first-write-wins row. It is not a live write-through adapter or a gate.
- Legacy-restorer import (AC3) is deferred: shared `device` keys hold incompatible
  values (tool clock priors `{ instant, automaticTime }` vs `ClockSessionState`
  `{ initialAutomaticTime, clockChangedByUs, rootedByUs }`; tool network priors
  `values ?? observedValues ?? profile` vs `{ initialProfile, iosAppRule }`), which
  would fail the deep-equality check, and a captured clock instant ages before
  restore. Normalization and clock-restore semantics must be resolved first.
- `JournalDeviceSettingDefaultsPersistence` wraps the defaults store: broker writes
  first record setting originals and broker reads use the journal's first value; a
  null broker scope delegates unchanged. Legacy null (unset) maps to `absent`.
  Legacy records stay for retry/next-acquisition behavior; legacy deletion does not
  remove journal data. The defaults service still swallows some persistence
  failures (legacy best-effort), while broker tool execution separately warns and
  proceeds on journal failure.
- These adapters are opt-in and not wired into the session manager or tool handlers,
  so non-broker release is unchanged. Setup writes, readiness side effects, seeders,
  direct shell commands and pending adapters are incomplete journal coverage, not
  reuse prerequisites.
- Keep entries through interrupted/failed resets and final clean publication. Only
  the reset owner calls `deleteSession`, after verified cleanup and fenced broker
  settlement. Retirement pruning of baselines/journals and per-session recorder
  rows is follow-up (no fenced native retirement owner yet; pruning during capture
  could delete recovery state for an active incarnation). Baseline and prior
  payloads may contain sensitive device data: never log or report them.

## Tool-surface recovery and compatibility

**Data stores**

- Identities keep app, store, Android user selector and key; set/remove and
  `name`/`fileName` aliases share a first-write identity. iOS key-value
  standard-store aliases (empty name, case-insensitive `standard`, bundle ID) and
  UserDefaults standard-suite aliases (omitted suite, `Standard`) share one.
  Android omitted vs explicit `userId` are not merged (default user is resolved
  dynamically, not necessarily 0). Identities are not merged across tools:
  `setKeyValue` and `setPreference` on the same file get separate rows, so a future
  restorer must not assume otherwise. Store clearing records observed entries under
  a separate whole-store key.
- Key-value priors use a connected SDK's storage read path (encoded value and type
  preserved). Missing key = `absent`; an empty store is `present` with no entries,
  not proof the file was absent. Unconnected providers, redacted/unknown entries and
  explicitly user-scoped Android calls record `unobservable`. Preference priors reuse
  `AppPreferences.getPreference` (value, type, resolved user/store); redacted, lossy
  or possibly stale container-plist reads are `unobservable`. Read failures warn and
  still record intent.
- SQL uses the read-only classifier: proven reads do not journal; mutations and
  unproven statements record opaque intent (no inferred inverse). Network mocks
  share a non-fallback opaque breadcrumb: NetworkState owns the rules, and session
  release clears them and pushes the cleared set to the device. Android and iOS SDK
  rule stores use process memory only, so reset's reboot/app termination drops them.
  Accepted residual, not a journal concern: a release-time cleared-state push that
  fails, times out or is skipped while an SDK app keeps running leaves stale rules
  until the next sync or app restart. This is best-effort cleanup, the same class
  as every session-release cleanup. Telephony, log
  deletion (including rotated siblings) and snapshot restore record fallback opaque
  intent; snapshot capture/delete retain diagnostic opaque rows. None implement restorers or change cleaning; unreadable priors never block
  the action.

**Other tools**

- Journaled non-read calls with an empty adapter result record opaque
  `unobservable` intent. `screenLock` can capture an unsecured baseline but not an
  existing secure credential, so it records `unobservable` without storing secrets.
  `power` records `unobservable` because its restore registry (`restoreReceipt`,
  `powerRestore`) owns the priors. Prior reads are skipped when the scoped
  `(kind, key)` already exists (one journal list per call). Rotation and
  screen-reader keys use `device`, matching legacy adapters; iOS rotation records
  `unobservable` rather than invent portrait or read Android orientation.
- Keyboard open/close and biometric match/fail/cancel/error are `notJournaled`
  transient UI. Keyboard `setProfile` persists typing policy and records the
  `listProfiles` active profile under `keyboard:profile` (or `unobservable`);
  `tapImeKey` records opaque `unobservable` since a failed IME restore can leave the
  device switched. Selecting an installed IME and changing enrollment stay
  journaled.
- Install intents resolve the artifact's package/bundle identifier via the existing
  metadata readers. In this slice `installed-app` priors needing an incarnation
  baseline are `unobservable` (recorder scope does not match baseline/reset scope);
  unknown metadata or incomplete inventory also records `unobservable`, never
  blocking install or cleaning. Install and uninstall keys share the baseline app
  identity when metadata is readable.

**Recovery**

- Uses the registry's unique session-id index, not an all-receipts scan. Startup
  warns and continues for an unrecoverable session, marking a recording gap so its
  later mutations run unrecorded but its next keep-booted reset falls back. A fatal startup error closes the broker before releasing the host
  lock. A rebound session discards its old recorder and resolves the new native
  assignment before the next mutation.
- Derived-label sessions resolve their own recorder first (live session, then broker
  recovery). Without one, they resolve the base recorder the same way and use it
  only on the base's device; journal writes and gaps belong to that base UUID.
  When the base recorder resolves to a different device, the call needs no recording
  and no gap. Resolution must recover the base to learn its device, so failed base
  recovery still marks a gap on the base UUID even if the derived call lands on
  another device; this is deliberate fail-closed over-escalation.
- `recoverSessionMutationRecorder` returning undefined for an active request with no
  live session is safe: the next call from the rehydrated session recovers again.

**Schema compatibility**: the `unobservable` tag is a compatibility boundary within
the current registry schema version: older daemons that accept the migration but not
the tag fail closed when listing those rows. Upgrade all daemons sharing a host
registry before new writers run; never discard or reinterpret an unknown prior as
absent. Migration 012 itself advances the boundary, so an older daemon refuses the
upgraded store; do not weaken the unsupported-schema check.
