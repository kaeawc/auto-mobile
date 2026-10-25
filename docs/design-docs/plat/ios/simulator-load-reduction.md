# iOS simulator first-boot load: settled clones and a lean service profile

Measurements from #15097 inform the template-clone and preboot lean profile paths; #15219 measured concurrent first boots, idle drift
and the product path, and its results set the defaults (see the Defaults section).
All numbers are from one host (16 cores, macOS 26, Xcode 27) and iOS 27.0 / iPhone 18 Pro.

## Question

A freshly created iOS 27 simulator burns a lot of CPU for its first minutes, almost all of it in Apple's own
processes. AutoMobile measures this cost (the fleet-cost doc) and gates boots, but cannot reduce it.
Two options were measured: boot a clone of a settled, shut-down template instead of a brand-new device, and
disable launchd services inside the simulator before it first boots (a "lean profile").

## Method

- One measured simulator at a time, named `lean15097-*`, deleted afterwards. Host CPU busy below 20 percent
  (two consecutive reads) before each boot. The protected CI simulator stayed booted and idled at 15 percent
  of a core.
- The sampler records, every 5 seconds for 600 seconds after `simctl boot` returns, the CPU of every process
  under the simulator's `launchd_sim`. CPU is read with `proc_pid_rusage` as own time plus the time of
  children already reaped, so short-lived XPC services that exit between two samples are still counted. A
  0.25 second process scan attributes CPU to process names; what the scan misses is reported as
  "unattributed" (under 12 CPU-seconds per run, about 30 in the two disable-everything runs).
- Nothing from AutoMobile ran during a window: no daemon, no CtrlProxy runner. The numbers are the operating
  system's own cost. Sampler overhead was 4 to 9 percent of one core.
- Breakage check: a private daemon (own data, log, database, coordination and aux-socket directories, explicit
  port, every call naming the deviceId) ran 14 steps after the window: runner start, runner process present,
  observe, screenshot, launch and terminate of Settings and Safari, tapOn, sendKeys with the typed text read
  back through observe.
- Conditions: baseline (create and boot), clone (boot of a clone of a settled template, new device id), lean
  (profile disabled either before first boot or right after `simctl boot` returns), clone plus lean. Two or
  three runs per condition; single runs for the per-family screen.

## Results

CPU-seconds is the total over the 600 second window. Time-to-quiet is the first time the trailing 60 second
mean CPU drops below 5 percent of one core, so it includes that 60 second window.

| condition                                        | runs | CPU-s in 600 s   | vs baseline | time-to-quiet s   | peak % of a core | last-120 s mean %   | processes spawned | peak footprint MB | breakage check  |
| ------------------------------------------------ | ---- | ---------------- | ----------- | ----------------- | ---------------- | ------------------- | ----------------- | ----------------- | --------------- |
| BASELINE: create + boot                          | 3    | 789 (758-827)    | +0%         | 200 (1 run never) | 1334 (1279-1365) | 8.4 (4.6-15.6)      | 432 (405-466)     | 3307 (2919-3623)  | not run         |
| CLONE of settled template                        | 3    | 427 (417-446)    | -46%        | 122 (115-130)     | 1395 (1380-1403) | 4.1 (3.8-4.6)       | 314 (309-322)     | 2648 (2553-2799)  | all 14 steps ok |
| LEAN catalog-cpu, post-boot (harness emulation)  | 2    | 430 (430-430)    | -46%        | 160               | 1226 (1226-1226) | 5.9 (3.7-8.2)       | 334 (332-335)     | 1820 (1808-1832)  | all 14 steps ok |
| LEAN catalog-cpu, pre-first-boot                 | 2    | 398 (394-402)    | -50%        | 150 (140-160)     | 1267 (1258-1277) | 5.9 (3.8-8.0)       | 275 (273-277)     | 1812 (1810-1816)  | all 14 steps ok |
| LEAN cpu-plus, pre-first-boot                    | 2    | 306 (302-309)    | -61%        | 142 (135-150)     | 1268 (1253-1284) | 5.1 (3.7-6.4)       | 244 (241-247)     | 1560 (1550-1570)  | all 14 steps ok |
| CLONE+LEAN catalog-cpu                           | 2    | 245 (244-245)    | -69%        | 130               | 1303 (1287-1319) | 7.6 (3.7-11.4)      | 243 (239-247)     | 1566 (1558-1573)  | all 14 steps ok |
| CLONE+LEAN cpu-plus                              | 2    | 222 (220-223)    | -72%        | 122 (115-130)     | 1257 (1201-1313) | 3.5 (3.4-3.7)       | 216 (214-217)     | 1333 (1330-1335)  | all 14 steps ok |
| LEAN everything (catalog-all + x-all), post-boot | 2    | 1230 (1228-1232) | +56%        | never             | 1233 (1207-1260) | 145.1 (144.5-145.6) | 438 (431-444)     | 1725 (1718-1732)  | all 14 steps ok |

