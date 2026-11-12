# iOS simulator first-boot load: settled clones and a lean service profile

A freshly created iOS simulator burns a lot of CPU in its first minutes, almost all of it in Apple's own
processes (wallpaper poster and widget extensions, service start-up, `STExtractionService`, springboard,
logging). AutoMobile reduces it two ways: disabling launchd services before first boot (a pre-boot
lean profile, on by default) and booting a clone of a settled, shut-down template (opt-in).

## Sizing guidance

Size boot concurrency by CPU-seconds over the first 600 s (iOS 27.0, iPhone 18 Pro, 16-core host): a
first boot is about 775, about 442 with `minimal`, about 273 as a clone with `minimal`. k simultaneous
boots cost slightly more than k times that. A clone takes about 3 s to create. Boot gating still applies:
even clone + `minimal` takes about two minutes to go quiet. The capacity model charges 0.055 core per
settled simulator.

## launchd disabled database

The simulator's launchd keeps its disabled database on the host, in
`/private/var/tmp/com.apple.CoreSimulator.SimDevice.<UDID>/disabled.plist`, not in the device data
directory. Written before first boot (directory mode 0700, binary plist mapping label to `true`), it is
honored: `launchctl print-disabled system` inside the simulator lists the labels and no disabled job is
loaded. It survives shutdown, reboot and `simctl erase`, and is keyed by UDID, so clones do not inherit
it. Behavior across a host reboot is untested.

The post-boot path, `setDeviceResources`, runs `launchctl disable` and `bootout` for catalog services and
reports verification for the current boot only; services that started before it already burned CPU.

## Pre-boot lean profile

After creating a simulator and before its first boot, AutoMobile merges catalog labels into the disabled
database. New directories use mode 0700; existing directories and foreign plist keys are preserved.
Writes use a temporary file and atomic rename.

`AUTOMOBILE_IOS_PREBOOT_LEAN_PROFILE` selects the profile lazily at creation time. The default is
`minimal`; `none` opts out; unknown values warn and fall back to `minimal`.

| Profile       | Catalog resources                                                                                   | Labels |
| ------------- | --------------------------------------------------------------------------------------------------- | ------ |
| `none`        | none                                                                                                | 0      |
| `minimal`     | wallpaperRendering, widgets, liveActivities                                                         | 3      |
| `catalog-cpu` | minimal plus healthServices, photoAnalysis, assistantSuggestions, appleIntelligence, searchIndexing | 23     |

- Explicit disabled resources add their catalog labels; explicit enabled resources remove theirs from
  the selected profile. An empty label set does no label-database I/O.
- The write is best effort: errors warn and provisioning continues. Explicit resource requests still
  run through post-boot verification, which stays `current_boot`.
- After a simulator is deleted, AutoMobile removes that UDID's host directory best effort. Orphan
  directories of simulators already deleted are not swept.
- Disabled families lose their features by design (Siri, Health, wallpaper, widgets, push, App
  Intents). Speech/Siri and other extra daemons are not in any preset. There is no disable-all preset.
