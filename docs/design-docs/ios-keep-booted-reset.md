# iOS keep-booted reset (issue #14361)

Host configuration selects iOS reuse independently of Android:

```json
{
  "reuse": {
    "ios": { "mode": "keep-booted", "maxUses": 10, "fallback": "erase" }
  }
}
```

This fragment supplements the existing contractVersion, limits and defaults.
The other modes are `erase` and `off`. For `off`, omit maxUses and fallback.
Enabled modes default to fallback `erase`; `keep-booted` also accepts fallback
`destroy` (see below); maxUses defaults to 10 for
`keep-booted` and 20 for `erase`, and must be a positive safe integer. The
keep-booted cap bounds the residue that cleaning cannot see: every Nth release
erases the device instead (#15017). iOS reuse requires defaults.ios. The legacy
`reuseCleanDevices: true` selects iOS erase and cannot accompany keep-booted
or off. On Android-only hosts the legacy flag is accepted but inert. This does
not enable Android reuse or accept Android reuse keys.

## Best-effort cleaning, not isolation certification

The owner decision is to run cleaning operations, not require readback evidence
or certify every mutation kind. A successful keep-booted release reports
`outcome: clean`, `mode: keep-booted`, and step timings, then allows the broker
to publish idle. **Clean means the supported cleaning operations and health
check succeeded; it does not mean all simulator state matches its baseline.**
Incomplete or unobservable mutation kinds and baseline differences do not block
this path. There is no before/after baseline diff or all-kinds certification gate.

Before the first execution is exposed, optional baseline capture inventories
installed apps and supported display/localization settings. It does not reset
keychain, permissions, location, status bar or clipboard to certify them.
An inventory failure warns without failing acquisition, unless preparation's
deadline expires or ownership/cancellation fences fail. Capture uses the remaining
preparation budget, aborts native capture on deadline, and checks cancellation and
ownership before starting baseline persistence.
Failed or wholly unobservable captures are not saved as immutable baselines.
The first usable baseline remains immutable for its resource incarnation and
supplies only the apps/settings to retain or restore. Partial baselines with a
known installed-app inventory remain usable, including a captured empty app list.
Missing settings use simulator defaults. A missing or unobservable app inventory
makes app cleanup unsafe, so release takes erase before replaying journal writes
or removing apps. This is a cleanup prerequisite, not isolation certification.
Baselines are keyed by exact UDID and private scope/index/UDID incarnation, not
the binding's ownership-fence generation. Settling generation bumps retain the
baseline; replacement simulator UDIDs do not. Journal entries additionally carry
the execution session UUID. Old generation-keyed baselines are not migrated;
without a new usable baseline, release safely takes erase.

## Release operations

Each release that is not due for maxUses erase runs:

1. Exact-UDID Booted/type/runtime/OS inventory and ownership checks.
2. Journal reverts in reverse sequence order for entries with a supported revert.
   Unplannable entries are skipped and logged, not treated as a blocker. App and
   app-group journal entries defer to the baseline-aware app cleanup below to
   avoid duplicate uninstalls or removal of baseline apps.
3. A fresh app inventory, then terminate and uninstall only `ApplicationType: User`
   apps outside the installed-app baseline. System, Hidden and untyped apps are
   never targeted for removal or baseline app-group lookups. Remove user app-group
   containers unless their group ID or path is shared with a baseline User app, or
   their ID starts with `group.com.apple.`. Protected containers are retained and
   logged. Container paths must still be exact-UDID, normalized, non-symlinked
   direct children of that simulator's AppGroup directory. Baseline group IDs and
   paths are loaded only for saved `ApplicationType: User` records, once per
   sanitation, not once per session app. A shared path
   among session apps is validated and removed once, avoiding duplicate ENOENT failures.
4. Unconditionally run `simctl keychain <udid> reset`,
   `simctl privacy <udid> reset all`, `simctl location <udid> clear`, and
   `simctl status_bar <udid> clear`. Clear the pasteboard with empty `pbcopy`
   input, including previous non-text content. Then read the simulator TCC.db
   for rows in simctl-managed privacy services. Reset each surviving client with
   `simctl privacy <udid> reset all <bundle>`: a bundle-less reset left a
   preinstalled app's grant on iOS 27 (#14787). Rows remaining after the per-bundle
   resets, or a failed read, are a cleaning failure and fall back to erase.
5. Restore appearance, content size, increase contrast and global locale/language
   preferences, including calendar and 12/24-hour overrides, from the baseline.
   Without a valid captured value, use light appearance, large content size,
   disabled increase contrast, and remove explicit global preference overrides
   so simulator defaults apply. Already-absent preference deletion and
   already-exited app termination are successful no-ops, not cleaning failures.
6. Compare out-of-band state against the baseline captured at first use: the Photos
   originals (`Media/DCIM`), device and Safari `Documents`, the user-configurable
   `com.apple.Preferences` Keyboard\* defaults, and the `com.apple.Accessibility`
   defaults `DarkenSystemColors` and `PointerIncreasedContrastEnabled`.
   `simctl ui increase_contrast` writes the two accessibility defaults and leaves
   them at 0 when contrast is turned off, so a pool simulator that never had them
   gains them (#15017). Added Documents/Safari files are removed and changed or added
   defaults are restored or deleted. Added or missing photos, missing files, a baseline
   without these inventories, and residue that survives the revert are a cleaning
   failure and fall back to erase.
7. Check fresh exact-UDID Booted/type/runtime/OS inventory and the existing
   device-identified automation health endpoint. Only then report clean.

Native commands have a 10-second bound. Journal loading, inventory, individual
journal reverts, sanitation and health each have a 30-second deadline; the
sanitation deadline also bounds filesystem and pasteboard work. Ownership is
checked before and after operations and again before idle publication. Timings
include individual native commands, app-group removal, pasteboard work, journal
reverts, sanitation and health.

A cleaning command error or failed health check triggers the existing erase
fallback, without waiting for three failed attempts. Timeout aborts subsequent
cleaning. Pending operation promises and unconfirmed pasteboard child teardown
keep the resource cleanup_pending until they settle; within the same resetter
instance, redrive then goes directly to erase. This is **promise-level fencing**:
simctl may reject on timeout/abort before its killed child exits, so erase can
overlap that child's native teardown. The existing simctl settlement grace is
not enabled here: it is private, timeout-only and best-effort, not an exit fence.
Erase reasons and pending promise tracking are in memory, not durable. After
daemon restart, redrive can rerun keep-booted cleaning rather than resume a saved
erase intent; durable binding/execution ownership still gates native reset.
Ownership loss never publishes idle or permits an unfenced erase. Production
shutdown does not abort an already-started native reset: it cancels queued erase
work and prevents idle publication after the native reset finishes. Explicit
reset callers may supply a cancellation signal, but that is not the broker's
shutdown path. Journal storage failures are release failures, not cleaning
failures; a real journal-load deadline is retryable and stays cleanup_pending
while the read is unsettled, rather than destroying the device or invoking erase.
Successful fallback reports `fallback:erase`, mode `erase`, its initial reason,
and cleaning plus erase phases. Failed erase uses existing destruction/pending
classification, including boot-capacity redrive.

With fallback `destroy`, every path above that would erase (a cleaning failure,
a missing installed-app baseline, an opaque row that forces fallback, a redrive
after a cleaning failure, and every `maxUses`-th release) returns outcome
`fallback:destroy`, mode `keep-booted` and its reason without calling the erase
port or taking a ResetBootQueue slot. The broker never publishes that simulator
idle: it deletes it through the normal destroy path, the receipt settles as
`destroyed` and keeps the reason, and the next acquisition creates a fresh
simulator through boot admission. `maxUses` then means "destroy after N uses".
A redrive after a daemon restart does not resume as an erase.

Total lifetime uses equal durable reuseCount + 1. Each multiple of maxUses still
takes erase, without resetting the counter. Only erase reserves a ResetBootQueue
slot. Keep-booted runs outside that queue. Readiness admission and wakeups retain
their existing ownership, wait bounds and committed-idle-state requirements.

## Limits

- Photos, Contacts and Calendar additions are **not removed**. Unsupported
  journal entries and out-of-band mutations can persist between executions.
- Baseline apps are not uninstalled or reset to original app-data contents.
  Their shared app groups, orphan groups and unknown shared files can persist.
- Keychain secrets and privacy grants are reset, not restored to captured values.
  This can affect baseline apps. Global permission reset is not permission setup.
- Display/localization writes do not prove running processes refreshed caches.
  VoiceOver, orientation, keyboard dictionaries, clock/time-zone state, network
  shaping, biometric enrollment, profiles, certificate trust, accounts and
  arbitrary URL-handler effects are not comprehensively restored.
- Booted inventory plus an automation probe is the existing availability check,
  not proof of SpringBoard responsiveness or full native isolation.

Use `erase` when a fresh simulator is required. No contamination-isolation or
latency acceptance criterion is claimed for best-effort keep-booted cleaning.