Charts were produced for the run but are not committed (binary assets). Described in words:

- Total CPU against time, one line per run, one colour per condition: every condition starts at about 1300
  percent of a core. Baseline stays above 1000 percent for 40 to 55 seconds and above 200 percent until 75 to 110
  seconds. Clone and the lean profiles drop below 200 percent after 30 to 50 seconds (clone plus lean
  `catalog-cpu` and lean `cpu-plus` at about 30 to 35 seconds). After that all conditions idle at roughly 2 to 6
  percent (about 9 percent in baseline run 3), with a short bump near 300 seconds in every run, caused by
  `AuthenticationServicesAgent` and `passwordbreachd` (5 to 10 CPU-seconds). The disable-everything condition
  never settles and stays near 145 percent of a core for the rest of the window.
- Cumulative CPU-seconds against time: baseline climbs to about 790, clone to about 430, lean `catalog-cpu` to
  about 400, clone plus lean to about 220 to 245, with most of the difference made in the first two
  minutes (75 percent of the baseline-to-clone gap by 60 seconds, 97 percent by 120).
- Stacked CPU by process family for one run each: in baseline the first minute is dominated by wallpaper poster
  extensions and widget extensions, then the `xpcproxy_sim` bucket (see the note below), `STExtractionService`,
  springboard and logging; clone removes most widget and `STExtractionService` work but keeps the poster
  rendering; the lean profile removes posters and widgets entirely.

Mean CPU-seconds per process family:

| family                                                  | baseline                                 | clone                         | lean `catalog-cpu` (pre-boot) | clone plus lean `cpu-plus` |
| ------------------------------------------------------- | ---------------------------------------- | ----------------------------- | ----------------------------- | -------------------------- |
| wallpaper posters (Poster extensions, PosterBoard)      | 121                                      | 120                           | under 5                       | under 5                    |
| widget extensions (Widget, chronod, News)               | 101                                      | 20                            | under 5                       | under 5                    |
| `xpcproxy_sim` stub (see note)                          | 120                                      | 50                            | 60                            | 49                         |
| `STExtractionService`                                   | 32 (about 47 in the 2 runs that name it) | under 5                       | 40                            | under 5                    |
| springboard and UI                                      | 50                                       | 28                            | 36                            | 20                         |
| logging (`diagnosticd`, `logd`)                         | 48                                       | 27                            | 26                            | 11                         |
| indexing and analysis                                   | 46                                       | 20                            | 21                            | 12                         |
| calendar, contacts, accounts                            | 30                                       | 25                            | 26                            | 19                         |
| `amsengagementd`                                        | 23                                       | 11                            | 21                            | 10                         |
| shortcuts runner                                        | 20                                       | under 5                       | 22                            | under 5                    |
| speech, health, Metal compiler, `SetStoreUpdateService` | 14, 19, 13, under 5                      | 14, under 5, under 5, under 5 | under 5                       | under 5                    |
| other                                                   | 148                                      | 101                           | 129                           | 92                         |

Attribution caveat: the sampler names a process once, at first sight, and `xpcproxy_sim` replaces itself with the
target service in the same process. Services first seen before that switch have their CPU and spawn counts filed
under `xpcproxy_sim`. Baseline run 3 shows it: `STExtractionService` is 0 and the stub bucket is 186 CPU-seconds
against 82 and 91 in runs 1 and 2. Treat the stub bucket as "service start-up CPU that could not be named", not as pure
process-launch overhead, and per-service spawn counts as lower bounds. Total CPU is unaffected.