- `diagnosticd` must stay enabled: session logs and `getLogs` use `simctl spawn ... log show`.
- `calendarServices: "disabled"` is refused on a running simulator
  (`unsafe_device_resource_combination`): booting out `com.apple.calaccessd` while the Calendar app is
  connected makes MobileCal spin on its invalidated EventKit connection (#15218). Disabling it before
  first boot is safe. See `device-resources.md`.

### apsd log suppression

`AUTOMOBILE_IOS_SUPPRESS_APSD_LOG=1` (or `true`, trimmed, case-insensitive) suppresses `com.apple.apsd`
logs for newly created simulators before first boot. Default `false`, which writes nothing.

- It writes a dictionary plist at
  `<device set>/<UDID>/data/Library/Preferences/Logging/Subsystems/com.apple.apsd.plist`, with
  `DEFAULT-OPTIONS.Level.Enable` and `DEFAULT-OPTIONS.Level.Persist` both the string `off`. The device
  set is `CORESIMULATOR_DEVICE_SET_PATH` when set, else `~/Library/Developer/CoreSimulator/Devices`.
- The setting persists across reboots and is part of the clone template identity, so a template built
  with it on is never cloned for a flag-off request. Write failures warn; provisioning and label
  application continue.
- It hides apsd debug logs needed for push-flow debugging; remote push still works (no launchd job is
  disabled).
- Only the `com.apple.apsd` subsystem is covered. apsd also logs under shared subsystems
  (`com.apple.network`, `com.apple.PersistentConnection`, `com.apple.xpc`, `com.apple.CFNetwork`) and
  with no subsystem; those stay on because the shared subsystems serve every other daemon and
  uncategorized lines cannot be filtered by subsystem.
- No CPU benefit is claimed. To measure one, sample `ps` cputime deltas over 60 s for simulator
  `diagnosticd`, `apsd` and `logd`, and host `diagnosticd`.

## Settled template clones

`AUTOMOBILE_IOS_TEMPLATE_CLONE` defaults to off; `1`/`true` opts in. With it off, the clone path resolves
no template storage, locks or host version probes and starts no background build. With it on, both
creation seams use the same creation service; pre-boot profile application stays after identity binding
and before any workload boot.

### Keys and storage

- Templates are keyed by runtime identifier and build, Xcode build, device type and resolved default
  pre-boot profile. Xcode build discovery is cached once per process with a 5 s timeout; an unknown build
  disables cloning for that process. Runtime discovery uses the cached catalog.
- Manifests and per-key locks live in the host-global `~/.auto-mobile/ios-sim-templates`, independent of
  `AUTOMOBILE_COORDINATION_DIR`. The path follows `os.userInfo().homedir` (HOME under Bun), so daemons
  with different HOME values do not share templates. Templates built by older versions under a custom
  coordination directory are not migrated; they are rebuilt.
- Changed build inputs select a new key without deleting other Xcode installations' templates in the
  foreground. Builds replace inconsistent manifests only under their own key lock.
- Only names matching `^automobile-template-[0-9a-f]{8}$` are hidden from device projections and
  auto-start; they stay in the raw fleet capacity inventory.

### Cloning

- A ready template must be shut down and match the current Xcode and runtime builds. Manifest UDIDs are
  validated, and cloning requires a fresh raw row with the exact key-derived name and Shutdown state.
- Successful clones only read template state; deletion and manifest mutation take the build lock.
- Clone failures fall back to fresh creation, deleting only newly appeared matching work simulators
  first. A failed clone keeps a still-present, exactly named Shutdown template ready on its first
  failure; two consecutive failures for that UDID mark it stale; a successful clone resets the count.
  Cancelled requests do not count. Missing or renamed templates are stale immediately; present, exactly
  named non-Shutdown templates stay ready and the request uses plain creation.

### Clone relocation

A booted simulator's data directory records absolute paths containing its own UDID, and `simctl clone`
copies them verbatim: the LaunchServices store (`var/db/lsd/*.csstore`) maps every system app to a data
container under the template's directory, and about 130 other files and ten symlinks carry the same
UDID. Unrelocated, a clone shares Safari and system-app data (tabs, history, cookies, website data) with
its template and other clones (#15327). Clones of never-booted simulators do not have this problem.

After `simctl clone` and before any boot, `SimulatorCloneRelocator` rewrites the template UDID to the
clone UDID in place (both are 36 bytes, so file layouts stay intact) in every regular file and symlink of
the clone's data directory except the unified-log archives under `var/db/diagnostics`. Each non-empty
SQLite WAL is first folded into its database with `sqlite3 <db> "PRAGMA wal_checkpoint(TRUNCATE)"`,
since WAL frames carry checksums. A relocation failure deletes the clone and falls back to a plain
create. Relocating a 2 GB data directory takes 3 to 10 s.

### Template builds

- A missing template starts a background build without waiting for it. Builders are single-flight per
  key and use the shared boot admission instrumentation; a build counts as an AutoMobile boot, so
  foreground boots can be refused retryably while it settles. Builders skip starting when the read-only
  capacity check reports no spare slot; a later creation retries.
- A build applies the selected pre-boot profile, boots, requires the 60 s trailing mean of measured CPU
  to stay below 15 percent of one core for 120 s (up to 900 s total), then shuts down and verifies
  before publishing ready. The threshold tolerates a steady background service's 1-20 percent sawtooth
  (#15294). Missing CPU measurements reset the quiet window. Expect a build of about 13 minutes,
  holding a boot slot.
- Failures delete partial templates and defer attempts exponentially from 60 s up to six hours,
  resetting the attempt count on success. Capacity refusal uses a fixed short delay without incrementing
  attempts or recording failure.
- Background builds detach from request performance tracking and receive a daemon lifetime signal;
  shutdown aborts the flight so partial-template deletion and lock release run. Cancelled builds clean
  up outside the cancelled request signal. Explicit CLI builds use SIGINT: an interrupted build removes
  its partial simulator, releases its lock, records no retry delay and exits 130 (#15312).
- With the host-global key lock held, building or failed templates whose UDID and exact name match are
  shut down best effort, deleted and rebuilt. Manifest-owned ready or stale templates that may be in use
  defer rebuilding and keep their manifest state. The build path never deletes untracked name matches.

### Maintenance

`auto-mobile --ios-templates build` builds a template. Cleanup shares the build lock and supports forced
manifest-owned removal (manifest-owned deletion re-checks the name). `--ios-templates clean --stale`
removes templates whose recorded Xcode or runtime builds differ from the current catalog;
`clean --all` and `clean --runtime <identifier>` also remove corrupt manifests and can remove untracked
name matches. Unreadable files cannot always be assigned to a runtime and are safe to remove without
deleting a simulator.

## Background

- [Simulator first-boot CPU measurements](../../../devlog/2026-10-24-simulator-load-reduction-measurements.md)
- [Lean profile and template clone defaults](../../../devlog/2026-10-24-simulator-load-reduction-defaults.md)