The culprits named in the issue look different on this host: `SetStoreUpdateService` is 12 to 13 named spawns and
under 5 CPU-seconds, `MTLCompilerService` about 13 CPU-seconds (27 to 38 spawns). In CPU-seconds the cost is led by the poster
and widget extension families, then the stub bucket, `STExtractionService` and `diagnosticd`; by process count most of
the roughly 430 processes spawned per first boot are small services in the "other" bucket.

Single-family screen (disabled before first boot, one run each):

| family disabled (single run each) | CPU-s | vs baseline | time-to-quiet s |
| --------------------------------- | ----- | ----------- | --------------- |
| res-appleIntelligence             | 796   | +1%         | 205.0           |
| res-assistantSuggestions          | 804   | +2%         | 205.0           |
| res-healthServices                | 780   | -1%         | 200.0           |
| res-searchIndexing                | 798   | +1%         | 190.0           |
| res-wallpaperRendering            | 591   | -25%        | 155.0           |
| res-widgets                       | 608   | -23%        | 160.0           |
| x-setstore-clients                | 742   | -6%         | 275.0           |
| x-speech-siri                     | 687   | -13%        | 165.0           |

Each family was run once and baseline itself spans 758 to 827, so differences of about 6 percent or less (setstore
clients) are within run-to-run noise. Posters, widgets and speech/Siri clearly move the 10 minute CPU; health, search
indexing, assistant suggestions and Apple Intelligence show no effect on first-boot CPU. They may matter for idle
drift, which was not measured. `liveActivities` was only measured as part of `catalog-cpu`.

## Mechanics

- AutoMobile already ships a post-boot version of the lean profile: `setDeviceResources` runs
  `launchctl disable` and `bootout` for the services in the iOS resource catalog, and reports verification for
  the current boot only. The harness emulation used here (bare disable plus bootout, started about a second after boot returned)
  took 24 seconds for 23 labels; the shipped controller also reads inventory and verifies each service, so the real
  post-boot path is slower and the saving below is a lower bound. Services that start in that window already burned CPU.
- The simulator's launchd keeps its disabled database on the host, in
  `/private/var/tmp/com.apple.CoreSimulator.SimDevice.<UDID>/disabled.plist`, not in the device data
  directory. Writing it before first boot (create the directory with mode 0700, write a binary plist mapping
  label to true) is honored: `launchctl print-disabled system` inside the simulator lists the labels and no
  disabled job is loaded. It saves a further 32 CPU-seconds over the post-boot path (398 against 430).
- That file survives shutdown, reboot and `simctl erase` (23 of 23 and 45 of 45 labels stayed disabled with
  zero loaded jobs after each), is keyed by device id, so a clone should not inherit it (inferred from the path; the harness always
  re-applied the profile to clones, and no clone was booted without it), and it was still present for 29 of the 29
  simulators the harness deleted. Behavior across a host reboot was not tested.
- A settled simulator's reboot still costs about 195 CPU-seconds in the first 150 seconds with `catalog-cpu` (176
  with `cpu-plus`) and an erase about 359 (270); a clone takes about 3 seconds to create. The template is a one-off
  cost: a plain first boot (815 CPU-seconds) plus about 250 to 340 seconds of sampling until quiet plus 120 seconds.

## Pre-boot lean profile

After creating a simulator and before its first boot, AutoMobile can merge catalog labels into
`/private/var/tmp/com.apple.CoreSimulator.SimDevice.<UDID>/disabled.plist` as a binary plist mapping
labels to `true`. New directories use mode 0700; existing directories and foreign plist keys are
preserved. Writes use a temporary file and atomic rename.

`AUTOMOBILE_IOS_PREBOOT_LEAN_PROFILE` selects the profile lazily at creation time. The default is
`minimal`; `none` opts out, and unknown values warn and fall back to `minimal`.

| Profile       | Catalog resources                                                                                   | Labels |
| ------------- | --------------------------------------------------------------------------------------------------- | ------ |
| `none`        | none                                                                                                | 0      |
| `minimal`     | wallpaperRendering, widgets, liveActivities                                                         | 3      |
| `catalog-cpu` | minimal plus healthServices, photoAnalysis, assistantSuggestions, appleIntelligence, searchIndexing | 23     |

Explicit disabled resources add their catalog labels; explicit enabled resources remove their labels
from the selected profile. An empty label set performs no host I/O. The write is best effort: errors
warn and provisioning continues. Explicit resource requests still run through the existing post-boot
verification, which remains `current_boot`.

The database survives reboot and erase and is specific to the UDID; clones do not inherit it.
After successful simulator deletion, AutoMobile removes that UDID's host directory on a best-effort
basis. Orphan directories belonging to simulators already deleted are not swept.

## Settled template creation

`AUTOMOBILE_IOS_TEMPLATE_CLONE` defaults to enabled; `0`/`false` opts out. Both creation seams use the same creation
service when wired for production; preboot application stays after identity binding and before any
workload boot. The disabled path resolves no template storage, locks or host version probes.

Templates are keyed by runtime identifier and build, Xcode build, device type and resolved default preboot
profile. Xcode build discovery is cached once per process with a five-second timeout; an unknown
build disables cloning for that process. Runtime discovery uses the cached catalog. Manifests and per-key locks live in the host-global
`~/.auto-mobile/ios-sim-templates`, independent of `AUTOMOBILE_COORDINATION_DIR`. A ready template must still be shut down and match the current Xcode and
runtime builds. Clone failures fall back to fresh creation. Deletion and manifest mutation take the build lock; successful clones only read template state.
Changed build inputs select a new key without deleting other Xcode installations' templates in
the foreground. Builds replace inconsistent manifests only under their own key lock.

A missing template starts a background build without waiting for it. Builders are single-flight
per key and use the shared boot admission instrumentation. They apply the selected preboot profile,
boot, require measured CPU below 5 percent of one core for 120 seconds (up to 900 seconds total),
then shut down and verify before publishing ready. Missing CPU measurements reset the quiet window.
Failures delete partial templates and defer attempts exponentially from 60 seconds up to six
hours, resetting the attempt count on success. Capacity refusal uses a fixed short delay without
incrementing attempts or recording failure. Builders skip starting when the read-only capacity
check reports no spare slot; a later creation retries. A template build counts as an AutoMobile
boot by design under the owner rule, so foreground boots can be refused retryably while it settles. Cancelled builds clean up outside the cancelled request signal.
Only names matching `^automobile-template-[0-9a-f]{8}$` are hidden from device projections and auto-start while remaining in
the raw fleet capacity inventory. Explicit template maintenance can build or clean templates;
cleanup shares the build lock and supports forced manifest-owned removal. `--ios-templates clean
--stale` removes host templates whose recorded Xcode or runtime builds differ from the current
catalog; `clean --all` and `clean --runtime <identifier>` also remove corrupt manifests. Unreadable
files cannot always be assigned to a runtime and are safe to remove without deleting a simulator.

Background builds detach from request performance tracking and receive a daemon lifetime signal;
shutdown aborts the flight so partial-template deletion and lock release run. Explicit CLI builds
use SIGINT cancellation. Manifest UDIDs are validated, and cloning requires a fresh raw row with
the exact key-derived name and Shutdown state. Manifest-owned deletion also requires a fresh name
check. Clone failure deletes only newly appeared matching work simulators before fresh creation.

Template storage follows `os.userInfo().homedir` (HOME under Bun), like the shared coordination
directory default. Daemons started with different HOME values do not share template manifests
or locks. Templates built by older versions under a custom coordination directory are not migrated
and are rebuilt. The build path never deletes untracked name matches; explicit cleanup can remove
them. Manifest-owned ready or stale templates that may be in use defer rebuilding and keep their
current manifest state. With the host-global key lock held, building or failed templates whose UDID
and exact name match are shut down best effort, deleted, and rebuilt. A failed clone keeps a still-present, exactly named Shutdown template ready on its first
failure; two consecutive failures for that UDID mark it stale, and a successful clone resets the
count. Cancelled requests do not count as clone failures. Missing or renamed templates are stale
immediately; present, exactly named non-Shutdown templates stay ready and use plain creation.

## Risks

- Disabling the entire resource catalog plus the extra candidates (104 labels, applied post-boot, 85 seconds) made
  the simulator spin at about 145 percent of a core for the rest of the 10 minute window (MobileCal 520
  CPU-seconds and `diagnosticd` 270), 56 percent more CPU than baseline. #15218 bisected it to one label:
  booting out `com.apple.calaccessd` (`calendarServices`) after boot, while the Calendar app is connected, makes
  MobileCal retry its invalidated EventKit connection in a tight loop and `diagnosticd` log it. The same label
  disabled before first boot (every resource, 104 labels, ran at 206 CPU-seconds) or one second after boot did not
  spin. The controller now refuses `calendarServices: "disabled"` on a running simulator
  (`unsafe_device_resource_combination`); see `device-resources.md`.
- The breakage check passed on every checked run, including the disable-everything run, but it covers only the
  driving surface. Siri, Health, wallpaper and widget behavior, push and App Intents are removed or degraded by
  design when their families are disabled and were not exercised.
- Clones need the per-device disabled database re-applied, and poster rendering reruns per device (120
  CPU-seconds) unless the poster service is disabled.
- Background (non-simulator) load during the windows was 1.6 to 2.4 cores, and the first-boot burst of about 13
  cores nearly saturates a 16-core host, so peaks are host-capped. That the same CPU-seconds stretch over minutes
  on a contended host (the "5 to 8 minutes" seen earlier) and that the ratios between conditions hold there are
  hypotheses; host load was not varied.

## Recommendation

Do both, clone first:

1. Provision new iOS simulators from a settled template clone, one template per runtime and device type, kept
   shut down: minus 46 percent CPU-seconds, about 3 seconds to clone, plus the one-off template settle.
2. Apply a CPU-lean launchd profile before the first boot of every simulator AutoMobile creates or clones,
   and re-apply it per device id. The measured profiles are `catalog-cpu` (23 labels, minus 50 percent alone) and
   `cpu-plus` (45 labels, minus 61 percent alone). The smallest useful default is likely the shipped wallpaper
   rendering and widgets resources (minus 25 and 23 percent on their own, roughly minus 48 percent combined by
   addition, not measured together or alongside a clone); speech/Siri and the other `cpu-plus` daemons are an
   opt-in extra. Do not offer a disable-all preset.
3. Clone plus `catalog-cpu` or `cpu-plus` measured minus 69 and minus 72 percent CPU-seconds (789 to 245 and 222)
   with the basic driving surface intact. Time-to-quiet fell from 200 to 122 to 130 seconds (the first quiet
   60 second window), so boot gating stays, at roughly a third of the CPU cost and about 60 to 65 percent of
   the quiet time.

## Follow-up measurements (#15219)

Same method and harness as above, run on the code that landed from #15229 (preboot profile), #15236 (template clone),
#15230 (capacity gate) and #15228 (impact metadata). 65 sampled boots. Non-simulator host load during the windows
averaged 3.0 cores (1.5 to 6.8, higher than in #15097 because a CI runner and other lanes were building), so
absolute peaks are host-capped and the ratios between conditions are the result. A few 5-second peaks above 16 cores
are sampler catch-up rows, not real; the burst length is reported as seconds with at least 8 cores busy instead.

| condition                                                | runs | CPU-s in 600 s | vs baseline | time-to-quiet s | peak footprint MB | breakage      |
| -------------------------------------------------------- | ---- | -------------- | ----------- | --------------- | ----------------- | ------------- |
| baseline: create and boot                                | 3    | 775 (745-800)  | 0%          | 253 (225-270)   | 3170              | ok (4 checks) |
| clone of a settled plain template                        | 2    | 415 (396-433)  | -46%        | 120 (110-130)   | 2620              | ok (2 checks) |
| `PosterBoard` + `chronod`, pre-first-boot                | 2    | 447 (438-456)  | -42%        | 155             | 2033              | ok            |
| `minimal` (+ `liveactivitiesd`), pre-first-boot          | 4    | 442 (436-448)  | -43%        | 156 (155-160)   | 2012              | ok (4 of 4)   |
| `minimal` + speech/Siri daemons                          | 2    | 366 (357-376)  | -53%        | 140             | 1903              | 1 of 2 failed |
| clone + `PosterBoard` + `chronod`                        | 1    | 270            | -65%        | 105             | 1684              | ok            |
| clone + `minimal`                                        | 4    | 273 (258-283)  | -65%        | 127 (110-155)   | 1751              | 1 of 4 failed |
| `minimal` + `backgroundassets.user`                      | 2    | 429 (426-432)  | -45%        | 150             | 1998              | ok            |
| `minimal` + app-store, companion, watch, password-breach | 2    | 383 (372-393)  | -51%        | 148 (145-150)   | 1910              | ok            |
| `minimal` + `diagnosticd` (ceiling only, not safe)       | 1    | 475            | -39%        | 160             | 1969              | ok            |

One clone + `minimal` run never reached a quiet 60-second window inside 600 seconds because of a `pairedsyncd`
burst, not boot cost. Two of 23 breakage checks failed, with the same signature: the Safari address-bar tap timed
out while the runner was busy for 20 seconds, then the typing steps cascaded (one 45-minute-aged clone + `minimal` run,
one speech/Siri run). The other four aged runs (baseline, two `minimal`, a replicate clone + `minimal`) passed all 14
steps, and so did the four plain-baseline and two plain-clone checks (the 150-second control runs, shown in the baseline
and clone rows above as checks). Both failures were on lean-profile runs and none of the six plain checks failed, so the
failure could not be attributed to the profile, and it could not be cleared of it either; re-check it on the next
manual test before the clone default flips.

- `liveactivitiesd` costs nothing at first boot: `PosterBoard` + `chronod` alone measure the same as the shipped
  `minimal`. Posters and widgets together save 42 to 43 percent, not the 48 percent the single-family screens added up to.
- Speech/Siri takes another 17 percent off the `minimal` figure (442 to 366, 10 points against baseline) but removes
  Siri, dictation and App Intents; it stays opt-in.
- Unaddressed costs: the launchd clients of `STExtractionService`'s framework are `mobileassetd`, `nsurlsessiond` and
  `backgroundassets.user`. The first two are required for downloads and were not disabled; disabling the third made no
  difference, so whether the first two start the service was not tested, and only a clone removes it (0 CPU-seconds).
  `xpcproxy_sim` is the launch stub for about 300 services, not a service. `diagnosticd` should stay: session logs and
  `getLogs` use `simctl spawn ... log show`, and disabling `diagnosticd` made the first boot 7 percent worse (one run;
  the breakage check does not call `getLogs`, so the dependency itself was not exercised). A set of
  `backgroundassets.user`, `amsengagementd`, `nanotimekitcompaniond`, watch connectivity and `passwordbreachd` passed
  the driving surface and takes another 13 percent off the `minimal` figure (8 points against baseline): 59 CPU-seconds
  saved, of which `amsengagementd` is 21 and the unnamed "other" bucket about 30. It is a candidate for an opt-in
  resource, not a default.

### Idle drift

Seven 45-minute runs (two each for baseline, `minimal` and clone + `minimal`, one for a plain clone), mean CPU per
five-minute bin. After the first five to ten minutes the quiet bins sit at 3 to 7 percent of one core. In five of the
seven runs the mean over minutes 30 to 45 is higher than over minutes 5 to 30: bins of 8 to 15 percent appear from
minute 30 on, often two or three in a row, driven by different services run to run (`pairedsyncd` 10 to 38
CPU-seconds, `StreamingUnzipService`, `proactiveeventtrackerd`, `AuthenticationServicesAgent`). The mean from minute 15
to 45 was 6.8 and 6.1 (baseline), 6.7 (clone), 6.6 and 3.8 (`minimal`), 4.0 and 6.5 (clone + `minimal`). One `minimal`
run (3.6 percent over minutes 30 to 45) and one clone + `minimal` run (4.0) stayed flat, the other five did not, so
two runs per condition cannot show that `minimal` helps or hurts idle. What the data does show is that nothing
climbs steadily inside 45 minutes; whether it does over hours was not measured. `pairedsyncd` has no launchd plist in
the runtime and cannot be disabled by label. The capacity model's 0.055 core per settled simulator sits inside the
3.8 to 6.8 percent range of the 15 to 45 minute means.

### Concurrent first boots

All simulators started at the same instant, boot admission bypassed in the harness. CPU-seconds grow slightly faster than the
number of simulators (per simulator 775 single, 812 at four for baseline; 273 single, 286 at two and 312 at four for
clone + `minimal`), so the saving survives concurrency:

| condition         | sims | runs | total CPU-s      | per sim | seconds with >= 8 cores | all sims quiet (s) | last bootstatus (s) |
| ----------------- | ---- | ---- | ---------------- | ------- | ----------------------- | ------------------ | ------------------- |
| baseline          | 2    | 2    | 1551 (1550-1552) | 775     | 92                      | 380                | 27                  |
| clone + `minimal` | 2    | 2    | 572 (554-590)    | 286     | 22                      | 242 (155-330)      | 3.4                 |
| baseline          | 4    | 2    | 3250 (3205-3294) | 812     | 175                     | 515 (one never)    | 48.5                |
| clone + `minimal` | 4    | 2    | 1249 (1224-1274) | 312     | 50                      | 272 (245-300)      | 13.9                |

The peak stays at the host ceiling (about 14 cores) in every group; what changes is how long it lasts and how soon the
host is quiet again. Four simultaneous baseline boots did not settle inside 600 seconds in one of two runs. The
k=4 groups held four device slots, deliberately above the host-wide limit of two, while no other lane ran.

### Product path

A private daemon per configuration (own data, log, database, coordination and aux directories, explicit port, every
other device protected) provisioned simulators through `provisionDevice` with the two environment variables:

| configuration                                  | runs | CPU-s in 600 s | time-to-quiet s | `provisionDevice` call s |
| ---------------------------------------------- | ---- | -------------- | --------------- | ------------------------ |
| defaults (no profile, no clone)                | 2    | 710 (688-731)  | 168 (165-170)   | 21.1                     |
| `AUTOMOBILE_IOS_PREBOOT_LEAN_PROFILE=minimal`  | 2    | 445 (441-448)  | 158 (155-160)   | 19.1                     |
| `minimal` with `readiness=automation` (runner) | 1    | 524            | not reached     | 30.7                     |
| `AUTOMOBILE_IOS_TEMPLATE_CLONE=1` + `minimal`  | 2    | 247 (232-262)  | 125             | 11.6                     |

`launchctl print-disabled` inside each booted simulator listed all three `minimal` labels, none loaded, so the
preboot database was honored. The product `minimal` run matches the harness (445 against 442); the product control
(710) ran 8 percent below the harness baseline (775) for an unexplained reason, so the product figure of -37 percent for
`minimal` is the conservative one; clone + `minimal` is -65 percent in both. The product control also settled 85
seconds sooner than the harness baseline (168 against 253), so `minimal` saved only 10 seconds of time-to-quiet there,
and the last-120-second mean was 7.3 percent for product `minimal` against 3.8 for the product defaults (two runs
each, a `pairedsyncd`-style burst is the likely cause but was not isolated). The runner adds about 80
CPU-seconds. Two concurrent `provisionDevice` calls from one ready template both cloned in 2.7 seconds, booted
together and cost 504 CPU-seconds in total, quiet after 140 seconds.

The template was built with `auto-mobile --ios-templates build`. From boot to shutdown it took 762 seconds (461
CPU-seconds in the first 600): the 120-second window below 5 percent of a core restarts after every periodic burst,
so the real build is about 13 minutes, not the roughly 4.7 minutes implied by a 160-second time-to-quiet plus the 120-second
window, and it holds a boot slot for that time.

## Defaults (owner decision 2026-10-24)

- `AUTOMOBILE_IOS_PREBOOT_LEAN_PROFILE` defaults to `minimal`: minus 43 percent CPU-seconds in the harness (minus 37
  percent in the product path) and 100 seconds off the time-to-quiet in the harness (10 seconds in the product path),
  with no breakage cost attributable to it. Idle was not shown to differ (two drift runs per condition; the product
  last-120-second mean was higher with `minimal`, 7.3 against 3.8 percent, unexplained). `catalog-cpu` bought about
  7 more points in #15097 (minus 50 against a 789 baseline; not re-measured here) while removing Health, Apple
  Intelligence and search, and stays opt-in with speech/Siri.
- `AUTOMOBILE_IOS_TEMPLATE_CLONE` defaults on: a clone alone is minus 46 percent (harness only); clone + `minimal`
  is minus 65 percent in the harness and the product path, and minus 62 to 63 percent with two and four simultaneous
  boots, at about 3 seconds per clone. Costs: the first creation per runtime, device type and profile is a normal one,
  a background template build of about 13 minutes occupies a boot slot, and each template needs a disk copy. Re-check
  the aged-clone Safari tap on the next manual test first.
- Size boot concurrency by CPU-seconds: a first boot is about 775 CPU-seconds, 442 with `minimal`, 273 as a clone
  with `minimal`, and k simultaneous boots cost slightly more than k times that.
